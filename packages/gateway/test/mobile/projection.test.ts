import { describe, expect, it } from "bun:test";
import type { ChatView } from "@neko-harness/core";
import { Check } from "typebox/value";
import {
	MobileChatProjection,
	mapStatus,
	ProjectionError,
	type ProjectionNotice,
	type ProjectionSource,
} from "../../src/mobile/projection.ts";
import {
	MOBILE_API_V1_METHODS,
	MOBILE_API_V1_NOTIFICATIONS,
	MOBILE_LIMITS,
	MobileChatSnapshotSchema,
} from "../../src/mobile/protocol.ts";

type Item = ChatView["items"][number];

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 };

function baseView(items: Item[]): ChatView {
	return {
		model: "faux/faux-1",
		agent: { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "medium" },
		cwd: "/tmp",
		busy: false,
		status: null,
		usage,
		items,
		streaming: null,
	};
}

const user = (id: number, text = `问题 ${id}`): Item => ({ type: "user", key: `u-${id}`, id, text });
const assistant = (id: number, text = `回答 ${id}`): Item => ({
	type: "assistant",
	key: `a-${id}`,
	id,
	thinking: "",
	text,
	stopReason: "stop",
	errorMessage: null,
	note: null,
});
const tool = (callId: string, patch: Partial<Extract<Item, { type: "tool" }>> = {}): Item => ({
	type: "tool",
	key: `t-${callId}`,
	callId,
	name: "bash",
	summary: "ls",
	detail: null,
	phase: "running",
	isError: false,
	output: null,
	result: null,
	durationMs: null,
	note: null,
	diff: null,
	diffAdded: null,
	diffRemoved: null,
	...patch,
});

class FakeSource implements ProjectionSource {
	value: ChatView | undefined;
	private readonly listeners = new Set<() => void>();
	olderPages?: Map<number, { items: Item[]; next: number | null }>;

	constructor(view: ChatView) {
		this.value = view;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	set(view: ChatView): void {
		this.value = view;
		for (const listener of this.listeners) listener();
	}

	get older() {
		const pages = this.olderPages;
		if (pages === undefined) return undefined;
		return async (before: number) => {
			const page = pages.get(before);
			if (page === undefined) throw new Error("no page");
			return page;
		};
	}
}

function projection(source: ProjectionSource, readonly?: boolean) {
	const notices: ProjectionNotice[] = [];
	const value = new MobileChatProjection({
		subscriptionId: "chat-1",
		owner: { sessionId: "7" },
		source,
		...(readonly === undefined ? {} : { readonly }),
		onNotice: (notice) => notices.push(notice),
	});
	return { projection: value, notices };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const patchSchema = MOBILE_API_V1_NOTIFICATIONS["chat.patch"] as never;

describe("mobile chat projection", () => {
	it("bounds the first snapshot and pages a 2000-item history without gaps or duplicates", async () => {
		const items: Item[] = [];
		for (let id = 1; id <= 1000; id++) items.push(user(id * 2), assistant(id * 2 + 1, "回答".repeat(400)));
		const source = new FakeSource(baseView(items));
		const { projection: chat } = projection(source);
		const snapshot = chat.snapshot();
		expect(Check(MobileChatSnapshotSchema, snapshot)).toBe(true);
		expect(snapshot.items.length).toBeLessThanOrEqual(MOBILE_LIMITS.pageItems);
		expect(bytes(snapshot)).toBeLessThanOrEqual(MOBILE_LIMITS.maxPayloadBytes);
		const seen = snapshot.items.map((item) => item.key);
		let cursor = snapshot.historyBefore;
		while (cursor !== null) {
			const page = await chat.history(cursor);
			expect(Check(MOBILE_API_V1_METHODS["chat.history"]?.result as never, page)).toBe(true);
			expect(page.items.length).toBeGreaterThan(0);
			expect(page.items.length).toBeLessThanOrEqual(MOBILE_LIMITS.pageItems);
			expect(bytes(page)).toBeLessThanOrEqual(MOBILE_LIMITS.maxPayloadBytes);
			seen.unshift(...page.items.map((item) => item.key));
			cursor = page.historyBefore;
		}
		expect(seen).toEqual(items.map((item) => item.key));
		chat.dispose();
	});

	it("streams appends and upserts only the changed tool card", async () => {
		const items = [user(1), tool("c1"), tool("c2")];
		const source = new FakeSource({
			...baseView(items),
			busy: true,
			streaming: { thinking: "", text: "你", toolCalls: [] },
		});
		const { projection: chat, notices } = projection(source);
		const snapshot = chat.snapshot();
		expect(snapshot.streaming?.text).toBe("你");

		source.set({ ...baseView(items), busy: true, streaming: { thinking: "", text: "你好世界", toolCalls: [] } });
		chat.flush();
		expect(notices.at(-1)).toEqual({
			kind: "patch",
			params: { upserts: [], streamingAppend: { text: "好世界" }, seq: 1 },
		});

		const updated = [user(1), tool("c1", { phase: "done", result: "ok" }), tool("c2")];
		source.set({ ...baseView(updated), busy: true, streaming: { thinking: "", text: "你好世界", toolCalls: [] } });
		chat.flush();
		const patch = notices.at(-1) as { kind: "patch"; params: Record<string, unknown> };
		expect(patch.params.upserts).toEqual([
			{
				key: "t-c1",
				type: "tool",
				tool: { callId: "c1", name: "bash", summary: "ls", status: "done", result: "ok" },
			},
		]);
		expect(Check(patchSchema, { subscriptionId: "chat-1", ...patch.params })).toBe(true);

		source.set({ ...baseView([...updated, assistant(4, "你好世界")]), busy: false });
		chat.flush();
		const done = notices.at(-1) as { kind: "patch"; params: Record<string, unknown> };
		expect(done.params.streaming).toBeNull();
		expect((done.params.upserts as Array<{ key: string }>).map((item) => item.key)).toEqual(["a-4"]);
		expect((done.params.status as { busy: boolean }).busy).toBe(false);
		chat.dispose();
	});

	it("only appends new items after the loaded window and never pushes unloaded history", () => {
		const items: Item[] = [];
		for (let id = 1; id <= 120; id++) items.push(user(id));
		const source = new FakeSource(baseView(items));
		const { projection: chat, notices } = projection(source);
		chat.snapshot();
		source.set(baseView([...items, assistant(121)]));
		chat.flush();
		const patch = notices.at(-1) as { kind: "patch"; params: { upserts: Array<{ key: string }> } };
		expect(patch.params.upserts.map((item) => item.key)).toEqual(["a-121"]);
		chat.dispose();
	});

	it("resets when a loaded key disappears or reorders, then stays quiet until a new snapshot", () => {
		const items = [user(1), assistant(2), user(3)];
		const source = new FakeSource(baseView(items));
		const { projection: chat, notices } = projection(source);
		chat.snapshot();
		source.set(baseView([user(1), user(3)]));
		chat.flush();
		expect(notices.at(-1)).toEqual({ kind: "reset", params: { seq: 1 } });
		source.set(baseView([user(1), user(3), assistant(4)]));
		chat.flush();
		expect(notices).toHaveLength(1);
		chat.snapshot();
		source.set(baseView([user(3), user(1), assistant(4)]));
		chat.flush();
		expect(notices.at(-1)).toEqual({ kind: "reset", params: { seq: 2 } });
		chat.dispose();
	});

	it("turns an oversized patch into a reset", () => {
		const source = new FakeSource(baseView([user(1)]));
		const { projection: chat, notices } = projection(source);
		chat.snapshot();
		const burst: Item[] = [user(1)];
		for (let id = 2; id < 80; id++) burst.push(assistant(id, "长".repeat(2700)));
		source.set(baseView(burst));
		chat.flush();
		expect(notices.at(-1)?.kind).toBe("reset");
		chat.dispose();
	});

	it("replaces large fields with previews and serves byte-exact chunks with digest checks", () => {
		const output = `${"多字节😀内容".repeat(9000)}…[truncated]`;
		const items = [
			user(1),
			tool("big", { phase: "done", result: output, diffTruncated: true, note: "Output truncated." }),
		];
		const source = new FakeSource(baseView(items));
		const { projection: chat } = projection(source);
		const snapshot = chat.snapshot();
		const card = snapshot.items[1] as unknown as {
			tool: { result: string; diffTruncated: boolean; note: string };
			refs: Array<{ key: string; field: string; digest: string; bytes: number; sessionId: string }>;
		};
		expect(Buffer.byteLength(card.tool.result, "utf8")).toBeLessThanOrEqual(2048);
		expect(output.startsWith(card.tool.result)).toBe(true);
		expect(card.tool.diffTruncated).toBe(true);
		expect(card.tool.note).toBe("Output truncated.");
		const ref = card.refs[0];
		if (ref === undefined) throw new Error("missing ref");
		expect(ref).toMatchObject({ sessionId: "7", key: "t-big", field: "tool.result" });
		const parts: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const chunk = chat.content(ref, offset);
			expect(chunk.bytes.length).toBeLessThanOrEqual(MOBILE_LIMITS.chunkBytes);
			parts.push(chunk.bytes);
			offset += chunk.bytes.length;
			if (offset >= chunk.total) break;
		}
		expect(Buffer.concat(parts).toString("utf8")).toBe(output);
		expect(offset).toBe(ref.bytes);

		source.set(baseView([user(1), tool("big", { phase: "done", result: `${output}!` })]));
		expect(() => chat.content(ref, 0)).toThrow(ProjectionError);
		try {
			chat.content(ref, 0);
		} catch (error) {
			expect((error as ProjectionError).code).toBe("content_changed");
		}
		chat.dispose();
	});

	it("carries the bounded codemode call list on tool cards and omits null fields", () => {
		const calls = Array.from({ length: 100 }, (_, i) => ({
			id: i + 1,
			name: "read",
			args: "a".repeat(200),
			status: i === 1 ? ("error" as const) : ("ok" as const),
			durationMs: i === 0 ? null : 5,
			error: i === 1 ? "e".repeat(200) : null,
		}));
		const plain = tool("plain", { phase: "done" });
		const script = tool("script", {
			name: "codemode",
			phase: "done",
			codemode: { calls, omitted: 7, fullOutputPath: null },
		});
		const { projection: chat } = projection(new FakeSource(baseView([user(1), plain, script])));
		const snapshot = chat.snapshot();
		expect(Check(MobileChatSnapshotSchema, snapshot)).toBe(true);
		const [, plainCard, card] = snapshot.items as unknown as {
			tool: { codemode?: { calls: Record<string, unknown>[]; omitted: number; fullOutputPath?: string } };
		}[];
		expect(plainCard?.tool.codemode).toBeUndefined();
		expect(card?.tool.codemode?.omitted).toBe(7);
		expect(card?.tool.codemode?.calls).toHaveLength(100);
		expect(card?.tool.codemode?.calls[0]).not.toHaveProperty("durationMs");
		expect(card?.tool.codemode?.calls[0]).not.toHaveProperty("error");
		expect(card?.tool.codemode?.calls[1]).toMatchObject({ status: "error", error: "e".repeat(200) });
		expect(card?.tool.codemode).not.toHaveProperty("fullOutputPath");
		chat.dispose();
	});

	it("reports stale cursors", async () => {
		const source = new FakeSource(baseView([user(1), user(2)]));
		const { projection: chat } = projection(source);
		chat.snapshot();
		await expect(chat.history("u-404")).rejects.toThrow(ProjectionError);
		chat.dispose();
	});

	it("tolerates a rolling subagent window and continues into persisted history", async () => {
		const live = [user(10), assistant(11), user(12)];
		const source = new FakeSource({ ...baseView(live), historyBefore: 10 });
		source.olderPages = new Map([
			[10, { items: [user(5), assistant(6)], next: 5 }],
			[5, { items: [user(1)], next: null }],
		]);
		const { projection: chat, notices } = projection(source, false);
		const snapshot = chat.snapshot();
		expect(snapshot.historyBefore).toBe("entry:10");
		expect((snapshot as { readonly?: boolean }).readonly).toBe(false);
		const first = await chat.history("entry:10");
		expect(first.items.map((item) => item.key)).toEqual(["u-5", "a-6"]);
		expect(first.historyBefore).toBe("entry:5");
		const last = await chat.history("entry:5");
		expect(last.items.map((item) => item.key)).toEqual(["u-1"]);
		expect(last.historyBefore).toBeNull();

		source.set({ ...baseView([assistant(11), user(12), assistant(13)]), historyBefore: 11 });
		chat.flush();
		const patch = notices.at(-1) as { kind: "patch"; params: { upserts: Array<{ key: string }> } };
		expect(patch.kind).toBe("patch");
		expect(patch.params.upserts.map((item) => item.key)).toEqual(["a-13"]);
		chat.dispose();
	});

	it("maps subagent rounds and agents into the status block", () => {
		const view: ChatView = {
			...baseView([user(1)]),
			subagents: [
				{
					parentId: 1,
					taskId: 9,
					callId: "c",
					childId: 4,
					role: "explore",
					title: "看代码",
					createdAt: 1,
					startedAt: 1,
					endedAt: null,
					status: "running",
					report: null,
					approvalCount: 2,
				},
			],
		};
		const { projection: chat } = projection(new FakeSource(view));
		const snapshot = chat.snapshot() as unknown as {
			subagents: Array<{ agentId: string; approvalCount: number; readonly: boolean }>;
			approvalCount: number;
		};
		expect(snapshot.subagents[0]).toMatchObject({ agentId: "agent-4", approvalCount: 2, readonly: false });
		expect(snapshot.approvalCount).toBe(2);
		chat.dispose();
	});
});

describe("mobile status queue", () => {
	it("maps queued inputs without skills and omits the field for a view without queue visibility", () => {
		const view = baseView([]);
		expect("queued" in mapStatus(view)).toBe(false);
		const queued = mapStatus({
			...view,
			queued: [{ id: 4, mode: "steer", preview: "hi", images: 1, skill: { name: "pdf", args: "x" } }],
		});
		expect(queued.queued).toEqual([{ id: 4, mode: "steer", preview: "hi", images: 1 }]);
		expect(Check(MobileChatSnapshotSchema, { ...queued, items: [], historyBefore: null, streaming: null })).toBe(true);
		expect(mapStatus({ ...view, queued: [] }).queued).toEqual([]);
	});
});
