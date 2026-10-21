import { expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { NekoInput } from "../src/input.ts";
import { JOB_LIMITS } from "../src/jobs.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";
import { listDelegations } from "../src/subagents.ts";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** Forward slashes so Git Bash does not treat a quoted Windows path as literal backslashes. */
const shellPath = (value: string) => quoteShell(value.replaceAll("\\", "/"));
/** A shell command that prints the OS pid of a grandchild, then waits.
 * Git Bash's `$!` is an MSYS pid, so `process.kill` cannot see that process on Windows.
 */
const hangingTreeCommand = (): string => {
	const script = [
		'const {spawn}=require("node:child_process");',
		'const child=spawn(process.execPath,["-e","setInterval(()=>{},1e9)"],{stdio:"ignore"});',
		'process.stdout.write(String(child.pid)+"\\n");',
		"setInterval(()=>{},1e9)",
	].join("");
	return `${shellPath(process.execPath)} -e ${quoteShell(script)}`;
};
const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out");
};
const call = (...inputs: Parameters<typeof fauxToolCall>[1][]) =>
	fauxAssistantMessage(
		inputs.map((input) => fauxToolCall("job", input)),
		{ stopReason: "toolUse" },
	);
const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

async function open(dir: string, responses: ReturnType<typeof fauxAssistantMessage>[], tokensPerSecond?: number) {
	const faux = fauxProvider(tokensPerSecond ? { tokensPerSecond } : undefined);
	faux.setResponses(responses);
	return createNekoRuntime({
		storagePath: join(dir, "db.sqlite"),
		cwd: dir,
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		timings: { jobStartWindowMs: 500 },
	});
}

const entries = async (runtime: NekoRuntime) =>
	(await runtime.root.conversation.entries({}, 200, undefined, runtime.context)).items;
const jobReportOf = (entry: { data?: unknown }) => (entry.data as { jobReport?: unknown } | undefined)?.jobReport;
const reports = async (runtime: NekoRuntime) =>
	(await entries(runtime)).filter((entry) => entry.kind === NekoInput.kind && jobReportOf(entry));
const toolTexts = async (runtime: NekoRuntime) =>
	(await entries(runtime))
		.filter((entry) => entry.model?.[0]?.role === "toolResult")
		.map((entry) => JSON.stringify(entry.model![0]));

async function withDir<T>(fn: (dir: string) => Promise<T>) {
	const dir = await mkdtemp(join(tmpdir(), "neko-jobs-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

it("returns an early exit directly and produces no report", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [call({ action: "start", command: "echo hello; exit 3" }), answer("saw it")]);
		try {
			expect(await runtime.waitAnswer(await runtime.submit("go"))).toEqual({ status: "done", text: "saw it" });
			const [job] = await runtime.root.jobs();
			expect(job).toMatchObject({ jobId: "job-1", status: "failed", exitCode: 3, command: "echo hello; exit 3" });
			expect((await toolTexts(runtime))[0]).toContain("hello");
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(await reports(runtime)).toHaveLength(0);
			expect(await runtime.root.jobOutput("job-1")).toMatchObject({ output: { text: "hello\n" } });
		} finally {
			await runtime.close();
		}
	}));

it("marks a zero exit exited and a timeout failed with its reason", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [
			call({ action: "start", command: "echo ok" }, { action: "start", command: "sleep 30", timeout: 1 }),
			answer("done"),
		]);
		try {
			await runtime.waitAnswer(await runtime.submit("go"));
			await until(async () => (await runtime.root.jobs()).find((j) => j.jobId === "job-2")?.status === "failed");
			const jobs = await runtime.root.jobs();
			expect(jobs.find((j) => j.jobId === "job-1")).toMatchObject({ status: "exited", exitCode: 0 });
			expect(jobs.find((j) => j.jobId === "job-2")).toMatchObject({ status: "failed", reason: "timeout" });
		} finally {
			await runtime.close();
		}
	}));

it("rejects invalid arguments without starting a process", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [
			call(
				{ action: "start" },
				{ action: "start", command: "echo x", timeout: -1 },
				{ action: "stop" },
				{ action: "output", jobId: "job-9" },
				{ action: "stop", jobId: "job-9" },
			),
			answer("done"),
		]);
		try {
			await runtime.waitAnswer(await runtime.submit("go"));
			expect(await runtime.root.jobs()).toEqual([]);
			const text = (await toolTexts(runtime)).join("\n");
			expect(text).toContain("command must be a nonempty string");
			expect(text).toContain("timeout must be a positive number");
			expect(text).toContain("jobId must be a nonempty string");
			expect(text).toContain("Unknown job job-9");
		} finally {
			await runtime.close();
		}
	}));

it("returns immediately for a long-running job, reports a user stop, and kills the process tree", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [
			call({ action: "start", command: hangingTreeCommand(), title: "server" }),
			answer("running"),
			answer("noted stop"),
		]);
		let child = 0;
		try {
			const started = Date.now();
			expect(await runtime.waitAnswer(await runtime.submit("go"))).toEqual({ status: "done", text: "running" });
			expect(Date.now() - started).toBeLessThan(JOB_LIMITS.startWindowMs + 3000);
			const [job] = await runtime.root.jobs();
			expect(job).toMatchObject({ status: "running", title: "server" });
			child = Number.parseInt((await runtime.root.jobOutput("job-1")).output.text.trim(), 10);
			expect(alive(child)).toBe(true);

			const stopped = await runtime.root.stopJob("job-1");
			expect(stopped.status).toBe("stopped");
			await until(() => !alive(child));
			// A user stop is reported and opens a new turn.
			await until(async () => (await reports(runtime)).length === 1);
			expect(jobReportOf((await reports(runtime))[0]!)).toMatchObject({ jobId: "job-1", status: "stopped" });
			// Stopping again returns the ended state and kills nothing.
			expect((await runtime.root.stopJob("job-1")).status).toBe("stopped");
			await expect(runtime.root.stopJob("job-404")).rejects.toThrow("Unknown job");
		} finally {
			if (child && alive(child)) process.kill(child, "SIGKILL");
			await runtime.close();
		}
	}));

it("keeps a terminal state immutable when stop races with exit", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [call({ action: "start", command: "sleep 300" }), answer("ok"), answer("noted")]);
		try {
			await runtime.waitAnswer(await runtime.submit("go"));
			const results = await Promise.all([runtime.root.stopJob("job-1"), runtime.root.stopJob("job-1")]);
			expect(results.map((r) => r.status)).toEqual(["stopped", "stopped"]);
			await until(async () => (await reports(runtime)).length === 1);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(await reports(runtime)).toHaveLength(1);
		} finally {
			await runtime.close();
		}
	}));

it("does not report a model-initiated stop", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [
			call({ action: "start", command: "sleep 300" }),
			call({ action: "stop", jobId: "job-1" }),
			answer("stopped it"),
		]);
		try {
			await runtime.waitAnswer(await runtime.submit("go"));
			expect((await runtime.root.jobs())[0]).toMatchObject({ status: "stopped" });
			await new Promise((resolve) => setTimeout(resolve, 400));
			expect(await reports(runtime)).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	}));

it(
	"reports a job that ends on its own after the start window, queued behind a busy answer",
	() =>
		withDir(async (dir) => {
			const runtime = await open(
				dir,
				[
					call({ action: "start", command: "sleep 1.5; echo boom; exit 2" }),
					answer(`${"waiting ".repeat(40)}`),
					answer("handled the report"),
				],
				40,
			);
			try {
				const first = await runtime.submit("go");
				await until(async () => (await runtime.root.jobs())[0]?.status === "failed", 20000);
				expect(await runtime.waitAnswer(first)).toMatchObject({ status: "done" });
				await until(async () => (await reports(runtime)).length === 1);
				await until(async () =>
					(await entries(runtime)).some((e) => JSON.stringify(e.model?.[0] ?? "").includes("handled the report")),
				);
				const list = await entries(runtime);
				const report = list.find((e) => e.kind === NekoInput.kind && jobReportOf(e))!;
				expect(jobReportOf(report)).toEqual({ jobId: "job-1", status: "failed", exitCode: 2 });
				expect(JSON.stringify(report)).toContain("boom");
				const answers = list.filter((e) => e.model?.[0]?.role === "assistant").map((e) => JSON.stringify(e.model![0]));
				expect(answers.some((a) => a.includes("handled the report"))).toBe(true);
			} finally {
				await runtime.close();
			}
		}),
	40000,
);

it(
	"limits running jobs and lists only the newest terminal ones",
	() =>
		withDir(async (dir) => {
			const starts = Array.from({ length: 5 }, () => ({ action: "start", command: "sleep 300" }));
			const runtime = await open(dir, [call(...starts), answer("done")]);
			try {
				await runtime.waitAnswer(await runtime.submit("go"));
				const jobs = await runtime.root.jobs();
				expect(jobs.filter((j) => j.status === "running")).toHaveLength(JOB_LIMITS.maxRunning);
				expect((await toolTexts(runtime)).join("\n")).toContain("Too many running jobs");
			} finally {
				await runtime.close();
			}
		}),
	40000,
);

it(
	"settles a running job as lost after a restart, reports it once and never re-runs it",
	() =>
		withDir(async (dir) => {
			const counter = join(dir, "runs");
			const first = await open(dir, [
				call({ action: "start", command: `echo run >> ${shellPath(counter)}; sleep 300` }),
				answer("started"),
			]);
			await first.waitAnswer(await first.submit("go"));
			expect((await first.root.jobs())[0]!.status).toBe("running");
			await first.close();

			const second = await open(dir, [answer("saw lost")]);
			try {
				await until(async () => (await second.root.jobs())[0]?.status === "lost");
				await until(async () => (await reports(second)).length === 1);
				expect(jobReportOf((await reports(second))[0]!)).toMatchObject({ jobId: "job-1", status: "lost" });
				expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
			} finally {
				await second.close();
			}
			const third = await open(dir, []);
			try {
				await new Promise((resolve) => setTimeout(resolve, 400));
				expect(await reports(third)).toHaveLength(1);
				expect((await third.root.jobs())[0]!.status).toBe("lost");
			} finally {
				await third.close();
			}
		}),
	40000,
);

it("kills running processes on close without leaving orphans", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [call({ action: "start", command: hangingTreeCommand() }), answer("ok")]);
		await runtime.waitAnswer(await runtime.submit("go"));
		const child = Number.parseInt((await runtime.root.jobOutput("job-1")).output.text.trim(), 10);
		expect(alive(child)).toBe(true);
		try {
			await runtime.close();
			await until(() => !alive(child));
		} finally {
			if (alive(child)) process.kill(child, "SIGKILL");
		}
	}));

it("stops a conversation's running jobs when it is archived, without a report", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [call({ action: "start", command: hangingTreeCommand() }), answer("ok")]);
		let child = 0;
		try {
			const session = await runtime.createConversation();
			await session.waitAnswer(await session.submit("go"));
			child = Number.parseInt((await session.jobOutput("job-1")).output.text.trim(), 10);
			expect(alive(child)).toBe(true);
			await runtime.archiveConversation(session.id);
			await until(() => !alive(child));
			const after = await runtime.getConversation(session.id);
			expect(after).toBeUndefined();
			expect(await runtime.root.jobs()).toEqual([]);
		} finally {
			if (child && alive(child)) process.kill(child, "SIGKILL");
			await runtime.close();
		}
	}));

it("forks a conversation without its running jobs", () =>
	withDir(async (dir) => {
		const runtime = await open(dir, [call({ action: "start", command: "sleep 300" }), answer("ok")]);
		try {
			await runtime.waitAnswer(await runtime.submit("go"));
			expect((await runtime.root.jobs()).map((j) => j.status)).toEqual(["running"]);
			const fork = await runtime.forkConversation(runtime.root.id);
			expect(await fork.jobs()).toEqual([]);
			expect((await runtime.root.jobs()).map((j) => j.status)).toEqual(["running"]);
		} finally {
			await runtime.close();
		}
	}));

it(
	"keeps the job tool away from every subagent role",
	() =>
		withDir(async (dir) => {
			const runtime = await open(dir, [
				fauxAssistantMessage(
					[
						fauxToolCall("subagent", { type: "explore", title: "A", task: "look" }),
						fauxToolCall("subagent", { type: "plan", title: "B", task: "plan" }),
						fauxToolCall("subagent", { type: "coder", title: "C", task: "code" }),
					],
					{ stopReason: "toolUse" },
				),
				answer("r1"),
				answer("r2"),
				answer("r3"),
				answer("integrated"),
			]);
			try {
				expect(await runtime.waitAnswer(await runtime.submit("delegate"))).toMatchObject({ status: "done" });
				const parent = await runtime.root.conversation.agent(runtime.context);
				expect(parent.tools.map((tool) => tool.name)).toContain("job");
				const records = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
				expect(records.map((r) => r.role).sort()).toEqual(["coder", "explore", "plan"]);
				for (const record of records) {
					const child = await runtime.harness.conversation(record.childId as never, runtime.context);
					const names = (await child!.agent(runtime.context)).tools.map((tool) => tool.name);
					expect(names).not.toContain("job");
					expect(names).not.toContain("subagent");
				}
			} finally {
				await runtime.close();
			}
		}),
	30000,
);
