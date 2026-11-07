import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime, projectChatView, QUEUED_PREVIEW_CHARS } from "../src/index.ts";

const dirs: string[] = [];
const directory = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-queue-")));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

const gate = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

async function setup() {
	const started = gate();
	const release = gate();
	const workspace = directory();
	const skillDir = join(workspace, ".agents", "skills", "pdf");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: Read PDFs\n---\nPDF body");
	const contexts: TranscriptContext[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		(context: TranscriptContext) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("gate", {}, { id: "gate-1" })], { stopReason: "toolUse" });
		},
		...Array.from({ length: 10 }, () => (context: TranscriptContext) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("ok")]);
		}),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		cwd: workspace,
		promptHome: directory(),
		extensions: [
			defineExtension({
				name: "queue-gate",
				tools: [
					defineTool({
						name: "gate",
						description: "Hold the run",
						parameters: obj({}, { open: true }),
						execute: async () => {
							started.resolve();
							await release.promise;
							return { output: [{ type: "text" as const, text: "done" }] };
						},
					}),
				],
			}),
		],
	});
	const view = async () => {
		const state = await runtime.follow();
		try {
			return projectChatView(state.value, "test");
		} finally {
			state.dispose();
		}
	};
	return { runtime, started, release, view, contexts };
}

it("shows queued user inputs in order and drops them once placed", async () => {
	const { runtime, started, release, view } = await setup();
	try {
		const first = await runtime.submit("first");
		await started.promise;
		expect((await view()).queued).toEqual([]);
		const steer = await runtime.submit("steer me", { whenBusy: "steer" });
		const follow = await runtime.submit("follow up");
		const queued = (await view()).queued!;
		expect(queued.map((q) => [q.mode, q.preview, q.images])).toEqual([
			["steer", "steer me", 0],
			["followUp", "follow up", 0],
		]);
		expect(queued.map((q) => q.id)).toEqual([steer.id, follow.id]);
		release.resolve();
		for (const s of [first, steer, follow]) expect((await runtime.waitAnswer(s)).status).toBe("done");
		const done = await view();
		expect(done.queued).toEqual([]);
		expect(done.items.filter((i) => i.type === "user").map((i) => (i.type === "user" ? i.text : ""))).toEqual([
			"first",
			"steer me",
			"follow up",
		]);
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("leaves idle submissions, long previews and skills in the right shape", async () => {
	const { runtime, started, release, view } = await setup();
	try {
		await runtime.submit("go");
		await started.promise;
		await runtime.submit(`${"x".repeat(QUEUED_PREVIEW_CHARS + 50)}`);
		await runtime.submit("/skill:pdf summarize");
		const queued = (await view()).queued!;
		expect([...queued[0]!.preview].length).toBe(QUEUED_PREVIEW_CHARS);
		expect(queued[0]!.preview.endsWith("…")).toBe(true);
		expect(queued[1]).toMatchObject({
			preview: "/skill:pdf summarize",
			skill: { name: "pdf", args: "summarize" },
		});
		expect(JSON.stringify(queued)).not.toContain("PDF body");
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("withdraws one queued input without touching the run or the others", async () => {
	const { runtime, started, release, view, contexts } = await setup();
	try {
		const first = await runtime.submit("first");
		await started.promise;
		const drop = await runtime.submit("drop me");
		const keep = await runtime.submit("keep me");
		expect(await runtime.root.withdraw(drop.id)).toEqual({ result: "withdrawn", text: "drop me", images: 0 });
		expect((await view()).queued!.map((q) => q.preview)).toEqual(["keep me"]);
		expect((await view()).busy).toBe(true);
		expect((await runtime.root.withdraw(drop.id)).result).not.toBe("withdrawn");
		release.resolve();
		expect((await runtime.waitAnswer(first)).status).toBe("done");
		expect((await runtime.waitAnswer(keep)).status).toBe("done");
		const users = (await view()).items.flatMap((i) => (i.type === "user" ? [i.text] : []));
		expect(users).toEqual(["first", "keep me"]);
		expect(JSON.stringify(contexts.map((c) => c.messages))).not.toContain("drop me");
		expect((await runtime.listConversations())[0]!.firstPromptPreview).not.toContain("drop me");
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("reports placed and unknown withdrawals", async () => {
	const { runtime, started, release } = await setup();
	try {
		const first = await runtime.submit("first");
		await started.promise;
		expect((await runtime.root.withdraw(first.id)).result).toBe("placed");
		expect((await runtime.root.withdraw(999_999)).result).toBe("unknown");
		release.resolve();
		expect((await runtime.waitAnswer(first)).status).toBe("done");
		expect((await runtime.root.withdraw(first.id)).result).toBe("settled");
		const other = await runtime.createConversation();
		const queuedHere = (await runtime.submit("again")).id;
		expect((await other.withdraw(queuedHere)).result).toBe("unknown");
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("withdraws every queued input on stop", async () => {
	const { runtime, started, release, view } = await setup();
	try {
		const first = await runtime.submit("first");
		await started.promise;
		await runtime.submit("one");
		await runtime.submit("two");
		expect((await view()).queued).toHaveLength(2);
		release.resolve();
		await runtime.root.abort();
		expect((await view()).queued).toEqual([]);
		await runtime.waitAnswer(first);
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("keeps system inputs out of the queue list and refuses to withdraw them", async () => {
	const { runtime, started, release, view } = await setup();
	try {
		await runtime.submit("first");
		await started.promise;
		const report = await runtime.conversation.submit(
			{
				type: "input",
				content: "job finished",
				whenBusy: "followUp",
				entry: {
					kind: "app.neko.input",
					data: { at: 1, prompt: "job finished", images: [], jobReport: { jobId: "j1", status: "done", exitCode: 0 } },
				},
			},
			runtime.context,
		);
		expect((await view()).queued).toEqual([]);
		expect((await runtime.root.withdraw(report.id)).result).toBe("unknown");
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("restores the queued list after a restart", async () => {
	const dir = directory();
	const faux = fauxProvider({ models: [{ id: "m" }] });
	const holdUntilAbort = async (_context: TranscriptContext, options?: { signal?: AbortSignal }) => {
		await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
		return fauxAssistantMessage([fauxText("stopped")]);
	};
	let started!: () => void;
	const active = new Promise<void>((resolve) => {
		started = resolve;
	});
	faux.setResponses([
		async (context, options) => {
			started();
			return holdUntilAbort(context, options);
		},
	]);
	const options = {
		storagePath: join(dir, "history.sqlite"),
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "m" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		await runtime.submit("busy");
		await active;
		await runtime.submit("queued one");
		await runtime.close();
		faux.setResponses([holdUntilAbort]);
		runtime = await createNekoRuntime(options);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const state = await runtime.follow();
		const view = projectChatView(state.value, "test");
		state.dispose();
		expect(view.queued?.map((q) => q.preview)).toEqual(["queued one"]);
		expect(view.items.filter((i) => i.type === "user")).toHaveLength(1);
	} finally {
		await runtime.close();
	}
}, 30_000);

const userTextsOf = (context: TranscriptContext) =>
	context.messages.flatMap((m) =>
		m.role === "user"
			? [typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")]
			: [],
	);

it("turns a queued input into a steer that joins the running work before the other queued ones", async () => {
	const { runtime, started, release, view, contexts } = await setup();
	try {
		const first = await runtime.submit("first");
		await started.promise;
		const later = await runtime.submit("later");
		const other = await runtime.submit("other");
		const outcome = await runtime.root.steer(later.id);
		expect(outcome.result).toBe("steered");
		expect(outcome.id).not.toBe(later.id);
		const queued = (await view()).queued!;
		expect(queued.map((q) => [q.mode, q.preview])).toEqual([
			["followUp", "other"],
			["steer", "later"],
		]);
		expect(queued[0]!.id).toBe(other.id);
		expect(queued[1]!.id).toBe(outcome.id!);
		expect((await view()).busy).toBe(true);
		// Steering again is a no-op that keeps the id; the old id is gone.
		expect(await runtime.root.steer(outcome.id!)).toEqual({ result: "steered", id: outcome.id! });
		expect((await runtime.root.steer(later.id)).result).toBe("settled");

		release.resolve();
		expect((await runtime.waitAnswer(first)).status).toBe("done");
		await runtime.waitAnswer(other);
		expect(userTextsOf(contexts[1]!)).toEqual(["first", "later"]);
		const users = (await view()).items.flatMap((i) => (i.type === "user" ? [i.text] : []));
		expect(users).toEqual(["first", "later", "other"]);
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("keeps the skill expansion when a queued skill input is steered", async () => {
	const { runtime, started, release, view, contexts } = await setup();
	try {
		const first = await runtime.submit("first");
		await started.promise;
		const skill = await runtime.submit("/skill:pdf summarize");
		const outcome = await runtime.root.steer(skill.id);
		expect(outcome.result).toBe("steered");
		expect((await view()).queued![0]).toMatchObject({ mode: "steer", skill: { name: "pdf", args: "summarize" } });
		release.resolve();
		await runtime.waitAnswer(first);
		await runtime.waitAnswer((await runtime.harness.submission(outcome.id as never, runtime.context))!);
		expect(userTextsOf(contexts[1]!).at(-1)).toContain("PDF body");
		expect(userTextsOf(contexts[1]!).at(-1)).toContain("summarize");
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);

it("reports placed, settled and unknown when steering and refuses system inputs", async () => {
	const { runtime, started, release } = await setup();
	try {
		const first = await runtime.submit("first");
		await started.promise;
		expect((await runtime.root.steer(first.id)).result).toBe("placed");
		expect((await runtime.root.steer(999_999)).result).toBe("unknown");
		const report = await runtime.conversation.submit(
			{
				type: "input",
				content: "job finished",
				whenBusy: "followUp",
				entry: {
					kind: "app.neko.input",
					data: { at: 1, prompt: "job finished", images: [], jobReport: { jobId: "j1", status: "done", exitCode: 0 } },
				},
			},
			runtime.context,
		);
		expect((await runtime.root.steer(report.id)).result).toBe("unknown");
		release.resolve();
		await runtime.waitAnswer(first);
		expect((await runtime.root.steer(first.id)).result).toBe("settled");
		const other = await runtime.createConversation();
		expect((await other.steer(first.id)).result).toBe("unknown");
	} finally {
		release.resolve();
		await runtime.close();
	}
}, 30_000);
