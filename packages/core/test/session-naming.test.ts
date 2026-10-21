import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { byMessage, byVisited, relativeTime } from "../src/session-display.ts";
import { boundedText, cleanTitle, SessionMetadataDoc } from "../src/session-metadata.ts";

async function until(test: () => Promise<boolean>) {
	for (let i = 0; i < 300; i++) {
		if (await test()) return;
		await Bun.sleep(20);
	}
	throw new Error("metadata timeout");
}
it("names the first answered question off-thread, persists usage and keeps independent recency", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-naming-"));
	const faux = fauxProvider();
	const opts = {
		storagePath: join(dir, "db.sqlite"),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	};
	let runtime = await createNekoRuntime({ ...opts, credentials: new InMemoryCredentialStore() });
	let captured = "";
	faux.setResponses([
		async () => {
			await Bun.sleep(30);
			return fauxAssistantMessage([fauxText("完整答案")]);
		},
		(context, options) => {
			captured = JSON.stringify(context);
			expect(options?.reasoning).toBeUndefined();
			expect(context.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []))).toHaveLength(0);
			return fauxAssistantMessage([fauxText("“首轮问题总结”")]);
		},
	]);
	try {
		await runtime.submit("如何修复目录排序？", { requestId: "first" });
		await until(async () => (await runtime.listConversations())[0]?.title === "首轮问题总结");
		const before = (await runtime.listConversations())[0]!;
		expect(captured).toContain("完整答案");
		expect(captured).toContain("如何修复目录排序");
		await runtime.submit("must be ignored", { requestId: "first" });
		await runtime.touchConversation(runtime.root.id);
		expect((await runtime.listConversations())[0]!.lastMessageAt).toBe(before.lastMessageAt);
		expect(faux.state.callCount).toBe(2);
		const naming = await runtime.namingUsage();
		expect(Object.keys(naming.models)).toHaveLength(1);
		const total = await runtime.usage();
		expect(await runtime.globalUsage()).toEqual(total);
		const fork = await runtime.forkConversation(runtime.root.id);
		expect((await runtime.listConversations()).find((s) => s.id === fork.id)?.title).toBe(before.title);
		await runtime.close();
		runtime = await createNekoRuntime({ ...opts, credentials: new InMemoryCredentialStore() });
		expect((await runtime.listConversations())[0]!.title).toBe(before.title);
		expect(await runtime.namingUsage()).toEqual(naming);
		expect(await runtime.usage()).toEqual(total);
		expect(await runtime.globalUsage()).toEqual(total);
		expect((await runtime.listConversations())[0]!.lastMessageAt).toBe(before.lastMessageAt);
		expect(faux.state.callCount).toBe(2);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});
it("falls back after two invalid title responses without polluting the transcript", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxText("answer")]),
		fauxAssistantMessage([fauxText("   ")]),
		fauxAssistantMessage([fauxText("``")]),
	]);
	const runtime = await createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		timings: { namingRetryDelayMs: 20 },
	});
	try {
		await runtime.submit("first question");
		await until(
			async () =>
				(await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))?.naming === "fallback",
		);
		const d = (await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))!;
		expect(d.attempts).toBe(2);
		expect(d.firstPromptPreview).toBe("first question");
		expect(d.title).toBe("");
		expect(Object.values(d.namingUsage.models)[0]?.totalTokens).toBeGreaterThan(0);
		const view = await runtime.viewState();
		expect(view.value.entries.filter((e) => e.kind === "pi.assistant")).toHaveLength(1);
		view.dispose();
	} finally {
		await runtime.close();
	}
});
it("normalizes titles and separates message order from visits and relative time", () => {
	expect(cleanTitle("  **“标题”**\n")).toBe("标题");
	expect(cleanTitle("\x1b[31m[标题](https://example.com)\x1b[0m")).toBe("标题");
	expect([...cleanTitle("猫".repeat(100))]).toHaveLength(60);
	for (const limit of [0, 1, 10, 16, 60]) expect(boundedText("x".repeat(200), limit).length).toBeLessThanOrEqual(limit);
	const a = {
		id: "1",
		title: "",
		firstPromptPreview: "",
		workspaceRoot: "/a",
		createdAt: 10,
		lastMessageAt: 20,
		lastUsedAt: 100,
	};
	const b = { ...a, id: "2", lastMessageAt: 30, lastUsedAt: 50 };
	expect([a, b].sort(byMessage).map((x) => x.id)).toEqual(["2", "1"]);
	expect([a, b].sort(byVisited).map((x) => x.id)).toEqual(["1", "2"]);
	expect(relativeTime(100, 0)).toBe("now");
	expect(relativeTime(0, 120000, "zh")).toBe("2 分钟前");
	expect(relativeTime(0, 3600000)).toBe("1h");
	expect(relativeTime(0, 59999)).toBe("now");
	expect(relativeTime(0, 60000)).toBe("1m");
	expect(relativeTime(0, 86400000)).toBe("1d");
	expect(relativeTime(0, 30 * 86400000)).toBe(new Date(0).toLocaleDateString("en-GB"));
});

it("restores an interrupted naming attempt and ignores results after archive", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-naming-recovery-"));
	const faux = fauxProvider();
	const opts = {
		storagePath: join(dir, "db.sqlite"),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	};
	let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
	faux.setResponses([
		fauxAssistantMessage([fauxText("answer")]),
		() =>
			new Promise((r) => {
				release = r;
			}),
	]);
	let runtime = await createNekoRuntime({ ...opts, credentials: new InMemoryCredentialStore() });
	try {
		await runtime.submit("recover this title");
		await until(async () => faux.state.callCount === 2);
		await runtime.close();
		faux.appendResponses([fauxAssistantMessage([fauxText("Recovered title")])]);
		runtime = await createNekoRuntime({ ...opts, credentials: new InMemoryCredentialStore() });
		await until(async () => (await runtime.listConversations())[0]?.title === "Recovered title");
		release(fauxAssistantMessage([fauxText("obsolete result")]));
		expect((await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))?.attempts).toBe(2);
		expect((await runtime.listConversations())[0]!.title).toBe("Recovered title");
		const child = await runtime.createConversation();
		let releaseChild!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
		faux.appendResponses([
			fauxAssistantMessage([fauxText("second answer")]),
			() =>
				new Promise((r) => {
					releaseChild = r;
				}),
		]);
		await child.submit("archive while naming");
		await until(async () => faux.state.callCount === 5);
		await runtime.archiveConversation(child.id);
		releaseChild(fauxAssistantMessage([fauxText("must not save")]));
		await Bun.sleep(30);
		expect((await runtime.harness.snapshot(SessionMetadataDoc, child.id, runtime.context))?.title).toBe("");
		expect((await runtime.listConversations()).some((x) => x.id === child.id)).toBe(false);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});
it("does not retry a failed first answer using a later question", async () => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([]), fauxAssistantMessage([fauxText("later answer")])]);
	const runtime = await createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("first", { requestId: "__proto__" }));
		await runtime.waitAnswer(await runtime.submit("second"));
		await Bun.sleep(150);
		const info = (await runtime.listConversations())[0]!;
		expect(info.firstPromptPreview).toBe("first");
		expect(info.title).toBe("");
		expect(faux.state.callCount).toBe(2);
	} finally {
		await runtime.close();
	}
});

it("names from the final tool answer while steer and follow-up keep their own activity", async () => {
	const faux = fauxProvider();
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let entered = false,
		namingContext = "";
	const tool = defineTool({
		name: "naming_gate",
		description: "test gate",
		parameters: Type.Object({}),
		execute: async () => {
			entered = true;
			await gate;
			return { output: [{ type: "text" as const, text: "tool result" }] };
		},
	});
	const runtime = await createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		extensions: [defineExtension({ name: "naming-test", tools: [tool] })],
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("naming_gate", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("final answer after tools")]),
		fauxAssistantMessage([fauxText("follow-up answer")]),
		(context) => {
			namingContext = JSON.stringify(context);
			return fauxAssistantMessage([fauxText("Tool session")]);
		},
	]);
	try {
		const first = await runtime.submit("original question");
		await until(async () => entered);
		const steer = await runtime.submit("steer instruction", { whenBusy: "steer" });
		const follow = await runtime.submit("follow-up instruction", { whenBusy: "followUp" });
		release();
		await Promise.all([first, steer, follow].map((s) => runtime.waitAnswer(s)));
		await until(async () => (await runtime.listConversations())[0]?.title === "Tool session");
		expect(namingContext).toContain("original question");
		expect(namingContext).toContain("final answer after tools");
		expect(namingContext).not.toContain("follow-up answer");
		expect((await runtime.listConversations())[0]?.firstPromptPreview).toBe("original question");
	} finally {
		release();
		await runtime.close();
	}
});

it("limits concurrent naming to two and never charges a request twice", async () => {
	const chat = fauxProvider(),
		naming = fauxProvider();
	const stream = chat.provider.streamSimple.bind(chat.provider);
	const releases: Array<() => void> = [];
	let active = 0,
		peak = 0;
	chat.provider.streamSimple = (model, context, options) =>
		context.messages.some(
			(m) => m.role === "system" && JSON.stringify(m.content).includes("Summarize the first question"),
		)
			? naming.provider.streamSimple(model, context, options)
			: stream(model, context, options);
	chat.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage([fauxText("answer")])));
	naming.setResponses(
		Array.from({ length: 3 }, () => async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((r) => releases.push(r));
			active--;
			return fauxAssistantMessage([fauxText("title")]);
		}),
	);
	const runtime = await createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		providers: [chat.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		const sessions = [runtime.root, await runtime.createConversation(), await runtime.createConversation()];
		await Promise.all(sessions.map(async (s) => s.waitAnswer(await s.submit("question"))));
		await until(async () => releases.length === 2);
		expect(peak).toBe(2);
		releases[0]!();
		releases[1]!();
		await until(async () => releases.length === 3);
		releases[2]!();
		await until(async () => (await runtime.listConversations()).every((s) => s.title === "title"));
		expect(naming.state.callCount).toBe(3);
		expect(peak).toBe(2);
	} finally {
		for (const release of releases) release();
		await runtime.close();
	}
});

it("sends DeepSeek titles with thinking disabled while preserving conversation thinking", async () => {
	const originalFetch = globalThis.fetch;
	const key = process.env.DEEPSEEK_API_KEY;
	process.env.DEEPSEEK_API_KEY = "test-key";
	const bodies: Array<Record<string, unknown>> = [];
	globalThis.fetch = Object.assign(
		async (_input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			bodies.push(body);
			const content = bodies.length === 1 ? "First answer" : "DeepSeek title";
			const chunk = {
				id: "test",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-flash",
				choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
			};
			const final = {
				...chunk,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	let runtime: Awaited<ReturnType<typeof createNekoRuntime>> | undefined;
	try {
		runtime = await createNekoRuntime({
			credentials: new InMemoryCredentialStore(),
			storage: "memory",
			thinkingLevel: "high",
		});
		await runtime.waitAnswer(await runtime.submit("Name this question"));
		await until(async () => (await runtime!.listConversations())[0]?.title === "DeepSeek title");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]!.thinking).toEqual({ type: "enabled" });
		expect(bodies[1]!.thinking).toEqual({ type: "disabled" });
		expect(bodies[1]!.tools).toBeUndefined();
		expect((await runtime.conversation.agent(runtime.context)).thinkingLevel).toBe("high");
	} finally {
		await runtime?.close();
		globalThis.fetch = originalFetch;
		if (key === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = key;
	}
});

it("skips models that cannot disable thinking", async () => {
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
	faux.models[0]!.thinkingLevelMap = { off: null };
	faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
	const runtime = await createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("keep preview"));
		await until(
			async () =>
				(await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))?.naming === "fallback",
		);
		expect(faux.state.callCount).toBe(1);
		expect((await runtime.listConversations())[0]?.firstPromptPreview).toBe("keep preview");
	} finally {
		await runtime.close();
	}
});

it("bounds hung title requests by timeout and the persisted retry budget", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxText("answer")]),
		() => new Promise(() => {}),
		() => new Promise(() => {}),
	]);
	const runtime = await createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		timings: { namingRequestTimeoutMs: 100, namingRetryDelayMs: 20 },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("timeout question"));
		await until(
			async () =>
				(await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))?.naming === "fallback",
		);
		const saved = await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context);
		expect(saved?.naming).toBe("fallback");
		expect(saved?.attempts).toBe(2);
		expect(saved?.status).toBe("idle");
		expect(faux.state.callCount).toBe(3);
	} finally {
		await runtime.close();
	}
}, 15_000);

it("does not advance message time or name an aborted first answer", async () => {
	const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
	faux.setResponses([fauxAssistantMessage([fauxText("partial answer ".repeat(100))])]);
	const runtime = await createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	let notices = 0;
	const stop = runtime.onDirectoryChange(() => notices++);
	try {
		const input = await runtime.submit("cancel this answer");
		await until(async () => faux.state.callCount === 1);
		const sent = (await runtime.listConversations())[0]!.lastMessageAt;
		await Bun.sleep(80);
		await runtime.abort();
		await runtime.waitAnswer(input);
		const metadata = await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context);
		expect(metadata?.naming).toBe("fallback");
		expect(metadata?.lastMessageAt).toBe(sent);
		expect(faux.state.callCount).toBe(1);
		expect(notices).toBeLessThan(8);
	} finally {
		stop();
		await runtime.close();
	}
});
