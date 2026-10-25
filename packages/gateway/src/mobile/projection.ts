import { createHash } from "node:crypto";
import { agentIdFor, type ChatView } from "@neko-harness/core";
import { MOBILE_LIMITS } from "./protocol.ts";

/**
 * ChatView → 移动 DTO 投影（design D8）。主会话与子 agent 共用：每个订阅维护已加载条目的
 * key→digest 窗口，快照取尾部 ≤ pageItems 条且 ≤ maxPayloadBytes，变更按 100 ms 合并为
 * upsert / streaming 追加 / reset；超过 8 KiB 的字符串字段只发预览与 contentRef。
 */

export const CONTENT_PREVIEW_BYTES = 2048;
export const CONTENT_REF_BYTES = 8192;
export const MERGE_MS = 100;
/** 快照中流式区每个文本字段最多携带的尾部字符数。 */
const STREAMING_TAIL_CHARS = 16_384;

type RawItem = ChatView["items"][number];
type RawUsage = ChatView["usage"];
type Delegation = NonNullable<ChatView["subagents"]>[number];

export type MobileChatItem = Record<string, unknown> & { readonly key: string };
export type MobileStreaming = {
	readonly text: string;
	readonly thinking: string;
	readonly textOmitted: number;
	readonly thinkingOmitted: number;
	readonly toolCalls: ReadonlyArray<{ callId: string; name: string; summary: string; status: "running" | "done" }>;
};
export type MobileChatPage = { readonly items: MobileChatItem[]; readonly historyBefore: string | null };
export type MobileChatSnapshot = Record<string, unknown> &
	MobileChatPage & { readonly streaming: MobileStreaming | null };

export type ProjectionOwner = { readonly sessionId: string; readonly agentId?: string };

/** 投影数据源：主会话为共享 ChatView；子 agent 为分块下载的视图，另可按 entry 游标读更早历史。 */
export type ProjectionSource = {
	readonly value: ChatView | undefined;
	subscribe(listener: () => void): () => void;
	older?(beforeEntryId: number): Promise<{ readonly items: readonly RawItem[]; readonly next: number | null }>;
};

export type ProjectionNotice =
	| { readonly kind: "patch"; readonly params: Record<string, unknown> }
	| { readonly kind: "reset"; readonly params: Record<string, unknown> };

export class ProjectionError extends Error {
	readonly code: "stale_ref" | "content_changed" | "invalid_params";
	constructor(code: "stale_ref" | "content_changed" | "invalid_params", message: string) {
		super(message);
		this.code = code;
	}
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function digest16(value: string): string {
	return sha256Hex(value).slice(0, 16);
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** 按 UTF-8 字节截取，不切开多字节字符。 */
export function utf8Prefix(value: string, maxBytes: number): string {
	if (utf8Bytes(value) <= maxBytes) return value;
	let bytes = 0;
	let end = 0;
	for (const char of value) {
		const size = utf8Bytes(char);
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return value.slice(0, end);
}

export function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

const count = (value: number | undefined | null) => Math.max(0, Math.round(value ?? 0));

export function mapUsage(usage: RawUsage) {
	const input = count(usage.input);
	const output = count(usage.output);
	const cacheRead = count(usage.cacheRead);
	const cacheWrite = count(usage.cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: Math.max(0, usage.cost),
	};
}

/** 条目内可被替换为 contentRef 的字符串字段。 */
export function itemField(raw: RawItem, field: string): string | undefined {
	switch (raw.type) {
		case "user":
		case "system":
			return field === "text" ? raw.text : undefined;
		case "assistant":
			return field === "text" ? raw.text : field === "thinking" ? raw.thinking : undefined;
		case "tool":
			switch (field) {
				case "tool.detail":
					return raw.detail ?? undefined;
				case "tool.output":
					return raw.output ?? undefined;
				case "tool.result":
					return raw.result ?? undefined;
				case "tool.diff":
					return raw.diff ?? undefined;
				default:
					return undefined;
			}
	}
}

export function mapChatItem(raw: RawItem, owner: ProjectionOwner): MobileChatItem {
	const refs: Record<string, unknown>[] = [];
	const bounded = (field: string, value: string): string => {
		const bytes = utf8Bytes(value);
		if (bytes <= CONTENT_REF_BYTES) return value;
		refs.push({
			sessionId: owner.sessionId,
			...(owner.agentId === undefined ? {} : { agentId: owner.agentId }),
			key: raw.key,
			field,
			digest: sha256Hex(value),
			bytes,
		});
		return utf8Prefix(value, CONTENT_PREVIEW_BYTES);
	};
	const images = (list: readonly NonNullable<Extract<RawItem, { type: "user" }>["images"]>[number][] | undefined) =>
		list === undefined || list.length === 0
			? {}
			: {
					images: list.map((image) => ({
						name: image.name,
						mimeType: image.mimeType,
						width: count(image.width),
						height: count(image.height),
						bytes: count(image.bytes),
						entryId: image.entryId,
						contentIndex: image.contentIndex,
					})),
				};
	let item: Record<string, unknown>;
	switch (raw.type) {
		case "user":
			item = {
				key: raw.key,
				type: "user",
				text: bounded("text", raw.text),
				...images(raw.images),
				...(raw.skill === undefined ? {} : { skill: raw.skill.name }),
			};
			break;
		case "assistant":
			item = {
				key: raw.key,
				type: "assistant",
				text: bounded("text", raw.text),
				thinking: bounded("thinking", raw.thinking),
				...(raw.note ? { note: raw.note } : {}),
				...(raw.errorMessage ? { error: raw.errorMessage } : {}),
			};
			break;
		case "tool": {
			const tool: Record<string, unknown> = {
				callId: raw.callId,
				name: raw.name,
				summary: raw.summary,
				status: raw.phase === "done" ? (raw.isError ? "error" : "done") : "running",
			};
			for (const field of ["detail", "output", "result", "diff"] as const) {
				const value = raw[field];
				if (value !== null) tool[field] = bounded(`tool.${field}`, value);
			}
			if (raw.diffAdded !== null) tool.diffAdded = raw.diffAdded;
			if (raw.diffRemoved !== null) tool.diffRemoved = raw.diffRemoved;
			if (raw.diffTruncated !== undefined) tool.diffTruncated = raw.diffTruncated;
			if (raw.durationMs !== null) tool.durationMs = raw.durationMs;
			if (raw.note) tool.note = raw.note;
			if (raw.interaction !== undefined) tool.interaction = raw.interaction;
			if (raw.codemode !== undefined) {
				tool.codemode = {
					calls: raw.codemode.calls.map(({ durationMs, error, ...call }) => ({
						...call,
						...(durationMs === null ? {} : { durationMs }),
						...(error === null ? {} : { error }),
					})),
					omitted: raw.codemode.omitted,
					...(raw.codemode.fullOutputPath === null ? {} : { fullOutputPath: raw.codemode.fullOutputPath }),
				};
			}
			item = { key: raw.key, type: "tool", tool, ...images(raw.images) };
			break;
		}
		case "system":
			item = {
				key: raw.key,
				type: "system",
				text: bounded("text", raw.text),
				...(raw.jobId === undefined ? {} : { jobId: raw.jobId }),
			};
			break;
	}
	if (refs.length > 0) item.refs = refs;
	return item as MobileChatItem;
}

function mapRound(round: Delegation, readonlyRound: boolean) {
	const usage = (round as { roundUsage?: RawUsage | null }).roundUsage;
	return {
		taskId: round.taskId,
		callId: round.callId,
		agentId: round.agentId ?? agentIdFor(round.childId),
		...(round.round === undefined ? {} : { round: round.round }),
		role: round.role,
		title: round.title,
		status: round.status,
		approvalCount: count(round.approvalCount),
		readonly: readonlyRound || round.historyThrough !== undefined,
		createdAt: round.createdAt,
		endedAt: round.endedAt,
		...(usage ? { usage: mapUsage(usage) } : {}),
	};
}

export function mapStatus(view: ChatView, options: { readonly readonly?: boolean } = {}): Record<string, unknown> {
	const rounds = (view.rounds ?? view.subagents ?? []).map((round) => mapRound(round, options.readonly === true));
	const agents = (view.agents ?? []).map((agent) => ({
		agentId: agent.agentId,
		role: agent.role,
		title: agent.title,
		status: agent.status,
		activeRoundId: agent.activeRoundId,
		lastRoundId: agent.lastRoundId,
		roundCount: agent.roundCount,
		approvalCount: count(agent.approvalCount),
	}));
	const approvalCount =
		view.approvals !== undefined
			? view.approvals.filter((approval) => approval.status === "pending").length
			: rounds.reduce((sum, round) => sum + round.approvalCount, 0);
	const latest = view.compaction?.latest;
	return {
		busy: view.busy,
		...(view.queued === undefined
			? {}
			: {
					queued: view.queued.map(({ id, mode, preview, images }) => ({ id, mode, preview, images })),
				}),
		...(view.todos === undefined
			? {}
			: {
					todos: {
						revision: view.todos.revision,
						count: view.todos.items.length,
						completed: view.todos.items.filter((item) => item.status === "completed").length,
					},
				}),
		...(view.questions === undefined
			? {}
			: { questions: { revision: view.questions.revision, pendingCount: view.questions.pending.length } }),
		...(view.plan === undefined
			? {}
			: {
					plan: {
						revision: view.plan.revision,
						pending: view.plan.current?.status === "awaiting_approval",
						...(view.plan.current === null ? {} : { version: view.plan.current.version }),
					},
				}),
		status: view.status,
		usage: mapUsage(view.usage),
		...(view.taskUsage === undefined ? {} : { taskUsage: mapUsage(view.taskUsage) }),
		...(view.contextUsage === undefined ? {} : { contextUsage: { ...view.contextUsage } }),
		agent: {
			model: view.agent.model === null ? null : `${view.agent.model.provider}/${view.agent.model.modelId}`,
			thinkingLevel: view.agent.thinkingLevel,
		},
		subagents: rounds,
		agents,
		approvalCount,
		...(latest ? { compaction: { phase: latest.phase, at: latest.at } } : {}),
		...(options.readonly === undefined ? {} : { readonly: options.readonly }),
	};
}

type StreamingFull = { text: string; thinking: string; toolCalls: MobileStreaming["toolCalls"] };

function streamingOf(view: ChatView): StreamingFull | null {
	if (view.streaming === null) return null;
	return {
		text: view.streaming.text,
		thinking: view.streaming.thinking,
		toolCalls: view.streaming.toolCalls.map((call) => ({
			callId: call.callId,
			name: call.name,
			summary: call.summary,
			status: call.phase === "done" ? "done" : "running",
		})),
	};
}

function tailOf(value: string): { text: string; omitted: number } {
	if (value.length <= STREAMING_TAIL_CHARS) return { text: value, omitted: 0 };
	let start = value.length - STREAMING_TAIL_CHARS;
	// 不从代理对中间切开。
	const code = value.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	return { text: value.slice(start), omitted: start };
}

function boundedStreaming(full: StreamingFull | null): MobileStreaming | null {
	if (full === null) return null;
	const text = tailOf(full.text);
	const thinking = tailOf(full.thinking);
	return {
		text: text.text,
		thinking: thinking.text,
		textOmitted: text.omitted,
		thinkingOmitted: thinking.omitted,
		toolCalls: full.toolCalls,
	};
}

/** 尾部选取：≤ limit 条且整体序列化 ≤ budget，超出从旧端丢弃（至少保留一条）。 */
function tailWithinBudget(items: MobileChatItem[], limit: number, budget: number): MobileChatItem[] {
	const selected: MobileChatItem[] = [];
	let bytes = 2;
	for (let index = items.length - 1; index >= 0 && selected.length < limit; index--) {
		const item = items[index] as MobileChatItem;
		const size = jsonBytes(item) + 1;
		if (selected.length > 0 && bytes + size > budget) break;
		bytes += size;
		selected.unshift(item);
	}
	return selected;
}

/** 快照/分页除条目外的保留预算（状态、流式区与 JSON-RPC 信封）。 */
const ITEMS_BUDGET = MOBILE_LIMITS.maxPayloadBytes - 48 * 1024;
const ENTRY_CURSOR = /^entry:(\d+)(?::(.+))?$/;

export class MobileChatProjection {
	readonly subscriptionId: string;
	readonly owner: ProjectionOwner;
	private readonly source: ProjectionSource;
	private readonly readonlyView: boolean | undefined;
	private readonly onNotice: (notice: ProjectionNotice) => void;
	private readonly window = new Map<string, string>();
	private order: string[] = [];
	private seq = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private unsubscribe: (() => void) | undefined;
	private lastStatus = "";
	private sentStreaming: StreamingFull | null = null;
	private disposed = false;
	/** reset 之后等待 App 重新取快照，期间不再产生补丁。 */
	private stalled = false;

	constructor(options: {
		readonly subscriptionId: string;
		readonly owner: ProjectionOwner;
		readonly source: ProjectionSource;
		readonly readonly?: boolean;
		readonly onNotice: (notice: ProjectionNotice) => void;
	}) {
		this.subscriptionId = options.subscriptionId;
		this.owner = options.owner;
		this.source = options.source;
		this.readonlyView = options.readonly;
		this.onNotice = options.onNotice;
	}

	get view(): ChatView {
		const value = this.source.value;
		if (value === undefined) throw new Error("chat view is not ready");
		return value;
	}

	private status(view: ChatView): Record<string, unknown> {
		return mapStatus(view, this.readonlyView === undefined ? {} : { readonly: this.readonlyView });
	}

	/** 初始快照并开始订阅：状态 + 尾部窗口 + 游标 + 流式区。 */
	snapshot(): MobileChatSnapshot {
		const view = this.view;
		const all = view.items.map((item) => mapChatItem(item, this.owner));
		const tail = tailWithinBudget(all, MOBILE_LIMITS.pageItems, ITEMS_BUDGET);
		this.window.clear();
		this.stalled = false;
		const start = all.length - tail.length;
		for (let index = start; index < view.items.length; index++) {
			const raw = view.items[index] as RawItem;
			this.window.set(raw.key, digest16(JSON.stringify(raw)));
		}
		this.order = view.items.slice(start).map((item) => item.key);
		const status = this.status(view);
		this.lastStatus = JSON.stringify(status);
		this.sentStreaming = streamingOf(view);
		if (this.unsubscribe === undefined && !this.disposed)
			this.unsubscribe = this.source.subscribe(() => this.scheduleFlush());
		return {
			...status,
			items: tail,
			historyBefore: this.cursorBefore(view, start, tail[0]?.key),
			streaming: boundedStreaming(this.sentStreaming),
		};
	}

	private cursorBefore(view: ChatView, start: number, firstKey: string | undefined): string | null {
		if (start > 0 && firstKey !== undefined) return firstKey;
		if (this.source.older !== undefined && typeof view.historyBefore === "number") return `entry:${view.historyBefore}`;
		return null;
	}

	/** 向上翻页：返回游标之前（升序）最多 limit 条。视图内条目纳入窗口；更早的持久历史不会再变化。 */
	async history(before: string, limit: number = MOBILE_LIMITS.pageItems): Promise<MobileChatPage> {
		const view = this.view;
		const entry = ENTRY_CURSOR.exec(before);
		if (entry !== null) {
			if (this.source.older === undefined) throw new ProjectionError("stale_ref", "history cursor is not valid here");
			const page = await this.source.older(Number(entry[1]));
			let raws = [...page.items];
			const anchor = entry[2];
			if (anchor !== undefined) {
				const index = raws.findIndex((item) => item.key === anchor);
				if (index === -1) throw new ProjectionError("stale_ref", "history cursor no longer exists");
				raws = raws.slice(0, index);
			}
			const items = tailWithinBudget(
				raws.map((item) => mapChatItem(item, this.owner)),
				limit,
				ITEMS_BUDGET,
			);
			const start = raws.length - items.length;
			const historyBefore =
				start > 0 ? `entry:${entry[1]}:${items[0]?.key ?? ""}` : page.next === null ? null : `entry:${page.next}`;
			return { items, historyBefore };
		}
		const index = view.items.findIndex((item) => item.key === before);
		if (index === -1) throw new ProjectionError("stale_ref", "history cursor no longer exists");
		const candidates = view.items.slice(0, index);
		const items = tailWithinBudget(
			candidates.map((item) => mapChatItem(item, this.owner)),
			limit,
			ITEMS_BUDGET,
		);
		const start = candidates.length - items.length;
		for (let at = start; at < index; at++) {
			const raw = view.items[at] as RawItem;
			this.window.set(raw.key, digest16(JSON.stringify(raw)));
		}
		this.order = view.items.filter((item) => this.window.has(item.key)).map((item) => item.key);
		return { items, historyBefore: this.cursorBefore(view, start, items[0]?.key) };
	}

	/** 读取大字段的一个分块；digest 不符表示内容已变化。 */
	content(ref: { key: string; field: string; digest: string }, offset: number): { bytes: Buffer; total: number } {
		const raw = this.view.items.find((item) => item.key === ref.key);
		const value = raw === undefined ? undefined : itemField(raw, ref.field);
		if (value === undefined) throw new ProjectionError("content_changed", "content is no longer available");
		if (sha256Hex(value) !== ref.digest) throw new ProjectionError("content_changed", "content changed");
		const bytes = Buffer.from(value, "utf8");
		if (offset > bytes.length) throw new ProjectionError("invalid_params", "offset out of range");
		return { bytes: bytes.subarray(offset, offset + MOBILE_LIMITS.chunkBytes), total: bytes.length };
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private scheduleFlush(): void {
		if (this.timer !== undefined || this.disposed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, MERGE_MS);
	}

	private reset(view: ChatView): void {
		this.window.clear();
		this.order = [];
		this.lastStatus = JSON.stringify(this.status(view));
		this.sentStreaming = streamingOf(view);
		this.stalled = true;
		this.seq += 1;
		this.onNotice({ kind: "reset", params: { seq: this.seq } });
	}

	/** 立即计算一次增量（测试与合并定时器共用）。 */
	flush(): void {
		if (this.disposed || this.stalled || this.unsubscribe === undefined) return;
		const view = this.source.value;
		if (view === undefined) return;
		const positions = new Map(view.items.map((item, index) => [item.key, index]));

		// 窗口条目消失：子 agent 滚动视图只从前端移出时静默收缩，否则 reset。
		const missing = this.order.filter((key) => !positions.has(key));
		if (missing.length > 0) {
			const prefixOnly = this.source.older !== undefined && missing.every((key, index) => this.order[index] === key);
			if (!prefixOnly) {
				this.reset(view);
				return;
			}
			for (const key of missing) this.window.delete(key);
			this.order = this.order.slice(missing.length);
		}
		// 顺序改变或在已加载区间中插入新条目 → reset。
		const present = this.order.map((key) => positions.get(key) as number);
		for (let index = 1; index < present.length; index++) {
			if ((present[index] as number) <= (present[index - 1] as number)) {
				this.reset(view);
				return;
			}
		}
		const first = present[0];
		const last = present.at(-1);
		if (first !== undefined && last !== undefined && last - first + 1 !== present.length) {
			this.reset(view);
			return;
		}

		const upserts: MobileChatItem[] = [];
		const startNew = last === undefined ? 0 : last + 1;
		for (const key of this.order) {
			const raw = view.items[positions.get(key) as number] as RawItem;
			const digest = digest16(JSON.stringify(raw));
			if (digest === this.window.get(key)) continue;
			this.window.set(key, digest);
			upserts.push(mapChatItem(raw, this.owner));
		}
		for (let index = startNew; index < view.items.length; index++) {
			const raw = view.items[index] as RawItem;
			this.window.set(raw.key, digest16(JSON.stringify(raw)));
			this.order.push(raw.key);
			upserts.push(mapChatItem(raw, this.owner));
		}

		const params: Record<string, unknown> = { upserts };
		const status = this.status(view);
		const statusJson = JSON.stringify(status);
		if (statusJson !== this.lastStatus) params.status = status;
		this.lastStatus = statusJson;

		const streaming = streamingOf(view);
		const previous = this.sentStreaming;
		if (streaming === null || previous === null) {
			if (streaming !== previous) params.streaming = boundedStreaming(streaming);
		} else if (
			streaming.text.startsWith(previous.text) &&
			streaming.thinking.startsWith(previous.thinking) &&
			JSON.stringify(streaming.toolCalls) === JSON.stringify(previous.toolCalls)
		) {
			const text = streaming.text.slice(previous.text.length);
			const thinking = streaming.thinking.slice(previous.thinking.length);
			if (text !== "" || thinking !== "") {
				params.streamingAppend = { ...(text === "" ? {} : { text }), ...(thinking === "" ? {} : { thinking }) };
			}
		} else {
			params.streaming = boundedStreaming(streaming);
		}
		this.sentStreaming = streaming;

		if (upserts.length === 0 && !("status" in params) && !("streaming" in params) && !("streamingAppend" in params))
			return;
		this.seq += 1;
		params.seq = this.seq;
		// 单个补丁超出 payload 上限时退化为 reset，由 App 重新取有界快照。
		if (jsonBytes(params) > MOBILE_LIMITS.maxPayloadBytes - 1024) {
			this.reset(view);
			return;
		}
		this.onNotice({ kind: "patch", params });
	}
}
