import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { LiveDoc, type Report, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { projectChatView } from "../src/projection.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { SessionMetadataDoc } from "../src/session-metadata.ts";

async function until(test: () => Promise<boolean>) {
	for (let i = 0; i < 300; i++) {
		if (await test()) return;
		await sleep(20);
	}
	throw new Error("crash loop timeout");
}

/**
 * A session whose title task sleeps before its retry, closed normally. Returns the task id and a way to make that
 * task look like a crash cut it off `restarts` times: a close never counts, so the record is written directly.
 */
async function sleepingNamingTask(dir: string, faux: ReturnType<typeof fauxProvider>) {
	const options = {
		storagePath: join(dir, "db.sqlite"),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		timings: { namingRetryDelayMs: 600_000 },
	};
	const runtime = await createNekoRuntime({ ...options, credentials: new InMemoryCredentialStore() });
	await runtime.submit("name me");
	await until(
		async () => (await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))?.attempts === 1,
	);
	const taskId = (await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))!
		.namingTask as TaskId;
	// The invalid title has to land before the task's record is final.
	await until(async () => (await runtime.harness.getTask(taskId, runtime.context))?.state.status === "sleeping");
	const context = runtime.context;
	await runtime.close();
	const cutOff = async (restarts: number, until: number) => {
		const raw = await openNodeSqliteStorage(options.storagePath);
		const record = (await raw.task(taskId, context))!;
		const { memos: _memos, ...rest } = record;
		const running = { ...rest, restarts, state: { status: "running", checkpoint: { phase: "wait", until } } };
		await commitWrites(raw, [{ type: "task", value: running as never }], context);
		await raw.close(context);
	};
	const readTask = async () => {
		const raw = await openNodeSqliteStorage(options.storagePath);
		try {
			return await raw.task(taskId, context);
		} finally {
			await raw.close(context);
		}
	};
	return { options, taskId, cutOff, readTask };
}

it("ends a task a crash cut off five times, reports it once and keeps other sessions working", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-crash-loop-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("answer")]), fauxAssistantMessage([fauxText("   ")])]);
	const { options, taskId, cutOff } = await sleepingNamingTask(dir, faux);
	await cutOff(4, Date.now());
	const reports: Report[] = [];
	const runtime = await createNekoRuntime({
		...options,
		credentials: new InMemoryCredentialStore(),
		onReport: (_error, report) => {
			if (report) reports.push(report);
		},
	});
	try {
		await until(async () => reports.length > 0);
		await sleep(300);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ kind: "task_faulted", reason: "restart_limit" });
		const task = await runtime.harness.getTask(taskId, runtime.context);
		expect(task?.state.status).toBe("terminal");
		// The ended work does not run again: no further title request was made.
		expect(faux.state.callCount).toBe(2);
		faux.appendResponses([fauxAssistantMessage([fauxText("still works")])]);
		const answer = await runtime.waitAnswer(await runtime.submit("another question"));
		expect(answer).toEqual({ status: "done", text: "still works" });
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("restarts a task cut off fewer times than the limit and clears the count once it commits a new state", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-crash-reset-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("answer")]), fauxAssistantMessage([fauxText("   ")])]);
	const { options, taskId, cutOff, readTask } = await sleepingNamingTask(dir, faux);
	await cutOff(2, Date.now());
	faux.appendResponses([fauxAssistantMessage([fauxText("Counted title")])]);
	const reports: unknown[] = [];
	const runtime = await createNekoRuntime({
		...options,
		credentials: new InMemoryCredentialStore(),
		onReport: (error) => reports.push(error),
	});
	try {
		await until(async () => (await runtime.listConversations())[0]?.title === "Counted title");
		await until(async () => (await runtime.harness.getTask(taskId, runtime.context))?.state.status === "terminal");
		expect(reports).toEqual([]);
		expect((await runtime.harness.getTask(taskId, runtime.context))?.restarts).toBeUndefined();
	} finally {
		await runtime.close();
	}
	expect((await readTask())?.restarts).toBeUndefined();
	await rm(dir, { recursive: true, force: true });
}, 30_000);

it("ends a run whose generation a crash cut off five times with a visible restart_limit failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-crash-run-"));
	const faux = fauxProvider();
	// Only "again" is answered; anything else waits until aborted, so the run is in flight when the host closes.
	const respond: FauxResponseFactory = (context, options) =>
		JSON.stringify(context).includes("again")
			? fauxAssistantMessage([fauxText("still works")])
			: new Promise<never>((_resolve, reject) =>
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				);
	faux.setResponses(Array.from({ length: 20 }, () => respond));
	const options = {
		storagePath: join(dir, "db.sqlite"),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	};
	const first = await createNekoRuntime({ ...options, credentials: new InMemoryCredentialStore() });
	await first.submit("hang");
	let taskId: TaskId | undefined;
	await until(async () => {
		taskId = (await first.harness.snapshot(LiveDoc, first.root.id, first.context))?.run?.taskId;
		return taskId !== undefined && (await first.harness.getTask(taskId, first.context))?.state.status === "running";
	});
	const context = first.context;
	await first.close();
	const raw = await openNodeSqliteStorage(options.storagePath);
	const record = (await raw.task(taskId!, context))!;
	// A close leaves the task pending; a crash would have left it running.
	const { memos: _memos, ...rest } = record;
	const crashed = { ...rest, restarts: 4, state: { ...record.state, status: "running" } };
	await commitWrites(raw, [{ type: "task", value: crashed as never }], context);
	await raw.close(context);
	const reports: Report[] = [];
	const runtime = await createNekoRuntime({
		...options,
		credentials: new InMemoryCredentialStore(),
		onReport: (_error, report) => {
			if (report) reports.push(report);
		},
	});
	try {
		await until(
			async () => (await runtime.harness.snapshot(LiveDoc, runtime.root.id, runtime.context))?.run === undefined,
		);
		const live = await runtime.harness.snapshot(LiveDoc, runtime.root.id, runtime.context);
		expect(live?.runFailure?.reason).toBe("restart_limit");
		const follower = await runtime.follow();
		expect(projectChatView(follower.value, "faux/faux-1").runFailure?.reason).toBe("restart_limit");
		follower.dispose();
		expect(reports.filter((r) => r.kind === "task_interrupted")).toHaveLength(1);
		expect(await runtime.waitAnswer(await runtime.submit("again"))).toEqual({ status: "done", text: "still works" });
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);
