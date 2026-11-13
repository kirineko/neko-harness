import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Message,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type EntryRecord } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { ContextPruner, estimateTokens, PRUNE_ENTRY_KIND, planPrune, toolResultChars } from "../src/context-pruning.ts";
import { projectChatView } from "../src/projection.ts";
import { createNekoRuntime } from "../src/runtime.ts";

const result = (id: number, text: string, toolName = "big"): EntryRecord =>
	({
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [
			{
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 0,
				details: { big: true },
			},
		],
	}) as unknown as EntryRecord;

it("plans only old, large, not yet replaced results", () => {
	const entries = [
		result(1, "x".repeat(5000)),
		result(2, "y".repeat(100)),
		result(3, "z".repeat(6000)),
		result(4, "w".repeat(9000)),
	];
	const plan = planPrune(entries, { keepRecent: 1, minChars: 4000 })!;
	expect(plan.targets).toEqual([1, 3]);
	expect(plan.savedChars).toBe(11000);
	expect(plan.savedTokens).toBeCloseTo(3300);
	const edit = plan.edits[0]!;
	expect(edit.action).toBe("replace");
	const message = (edit as unknown as { messages: ToolResultMessage[] }).messages[0]!;
	expect(message).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "big", isError: false });
	expect(message.details).toBeUndefined();
	expect(toolResultChars(message)).toBeLessThan(200);

	const withPrune = [...entries, { id: 5, kind: PRUNE_ENTRY_KIND, edits: plan.edits } as unknown as EntryRecord];
	expect(planPrune(withPrune, { keepRecent: 1, minChars: 4000 })).toBeUndefined();
	expect(planPrune(entries, { keepRecent: 10, minChars: 1 })).toBeUndefined();
	expect(planPrune(entries, { keepRecent: 0, minChars: 1 })!.targets).toEqual([1, 2, 3, 4]);
});

it("estimates tokens from DeepSeek's per-character ratios", () => {
	expect(estimateTokens("x".repeat(1000))).toBeCloseTo(300);
	expect(estimateTokens("字".repeat(1000))).toBeCloseTo(600);
	expect(estimateTokens(`${"字".repeat(100)}${"x".repeat(100)}`)).toBeCloseTo(90);
	expect(estimateTokens("")).toBe(0);
});

const big = defineTool({
	name: "big",
	description: "Returns a large output.",
	parameters: obj({}, { open: true }),
	execute: async () => ({ output: [{ type: "text", text: "q".repeat(40_000) }] }),
});

async function run(
	pruning: { enabled?: boolean; triggerPercent?: number; minSavePercent?: number } | undefined,
	saved?: boolean,
) {
	const requests: ToolResultMessage[][] = [];
	const record: FauxResponseFactory = (context) => {
		requests.push(context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult"));
		const last = context.messages[context.messages.length - 1]!;
		return last.role === "toolResult"
			? fauxAssistantMessage([fauxText("done")])
			: fauxAssistantMessage([fauxToolCall("big", {})], { stopReason: "toolUse" });
	};
	const faux = fauxProvider({ models: [{ id: "m", contextWindow: 1_000_000 }] });
	faux.setResponses(Array.from({ length: 30 }, () => record));
	const runtime = await createNekoRuntime({
		storage: "memory",
		model: { provider: "faux", modelId: "m" },
		providers: [faux.provider],
		extensions: [defineExtension({ name: "big", tools: [big] })],
		contextSettings: { pruning: { triggerPercent: 1, keepRecent: 1, minChars: 1000, minSavePercent: 1, ...pruning } },
	});
	if (saved) await runtime.setContextSettings({ pruning: { enabled: true } });
	for (let i = 0; i < 3; i++) await runtime.waitAnswer(await runtime.submit(`turn ${i}`));
	await sleep(100);
	const entries = (await runtime.root.conversation.context(runtime.context)).entries;
	const chat = projectChatView((await runtime.root.follow()).value, "faux/m");
	const sessions = await runtime.listConversations();
	await runtime.close();
	return { requests, entries, chat, sessions };
}

const text = (message: ToolResultMessage) =>
	message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

it("prunes old tool results from the model context once, keeping history intact", async () => {
	const { requests, entries } = await run({ enabled: true });
	const last = requests[requests.length - 1]!;
	expect(last.length).toBe(3);
	expect(text(last[0]!)).toContain("omitted from context");
	expect(text(last[2]!)).toHaveLength(40_000);
	const prunes = entries.filter((entry) => entry.kind === PRUNE_ENTRY_KIND);
	expect(prunes.length).toBeGreaterThan(0);
	const targets = prunes.flatMap((entry) => (entry.edits ?? []).map((edit) => edit.target));
	expect(new Set(targets).size).toBe(targets.length);
	const original = entries.filter((entry) => entry.kind === "pi.tool-result");
	expect(original.length).toBe(3);
	expect(original.every((entry) => toolResultChars(entry.model![0] as ToolResultMessage) === 40_000)).toBe(true);
});

it("keeps assistant thinking blocks untouched while pruning tool results", async () => {
	const requests: Message[][] = [];
	const faux = fauxProvider({ models: [{ id: "m", contextWindow: 1_000_000, reasoning: true }] });
	faux.setResponses(
		Array.from({ length: 30 }, () => (context: { messages: Message[] }) => {
			requests.push([...context.messages]);
			const n = context.messages.filter((m) => m.role === "assistant").length;
			return context.messages[context.messages.length - 1]!.role === "toolResult"
				? fauxAssistantMessage([fauxThinking(`think-final-${n}`), fauxText("done")])
				: fauxAssistantMessage([fauxThinking(`think-call-${n}`), fauxToolCall("big", {})], {
						stopReason: "toolUse",
					});
		}),
	);
	const runtime = await createNekoRuntime({
		storage: "memory",
		model: { provider: "faux", modelId: "m" },
		providers: [faux.provider],
		extensions: [defineExtension({ name: "big", tools: [big] })],
		contextSettings: {
			pruning: { enabled: true, triggerPercent: 1, keepRecent: 1, minChars: 1000, minSavePercent: 1 },
		},
	});
	for (let i = 0; i < 3; i++) await runtime.waitAnswer(await runtime.submit(`turn ${i}`));
	await runtime.close();
	const last = requests[requests.length - 1]!;
	const results = last.filter((m): m is ToolResultMessage => m.role === "toolResult");
	expect(results.some((m) => text(m).includes("omitted from context"))).toBe(true);
	const assistants = last.filter((m): m is AssistantMessage => m.role === "assistant");
	expect(assistants.length).toBeGreaterThanOrEqual(5);
	for (const message of assistants) {
		const thinking = message.content.filter((block) => block.type === "thinking");
		expect(thinking).toHaveLength(1);
		expect(thinking[0]).toMatchObject({ thinking: expect.stringMatching(/^think-(call|final)-\d+$/) });
	}
});

it("does nothing when pruning is off", async () => {
	const { requests, entries } = await run({ enabled: false });
	expect(entries.some((entry) => entry.kind === PRUNE_ENTRY_KIND)).toBe(false);
	expect(requests[requests.length - 1]!.every((message) => text(message).length === 40_000)).toBe(true);
});

it("stays below the trigger percent", async () => {
	const { entries } = await run({ enabled: true, triggerPercent: 99 });
	expect(entries.some((entry) => entry.kind === PRUNE_ENTRY_KIND)).toBe(false);
});

it("waits until a prune frees enough of the window to be worth a cache miss", async () => {
	const { entries } = await run({ enabled: true, minSavePercent: 50 });
	expect(entries.some((entry) => entry.kind === PRUNE_ENTRY_KIND)).toBe(false);
});

it("starts pruning as soon as a saved setting enables it", async () => {
	const { entries } = await run({ enabled: false }, true);
	expect(entries.some((entry) => entry.kind === PRUNE_ENTRY_KIND)).toBe(true);
});

it("reports a failed write, keeps going, and retries on the next trigger", async () => {
	let listener: ((publication: { changes: unknown[] }) => void) | undefined;
	const submissions: string[] = [];
	let fail = true;
	const conversation = {
		context: async () => ({ entries: [result(1, "x".repeat(5000)), result(2, "y".repeat(5000))] }),
		submit: async (draft: { requestId: string }) => {
			submissions.push(draft.requestId);
			if (fail) throw new Error("storage hiccup");
		},
	};
	const reports: unknown[] = [];
	const pruner = new ContextPruner({
		harness: {
			observeCommits: (observer: { advance: NonNullable<typeof listener> }) => {
				listener = observer.advance;
				return { detach: () => {} };
			},
			conversation: async () => conversation,
		} as never,
		context: BACKGROUND_CONTEXT,
		settings: () => ({ enabled: true, triggerPercent: 10, keepRecent: 1, minChars: 1000, minSavePercent: 1 }),
		windowOf: async () => 1000,
		report: (error) => reports.push(error),
	});
	const answer = (id: number) => ({
		type: "entry",
		value: {
			id,
			conversationId: 1,
			kind: "pi.assistant",
			model: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 500 } }],
		},
	});
	listener!({ changes: [answer(10)] });
	await pruner.flush();
	expect(reports).toHaveLength(1);
	fail = false;
	listener!({ changes: [answer(11)] });
	await pruner.flush();
	expect(submissions).toEqual(["prune:10", "prune:11"]);
	expect(reports).toHaveLength(1);
	pruner.close();
});

it("keeps the pruned context and writes nothing twice after a restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-prune-"));
	try {
		const open = () => {
			const faux = fauxProvider({ models: [{ id: "m", contextWindow: 1_000_000 }] });
			faux.setResponses(
				Array.from(
					{ length: 30 },
					() => (context) =>
						context.messages[context.messages.length - 1]!.role === "toolResult"
							? fauxAssistantMessage([fauxText("done")])
							: fauxAssistantMessage([fauxToolCall("big", {})], { stopReason: "toolUse" }),
				),
			);
			return createNekoRuntime({
				storage: "sqlite",
				storagePath: join(dir, "neko.sqlite"),
				model: { provider: "faux", modelId: "m" },
				providers: [faux.provider],
				extensions: [defineExtension({ name: "big", tools: [big] })],
				contextSettings: {
					pruning: { enabled: true, triggerPercent: 1, keepRecent: 1, minChars: 1000, minSavePercent: 1 },
				},
			});
		};
		const first = await open();
		for (let i = 0; i < 3; i++) await first.waitAnswer(await first.submit(`turn ${i}`));
		await sleep(100);
		const before = (await first.root.conversation.context(first.context)).entries.filter(
			(entry) => entry.kind === PRUNE_ENTRY_KIND,
		);
		await first.close();
		const second = await open();
		try {
			const view = await second.root.conversation.context(second.context);
			expect(view.entries.filter((entry) => entry.kind === PRUNE_ENTRY_KIND)).toHaveLength(before.length);
			const messages = view.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
			expect(text(messages[0]!)).toContain("omitted from context");
		} finally {
			await second.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("leaves the chat projection, titles and recency untouched", async () => {
	const on = await run({ enabled: true });
	const off = await run({ enabled: false });
	expect(on.entries.some((entry) => entry.kind === PRUNE_ENTRY_KIND)).toBe(true);
	const shape = (chat: typeof on.chat) =>
		chat.items.map((item) => [item.type, item.type === "tool" ? (item.result?.length ?? 0) : 0]);
	expect(shape(on.chat)).toEqual(shape(off.chat));
	expect(
		on.chat.items
			.filter((item) => item.type === "tool")
			.every((item) => (item as { result: string }).result.length >= 40_000),
	).toBe(true);
	expect(on.sessions[0]!.title).toBe(off.sessions[0]!.title);
	const lastAnswer = on.entries.filter((entry) => entry.kind === "pi.assistant").at(-1)!.model![0] as AssistantMessage;
	expect(on.sessions[0]!.lastMessageAt).toBe(lastAnswer.timestamp + (lastAnswer.durationMs ?? 0));
});
