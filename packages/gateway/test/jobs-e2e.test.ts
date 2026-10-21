import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, IS_WINDOWS, testSocketPath, waitFor } from "./helpers.ts";

const start = (...jobs: { command: string; title: string }[]) =>
	fauxAssistantMessage(
		jobs.map((job) => fauxToolCall("job", { action: "start", ...job })),
		{ stopReason: "toolUse" },
	);
const text = (value: string) => fauxAssistantMessage([fauxText(value)]);

/** Marker values are unique sleep durations, so `ps` can tell exactly which of our processes are alive. */
const alive = (marker: string): boolean =>
	execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })
		.split("\n")
		.some((line) => line.includes(`sleep ${marker}`));

it.skipIf(IS_WINDOWS)(
	"runs a background service through chat, crash report, gateway restart and archive without leaving processes",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "neko-jobs-e2e-"));
		const storagePath = join(dir, "data.sqlite");
		const serverId = randomUUID();
		const counter = join(dir, "runs");
		const open = async (responses: ReturnType<typeof text>[]) => {
			const faux = fauxProvider();
			faux.setResponses(responses);
			const gateway = await startGateway({
				storagePath,
				socketPath: testSocketPath(dir),
				port: 0,
				serverId,
				cwd: dir,
				model: { provider: "faux", modelId: "faux-1" },
				providers: [faux.provider],
				timings: { jobStartWindowMs: 500 },
			});
			const client = await connectTestClient(gateway);
			return { gateway, client };
		};
		const items = (chat: { view: { value?: { items: readonly { type: string; text?: string }[] } } }) =>
			chat.view.value?.items ?? [];

		const first = await open([
			start(
				{ command: `echo run >> '${counter}'; sleep 3101`, title: "service" },
				{ command: "sleep 2; echo boom; exit 2", title: "crasher" },
			),
			text("started both"),
			text("service is up"),
			text("saw the crash"),
		]);
		let sessionId = "";
		try {
			const session = await first.client.management.create({});
			sessionId = session.id;
			const chat = await first.client.attach(sessionId);
			await chat.submit({ content: "start the stack" });
			await waitFor(() => items(chat).some((item) => item.text === "started both"), "services started");
			expect(chat.view.value?.jobs?.map((job) => job.status)).toEqual(["running", "running"]);
			expect(alive("3101")).toBe(true);

			// The conversation continues while the services run.
			await chat.submit({ content: "is it up?" });
			await waitFor(() => items(chat).some((item) => item.text === "service is up"), "chat during jobs");

			// The crash is reported and triggers a new turn.
			await waitFor(() => items(chat).some((item) => item.text === "saw the crash"), "crash report turn", 30_000);
			const report = chat.view.value!.items.find((item) => item.type === "system" && "jobId" in item);
			expect(report).toMatchObject({ jobId: "job-2" });
			expect(JSON.stringify(report)).toContain("boom");
			expect(chat.view.value?.jobs?.map((job) => [job.jobId, job.status])).toEqual([
				["job-1", "running"],
				["job-2", "failed"],
			]);
			await first.client.detach();
		} finally {
			await first.client.close();
			await first.gateway.close();
		}
		expect(alive("3101")).toBe(false);

		// After a restart the running job is lost, reported once and never re-run.
		const second = await open([
			text("saw lost"),
			start({ command: "sleep 3102", title: "again" }),
			text("started again"),
		]);
		try {
			const chat = await second.client.attach(sessionId);
			await waitFor(() => items(chat).some((item) => item.text === "saw lost"), "lost report turn", 30_000);
			expect(chat.view.value?.jobs?.find((job) => job.jobId === "job-1")?.status).toBe("lost");
			const reports = chat.view.value!.items.filter((item) => item.type === "system" && "jobId" in item);
			expect(reports.filter((item) => (item as { jobId?: string }).jobId === "job-1")).toHaveLength(1);
			expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
			expect(alive("3101")).toBe(false);

			// Archiving stops a running job without leaving a process behind.
			await chat.submit({ content: "once more" });
			await waitFor(() => items(chat).some((item) => item.text === "started again"), "second start");
			expect(alive("3102")).toBe(true);
			await second.client.detach();
			await second.client.management.archive(sessionId);
			await waitFor(() => !alive("3102"), "archive stopped the job");
		} finally {
			await second.client.close();
			await second.gateway.close();
			await rm(dir, { recursive: true, force: true });
		}
		expect(alive("3102")).toBe(false);
	},
	90_000,
);
