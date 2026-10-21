import { expect, it } from "bun:test";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";

import { createNekoRuntime } from "../src/runtime.ts";

it("uses native compaction, distinguishes no-op and applied, preserves recency", async () => {
	const faux = fauxProvider({ models: [{ id: "compact", contextWindow: 1000000 }] });
	faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage([fauxText("Summary or answer")])));
	const runtime = await createNekoRuntime({
		storage: "memory",
		model: { provider: "faux", modelId: "compact" },
		providers: [faux.provider],
	});
	const result = async (phase: string) => {
		for (let i = 0; i < 200; i++) {
			const latest = await runtime.root.compactionRecord();
			if (latest?.phase === phase) return latest;
			await Bun.sleep(10);
		}
		throw new Error(`No ${phase} result`);
	};
	try {
		await runtime.root.compact();
		await result("nothing");
		await runtime.waitAnswer(await runtime.submit(`first ${"a".repeat(90000)}`));
		await runtime.waitAnswer(await runtime.submit(`second ${"b".repeat(90000)}`));
		const before = (await runtime.listConversations())[0]!;
		await Promise.all([runtime.root.compact("Keep the task"), runtime.root.compact("Keep the task")]);
		await result("applied");
		expect((await runtime.listConversations())[0]!.lastMessageAt).toBe(before.lastMessageAt);
		expect((await runtime.root.conversation.context(runtime.context)).head?.kind).toBe("pi.compaction");
	} finally {
		await runtime.close();
	}
}, 15000);

it("keeps the system baseline ahead of the conversation after compaction without touching recency", async () => {
	const requests: string[][] = [];
	const record: FauxResponseFactory = (context) => {
		requests.push(context.messages.map((message) => message.role));
		return fauxAssistantMessage([fauxText("ok")]);
	};
	const faux = fauxProvider({ models: [{ id: "compact", contextWindow: 1000000 }] });
	faux.setResponses(Array.from({ length: 12 }, () => record));
	const runtime = await createNekoRuntime({
		storage: "memory",
		model: { provider: "faux", modelId: "compact" },
		providers: [faux.provider],
	});
	try {
		await runtime.waitAnswer(await runtime.submit(`first ${"a".repeat(90000)}`));
		await runtime.waitAnswer(await runtime.submit(`second ${"b".repeat(90000)}`));
		const before = (await runtime.listConversations())[0]!;
		await runtime.root.compact("Keep the task");
		for (let i = 0; i < 200 && (await runtime.root.compactionRecord())?.phase !== "applied"; i++) await Bun.sleep(10);
		expect((await runtime.root.compactionRecord())?.phase).toBe("applied");
		expect((await runtime.listConversations())[0]!.lastMessageAt).toBe(before.lastMessageAt);
		await runtime.waitAnswer(await runtime.submit("third"));
		const after = requests.at(-1)!;
		expect(after.filter((role) => role === "system")).toHaveLength(1);
		expect(after[0]).toBe("system");
		expect(after.slice(1).includes("system")).toBe(false);
	} finally {
		await runtime.close();
	}
}, 20000);

for (const [label, extra, expectedBlocking] of [
	["background", 40000, false],
	["blocking", 300000, true],
] as const) {
	it(`keeps native ${label} thresholds`, async () => {
		const faux = fauxProvider({ models: [{ id: "threshold", contextWindow: 100000 }] });
		faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("ok")])));
		const runtime = await createNekoRuntime({
			storage: "memory",
			model: { provider: "faux", modelId: "threshold" },
			providers: [faux.provider],
		});
		const states: { blocking: boolean; reason: string }[] = [];
		const stop = runtime.harness.subscribeCommits(({ changes }) => {
			for (const c of changes)
				if (c.type === "document" && c.record.kind === "pi.live")
					for (const status of (c.value?.compactions ?? []) as { blocking: boolean; reason: string }[])
						states.push(status);
		});
		try {
			await runtime.waitAnswer(await runtime.submit("a".repeat(80000)));
			await runtime.waitAnswer(await runtime.submit("b".repeat(80000)));
			await runtime.waitAnswer(await runtime.submit("c".repeat(extra)));
			expect(states.some((s) => s.reason === "threshold" && s.blocking === expectedBlocking)).toBe(true);
		} finally {
			stop();
			await runtime.close();
		}
	}, 15000);
}

async function untilPhase(runtime: Awaited<ReturnType<typeof createNekoRuntime>>, phase: string) {
	for (let n = 0; n < 600; n++) {
		if ((await runtime.root.compactionRecord())?.phase === phase) return;
		await Bun.sleep(10);
	}
	throw new Error(`Missing phase ${phase}`);
}
for (const mode of ["failure", "cancel", "retry", "overflow"] as const) {
	it(`projects native ${mode} without changing policy`, async () => {
		const faux = fauxProvider({ models: [{ id: "compact", contextWindow: 1000000 }] });
		const runtime = await createNekoRuntime({
			storage: "memory",
			model: { provider: "faux", modelId: "compact" },
			providers: [faux.provider],
			timings: { retryBaseDelayMs: 20 },
		});
		const statuses: { reason: string; retry?: unknown }[] = [];
		const stop = runtime.harness.subscribeCommits(({ changes }) => {
			for (const c of changes)
				if (c.type === "document" && c.record.kind === "pi.live")
					statuses.push(...((c.value?.compactions ?? []) as typeof statuses));
		});
		try {
			faux.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage([fauxText("ok")])));
			await runtime.waitAnswer(await runtime.submit("a".repeat(90000)));
			await runtime.waitAnswer(await runtime.submit("b".repeat(90000)));
			const before = (await runtime.listConversations())[0]!;
			if (mode === "failure") {
				faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" })]);
				await runtime.compact();
				await untilPhase(runtime, "failed");
			} else if (mode === "cancel") {
				faux.setResponses([
					async (_ctx, options) => {
						await new Promise<void>((r) => {
							if (options?.signal?.aborted) r();
							else options?.signal?.addEventListener("abort", () => r(), { once: true });
						});
						return fauxAssistantMessage([], { stopReason: "aborted" });
					},
				]);
				await runtime.compact();
				await Bun.sleep(30);
				await runtime.abort();
				await untilPhase(runtime, "cancelled");
			} else if (mode === "retry") {
				faux.setResponses([
					fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
					fauxAssistantMessage([fauxText("summary")]),
				]);
				await runtime.compact();
				await untilPhase(runtime, "applied");
				expect(statuses.some((s) => s.retry)).toBe(true);
			} else {
				faux.setResponses([
					fauxAssistantMessage([], { stopReason: "error", errorMessage: "maximum context length exceeded" }),
					fauxAssistantMessage([fauxText("summary")]),
					fauxAssistantMessage([fauxText("retried answer")]),
				]);
				expect((await runtime.waitAnswer(await runtime.submit("continue"))).status).toBe("done");
				expect(statuses.some((s) => s.reason === "overflow")).toBe(true);
			}
			if (mode !== "overflow") expect((await runtime.listConversations())[0]!.lastMessageAt).toBe(before.lastMessageAt);
		} finally {
			stop();
			await runtime.close();
		}
	}, 15000);
}

it("waits for the native write boundary and restores terminal state after reopening", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const { rm } = await import("../../../test/temp-dir.ts");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "neko-compact-recovery-"));
	const faux = fauxProvider({ models: [{ id: "compact", contextWindow: 1000000 }] });
	const options = {
		storagePath: join(dir, "history.sqlite"),
		model: { provider: "faux", modelId: "compact" },
		providers: [faux.provider],
	};
	let runtime = await createNekoRuntime(options);
	let release = () => {};
	try {
		faux.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage([fauxText("answer")])));
		await runtime.waitAnswer(await runtime.submit("a".repeat(90000)));
		await runtime.waitAnswer(await runtime.submit("b".repeat(90000)));
		const gate = new Promise<void>((r) => {
			release = r;
		});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText("finished")]);
			},
			fauxAssistantMessage([fauxText("summary")]),
		]);
		const running = await runtime.submit("continue");
		await Bun.sleep(20);
		await runtime.compact();
		await untilPhase(runtime, "waiting-to-apply");
		const waiting = (await runtime.root.compactionRecord())!;
		await runtime.compact();
		expect((await runtime.root.compactionRecord())!.taskId).toBe(waiting.taskId);
		release();
		await runtime.waitAnswer(running);
		await untilPhase(runtime, "applied");
		const usage = await runtime.usage();
		const recency = (await runtime.listConversations())[0]!.lastMessageAt;
		await runtime.close();
		runtime = await createNekoRuntime(options);
		await untilPhase(runtime, "applied");
		expect(await runtime.usage()).toEqual(usage);
		expect((await runtime.listConversations())[0]!.lastMessageAt).toBe(recency);
	} finally {
		release();
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);

it("resumes an interrupted native summary after runtime restart", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const { rm } = await import("../../../test/temp-dir.ts");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "neko-summary-restart-"));
	const faux = fauxProvider({ models: [{ id: "compact", contextWindow: 1000000 }] });
	const options = {
		storagePath: join(dir, "history.sqlite"),
		model: { provider: "faux", modelId: "compact" },
		providers: [faux.provider],
	};
	let runtime = await createNekoRuntime(options);
	let started = false;
	try {
		faux.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage([fauxText("answer")])));
		await runtime.waitAnswer(await runtime.submit("a".repeat(90000)));
		await runtime.waitAnswer(await runtime.submit("b".repeat(90000)));
		faux.setResponses([
			async (_ctx, opts) => {
				started = true;
				await new Promise<void>((r) => opts?.signal?.addEventListener("abort", () => r(), { once: true }));
				return fauxAssistantMessage([], { stopReason: "aborted" });
			},
		]);
		await runtime.compact();
		for (let n = 0; n < 100 && !started; n++) await Bun.sleep(10);
		expect(started).toBe(true);
		await runtime.close();
		faux.setResponses([fauxAssistantMessage([fauxText("recovered summary")])]);
		runtime = await createNekoRuntime(options);
		await untilPhase(runtime, "applied");
		expect((await runtime.root.conversation.context(runtime.context)).head?.kind).toBe("pi.compaction");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);

it("reports a native stale summary as skipped instead of applied", async () => {
	const faux = fauxProvider({ models: [{ id: "compact", contextWindow: 1000000 }] });
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "compact" },
	});
	let release = () => {};
	let started = false;
	try {
		faux.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage([fauxText("answer")])));
		await runtime.waitAnswer(await runtime.submit("a".repeat(90000)));
		await runtime.waitAnswer(await runtime.submit("b".repeat(90000)));
		const gate = new Promise<void>((r) => {
			release = r;
		});
		faux.setResponses([
			async () => {
				started = true;
				await gate;
				return fauxAssistantMessage([fauxText("stale summary")]);
			},
		]);
		await runtime.compact();
		for (let n = 0; n < 100 && !started; n++) await Bun.sleep(10);
		await runtime.root.conversation.reset("new context", runtime.context);
		release();
		await untilPhase(runtime, "skipped");
	} finally {
		release();
		await runtime.close();
	}
}, 15000);

it("keeps the native compaction failure visible after reopening and a later no-op", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const { rm } = await import("../../../test/temp-dir.ts");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = await mkdtemp(join(tmpdir(), "neko-failure-restart-"));
	const faux = fauxProvider({ models: [{ id: "compact", contextWindow: 1000000 }] });
	const options = {
		storagePath: join(dir, "history.sqlite"),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "compact" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		faux.setResponses(Array.from({ length: 2 }, () => fauxAssistantMessage([fauxText("answer")])));
		await runtime.waitAnswer(await runtime.submit("a".repeat(90000)));
		await runtime.waitAnswer(await runtime.submit("b".repeat(90000)));
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid summary" })]);
		await runtime.compact();
		await untilPhase(runtime, "failed");
		await runtime.close();
		runtime = await createNekoRuntime(options);
		const state = await runtime.viewState();
		const { projectChatView } = await import("../src/projection.ts");
		expect(projectChatView(state.value, "test").compaction?.failure?.error).toContain("invalid summary");
		state.dispose();
		await runtime.conversation.reset("empty", runtime.context);
		await runtime.compact();
		await untilPhase(runtime, "nothing");
		const fresh = await runtime.viewState();
		expect(projectChatView(fresh.value, "test").compaction?.failure?.error).toContain("invalid summary");
		fresh.dispose();
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);

it("preserves the native bash nonzero result and diagnostic", async () => {
	const faux = fauxProvider();
	const { fauxToolCall } = await import("@earendil-works/pi-ai");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'native failure\\n'; exit 7" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("failed command")]),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("execute"));
		const state = await runtime.viewState();
		const { projectChatView } = await import("../src/projection.ts");
		const tool = projectChatView(state.value, "test").items.find((item) => item.type === "tool")!;
		expect(tool.type === "tool" && tool.isError).toBe(true);
		expect(tool.type === "tool" && tool.result).toContain("native failure");
		expect(tool.type === "tool" && tool.result).toContain("7");
		state.dispose();
	} finally {
		await runtime.close();
	}
});
