import type { AssistantMessage, ModelThinkingLevel, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState, ToolDiagnostic, ToolSlot, UsageState } from "@earendil-works/pi-durable";
import type { CompactionRecord } from "./compaction.ts";
import type { ChangeSummary } from "./file-changes.ts";
import type { ImageMetadata } from "./image-metadata.ts";
import { type DefaultImagePrompt, savedDefaultImagePrompt } from "./image-prompt.ts";
import type { ImageInfo } from "./images.ts";
import { type InputData, NekoInput } from "./input.ts";
import type { PlanView, QuestionList, TodoList } from "./interactions.ts";
import type { JobSummary } from "./jobs.ts";
import { projectQueued, type QueuedInput } from "./queued.ts";
import type { NekoModelInfo, NekoModelRef } from "./runtime.ts";
import type { SkillInvocation } from "./skill-invocation.ts";
import type { Delegation, SubagentSummary } from "./subagents.ts";
import type { ToolApproval } from "./tool-approvals.ts";
import { savedWorkspace } from "./workspace.ts";

/**
 * ConversationView → 前端投影 ChatView（每次 commit 后重算，v1 全量快照）。
 *
 * 该投影由 gateway 与 web 共用：gateway 把每个会话的 viewState 投影成 ChatView 复制状态推给
 * 前端订阅，web 的进程内 WS 服务器走同一函数（见 design D4）。
 */

/** 一次提交的用量合计（pi.usage 汇总）。 */
export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 美元计价合计。 */
	cost: number;
};

/** 前端渲染所需的会话视图投影。 */
export type ChatView = {
	historyBefore?: number | null;
	approvals?: ToolApproval[];
	subagents?: Delegation[];
	agents?: SubagentSummary[];
	/** Absent on a gateway without background jobs. */
	jobs?: JobSummary[];
	/** User inputs waiting in the inbox, in acceptance order; absent on a gateway without queue visibility. */
	queued?: QueuedInput[];
	/** The model-maintained todo list; absent on a gateway without todos, empty items when supported with none. */
	todos?: TodoList;
	/** Summary of the files agents changed through edit/write; absent on a gateway without it, empty when supported with none. */
	changes?: ChangeSummary;
	/** Questions waiting for the user (bounded summaries); absent on a gateway without ask_user. */
	questions?: QuestionList;
	/** Plan mode and the newest plan; absent on a gateway without plan mode. */
	plan?: PlanView;
	rounds?: Delegation[];
	taskUsage?: UsageTotals;
	/** Latest successful answer in the active context; unknown after compaction until a new answer. */
	contextUsage?: { tokens: number | null; window: number; percent: number | null };
	compaction?: {
		active: (Omit<NonNullable<LiveState["compactions"]>[number], "taskId"> & { taskId: number })[];
		latest: CompactionRecord | null;
		failure?: Omit<NonNullable<LiveState["compactionFailure"]>, "taskId"> & { taskId: number };
	};
	/** 模型标签，如 "deepseek/deepseek-flash"；pi.agent 有显式模型时取自它（切换后立即更新）。 */
	model: string;
	/** 当前会话生效的代理配置（pi.agent doc 投影，configure 提交后随视图推送更新）。 */
	agent: {
		/** 生效模型（provider/modelId）；未设置时为 null。 */
		model: NekoModelRef | null;
		thinkingLevel: ModelThinkingLevel | null;
	};
	/** 会话工具的工作目录。 */
	cwd: string;
	/** 是否有运行中的 run（live.run !== undefined）。 */
	busy: boolean;
	/** 忙碌状态描述（思考中… / 运行 bash… / 重试中…）；不忙为 null。 */
	status: string | null;
	usage: UsageTotals;
	/** 已提交的转录条目（含系统行与工具卡片），按序渲染。 */
	items: ChatItem[];
	/** 正在生成的内容（live.generation）；无则为 null。 */
	streaming: StreamingView | null;
};

/** 已提交条目投影；`key` 是稳定的 React key。 */
export type ChatImage = ImageInfo & { entryId: number; contentIndex: number };
export type ChatItem = { order?: number } & (
	| {
			type: "user";
			key: string;
			id: number;
			text: string;
			images?: ChatImage[];
			skill?: SkillInvocation;
			defaultImagePrompt?: DefaultImagePrompt;
			subagentRoundId?: number;
	  }
	| {
			type: "assistant";
			key: string;
			id: number;
			/** thinking blocks 合并文本；无则为 ""。 */
			thinking: string;
			text: string;
			stopReason: string | null;
			errorMessage: string | null;
			/** 回答被中断/出错时的提示行；无则为 null。 */
			note: string | null;
	  }
	| {
			type: "tool";
			key: string;
			images?: ChatImage[];
			callId: string;
			name: string;
			/** 单行参数摘要。 */
			summary: string;
			/** 参数详情（多行）；无则为 null。 */
			detail: string | null;
			/** pending=待结果; running=有 pi.live 运行输出; done=已有结果。 */
			phase: "pending" | "running" | "done";
			isError: boolean;
			/** 运行中的部分输出（pi.live ToolSlot.output）。 */
			output: string | null;
			/** 最终结果文本（pi.tool-result entry）。 */
			result: string | null;
			durationMs: number | null;
			/** 补充说明（如"Not run: response interrupted."）；无则为 null。 */
			note: string | null;
			/** 展示型 diff（edit 透传上游 details.diff；write 由参数 content 合成全新增）；无则为 null。 */
			diff: string | null;
			/** diff 新增行数；无 diff 时为 null。 */
			diffAdded: number | null;
			/** diff 删除行数；无 diff 时为 null。 */
			diffRemoved: number | null;
			/** write diff 因行数或字节预算截断；缺省为 false。 */
			diffTruncated?: boolean;
			/** Structured state of `todo` / `ask_user` calls, from the persisted tool details; never parsed from text. */
			interaction?: ToolInteraction;
	  }
	| {
			type: "system";
			key: string;
			id: number;
			text: string;
			jobId?: string;
			/** Set on the record of a plan decision (approved / changes requested). */
			planDecision?: { version: string; kind: "approve" | "revise" };
	  }
);

/** What a todo or ask_user call shows in history: its question and settlement, or its resulting list progress. */
export type ToolInteraction =
	| {
			kind: "ask_user";
			id: number;
			question: string;
			multiple: boolean;
			options: { id: string; label: string; recommended?: boolean }[];
			status: "pending" | "answered" | "skipped" | "cancelled";
			optionIds?: string[];
			labels?: string[];
			text?: string | null;
	  }
	| { kind: "todo"; action: "list" | "replace"; revision: number; completed: number; total: number }
	| { kind: "submit_plan"; version: string; title: string; steps: string[]; note: string };

/** 正在生成的一轮（live.generation.message + live.tools 的合并投影）。 */
export type StreamingView = {
	thinking: string;
	text: string;
	toolCalls: StreamingToolCall[];
};

export type StreamingToolCall = {
	callId: string;
	name: string;
	summary: string;
	detail: string | null;
	/** pending=排队; running=正在执行（可能有 output）; done=槽位已结束。 */
	phase: "pending" | "running" | "done";
	output: string | null;
	/** 同 ChatItem tool 条目：write 由参数合成，其余为 null。 */
	diff: string | null;
	diffAdded: number | null;
	diffRemoved: number | null;
	diffTruncated?: boolean;
};

export type ToolSummary = {
	/** 参数摘要，单行。 */
	readonly args: string;
	/** 参数展开详情（可选多行）。 */
	readonly detail?: string;
};

/** UserMessage.content -> 纯文本。 */
export function userText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** 单行截断（截断点加 "…"）。 */
export function truncateMiddle(text: string, maxWidth: number): string {
	if (text.length <= maxWidth) return text;
	if (maxWidth <= 1) return "…";
	const half = Math.floor((maxWidth - 1) / 2);
	return `${text.slice(0, half)}…${text.slice(text.length - (maxWidth - 1 - half))}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;

/** Read the structured `details` of a todo / ask_user result defensively; anything unexpected yields `undefined`. */
export function toolInteraction(name: string, details: unknown): ToolInteraction | undefined {
	if (!isRecord(details)) return undefined;
	if (name === "todo") {
		const { action, revision, completed, total } = details;
		return (action === "list" || action === "replace") &&
			typeof revision === "number" &&
			typeof completed === "number" &&
			typeof total === "number"
			? { kind: "todo", action, revision, completed, total }
			: undefined;
	}
	if (name === "submit_plan") {
		const { version, title, note } = details;
		const steps = strings(details.steps);
		return typeof version === "string" && typeof title === "string" && typeof note === "string" && steps
			? { kind: "submit_plan", version, title, steps, note }
			: undefined;
	}
	if (name !== "ask_user") return undefined;
	const { id, question, multiple, options, status } = details;
	if (
		typeof id !== "number" ||
		typeof question !== "string" ||
		typeof multiple !== "boolean" ||
		!Array.isArray(options) ||
		(status !== "pending" && status !== "answered" && status !== "skipped" && status !== "cancelled")
	)
		return undefined;
	const optionList = options.flatMap((o) =>
		isRecord(o) && typeof o.id === "string" && typeof o.label === "string"
			? [{ id: o.id, label: o.label, ...(o.recommended === true ? { recommended: true } : {}) }]
			: [],
	);
	const optionIds = strings(details.optionIds);
	const labels = strings(details.labels);
	return {
		kind: "ask_user",
		id,
		question,
		multiple,
		options: optionList,
		status,
		...(optionIds ? { optionIds } : {}),
		...(labels ? { labels } : {}),
		...(typeof details.text === "string" || details.text === null ? { text: details.text as string | null } : {}),
	};
}

const interactionField = (name: string, details: unknown): { interaction?: ToolInteraction } => {
	const interaction = toolInteraction(name, details);
	return interaction ? { interaction } : {};
};

/** 内置工具的参数摘要；未知工具退回 JSON。 */
export function summarizeToolCall(name: string, args: unknown): ToolSummary {
	const record = (args ?? {}) as Record<string, unknown>;
	switch (name) {
		case "todo": {
			const items = Array.isArray(record.items) ? record.items : [];
			const lines = items.flatMap((item) => {
				if (!isRecord(item)) return [];
				const mark = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
				return [`${mark} ${String(item.id)}: ${String(item.text)}`];
			});
			return record.action === "replace"
				? { args: `Update todos (${items.length} items)`, detail: lines.join("\n") }
				: { args: "Read todos" };
		}
		case "ask_user": {
			const question = typeof record.question === "string" ? record.question : "";
			const options = Array.isArray(record.options) ? record.options : [];
			const lines = options.flatMap((o) =>
				isRecord(o) ? [`- ${String(o.label)}${o.recommended === true ? " (recommended)" : ""}`] : [],
			);
			return {
				args: truncateMiddle(question.replace(/\s+/g, " "), 100),
				detail: [question, ...(lines.length ? ["", ...lines] : [])].join("\n"),
			};
		}
		case "submit_plan": {
			const steps = strings(record.steps) ?? [];
			return {
				args: truncateMiddle(String(record.title ?? "").replace(/\s+/g, " "), 100),
				detail: steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
			};
		}
		case "subagent":
			return {
				args: record.action === "list" ? "List agents" : `${record.agentId ?? record.type}: ${record.title}`,
				detail: String(record.task ?? ""),
			};
		case "find_files":
		case "search_text":
			return {
				args: truncateMiddle(`${record.path ?? "."} ${record.pattern ?? record.query ?? ""}`, 100),
				detail: JSON.stringify(args, null, 2),
			};
		case "bash": {
			const command = typeof record.command === "string" ? record.command : "";
			const firstLine = command.split("\n", 1)[0] ?? "";
			return { args: truncateMiddle(firstLine, 100), detail: command };
		}
		case "write": {
			const path = typeof record.path === "string" ? record.path : "";
			const content = typeof record.content === "string" ? record.content : "";
			return { args: truncateMiddle(path, 100), detail: `${path}\n${content}` };
		}
		case "edit": {
			const path = typeof record.path === "string" ? record.path : "";
			const edits = Array.isArray(record.edits) ? record.edits.length : 0;
			return { args: `${truncateMiddle(path, 88)} (${edits} edits)` };
		}
		case "read": {
			const path = typeof record.path === "string" ? record.path : "";
			const offset = typeof record.offset === "number" ? ` offset ${record.offset}` : "";
			const limit = typeof record.limit === "number" ? ` limit ${record.limit}` : "";
			return { args: truncateMiddle(`${path}${offset}${limit}`, 100) };
		}
		default: {
			const json = JSON.stringify(record) ?? "";
			return { args: truncateMiddle(json, 100), detail: json };
		}
	}
}

/** 工具结果内容的纯文本（text blocks 拼接）。 */
export function toolResultText(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** write 合成 diff 的行数与 UTF-8 字节上限（计数按完整展示行统计）。 */
const WRITE_DIFF_MAX_LINES = 2000;
const WRITE_DIFF_MAX_BYTES = 64 * 1024;

/** 从展示型 diff 统计增删行（以 +/- 前缀计，排除 +++ / --- 头）。 */
export function countDiffLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** edit 工具结果 details 的展示型 diff；结构不符/缺失回退 null，不抛错。 */
export function editResultDiff(details: unknown): string | null {
	if (typeof details !== "object" || details === null) return null;
	const diff = (details as { diff?: unknown }).diff;
	return typeof diff === "string" ? diff : null;
}

/** write 工具调用参数合成的全新增 diff（逐行 "+ " 前缀）；content 非字符串时回退 null。 */
export function synthesizedWriteDiff(
	args: unknown,
): { diff: string; added: number; removed: number; truncated: boolean } | null {
	const record = (args ?? {}) as Record<string, unknown>;
	if (typeof record.content !== "string") return null;
	const content = record.content;
	const shown: string[] = [];
	let offset = 0;
	let bytes = 0;
	while (offset < content.length && shown.length < WRITE_DIFF_MAX_LINES) {
		const newline = content.indexOf("\n", offset);
		const end = newline === -1 ? content.length : newline;
		const overhead = shown.length === 0 ? 2 : 3; // "+ " + 行间换行。
		const remaining = WRITE_DIFF_MAX_BYTES - bytes - overhead;
		// UTF-8 字节数至少为 UTF-16 长度，先排除巨行，避免复制整行。
		if (end - offset > remaining) break;
		const line = content.slice(offset, end);
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (lineBytes > remaining) break;
		shown.push(`+ ${line}`);
		bytes += lineBytes + overhead;
		offset = newline === -1 ? content.length : end + 1;
	}
	return { diff: shown.join("\n"), added: shown.length, removed: 0, truncated: offset < content.length };
}

/** 汇总 pi.usage 的模型与工具用量。 */
export function totalUsage(state: UsageState): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.total += usage.cost.total;
	}
	return total;
}

/** pi.agent doc 在 ConversationView.docs 里的 JSON 形状（AgentState 的视图表示）。 */
type AgentDocView = {
	readonly cwd?: string;
	readonly model?: NekoModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
};

/** ConversationView → 前端投影 ChatView（服务器每次 commit 后调用）。 */
export function projectChatView(
	view: ConversationView,
	modelLabel: string,
	options: {
		models?: readonly NekoModelInfo[];
		contextEntries?: ConversationView["entries"];
		compaction?: CompactionRecord | null;
	} = {},
): ChatView {
	const live = (view.docs["pi.live"] ?? {}) as LiveState;
	const usage = totalUsage((view.docs["pi.usage"] ?? { models: {}, tools: {} }) as UsageState);
	// pi.agent 随每次 configure 提交进视图：投影同步读出生效模型/thinkingLevel，无竞态。
	const agent = view.docs["pi.agent"] as AgentDocView | undefined;
	const agentModel = agent?.model ?? null;

	const contextWindow =
		options.models?.find(
			(m) =>
				`${m.provider}/${m.modelId}` === (agentModel ? `${agentModel.provider}/${agentModel.modelId}` : modelLabel),
		)?.contextWindow ?? 0;
	const tokens = contextTokens(options.contextEntries ?? view.entries);

	// 先按 callId 收集工具结果（pi.tool-result entry），再按序展开条目。
	const results = new Map<string, Extract<ChatItem, { type: "tool" }>>();
	for (const entry of view.entries) {
		for (const message of entry.model ?? []) {
			if (message.role !== "toolResult") continue;
			const diagnostics = (entry.data as { diagnostics?: ToolDiagnostic[] } | undefined)?.diagnostics ?? [];
			const diff = message.toolName === "edit" ? editResultDiff(message.details) : null;
			const counts = diff === null ? null : countDiffLines(diff);
			results.set(message.toolCallId, {
				type: "tool",
				key: `t${message.toolCallId}`,
				callId: message.toolCallId,
				name: message.toolName,
				summary: "",
				detail: null,
				phase: "done",
				isError: message.isError,
				output: null,
				result: [
					toolResultText(diagnostics.length ? message.content.slice(0, -1) : message.content),
					...diagnostics.map((d) => `[${d.severity}] ${d.message}`),
				]
					.filter(Boolean)
					.join("\n"),
				durationMs: message.durationMs ?? null,
				note: null,
				diff,
				diffAdded: counts?.added ?? null,
				diffRemoved: counts?.removed ?? null,
				...interactionField(message.toolName, message.details),
			});
		}
	}

	const imageDescriptors = (
		entryId: number,
		content: UserMessage["content"],
		metadata: readonly ImageMetadata[] = [],
	): ChatImage[] => {
		if (typeof content === "string") return [];
		return content.flatMap((b, contentIndex) =>
			b.type !== "image"
				? []
				: [
						{
							entryId,
							contentIndex,
							...(metadata.find((info) => info.contentIndex === contentIndex) ?? {
								name: "Image",
								mimeType: b.mimeType,
								width: 0,
								height: 0,
								bytes: Math.floor((b.data.length * 3) / 4),
							}),
						},
					],
		);
	};
	for (const entry of view.entries)
		for (const message of entry.model ?? [])
			if (message.role === "toolResult") {
				const item = results.get(message.toolCallId);
				if (item)
					item.images = imageDescriptors(
						entry.id,
						message.content,
						(message.details as { neko?: { images?: ImageMetadata[] } } | undefined)?.neko?.images,
					);
			}
	const items: ChatItem[] = [];
	for (const entry of view.entries) {
		const message = entry.model?.[0];
		const jobReport = entry.kind === NekoInput.kind ? (entry.data as InputData | undefined)?.jobReport : undefined;
		const planDecision =
			entry.kind === NekoInput.kind ? (entry.data as InputData | undefined)?.planDecision : undefined;
		if (message?.role === "user" && planDecision) {
			items.push({
				type: "system",
				key: `e${entry.id}`,
				id: entry.id,
				text:
					planDecision.kind === "approve"
						? `Plan approved: ${planDecision.title}`
						: `Changes requested for plan "${planDecision.title}": ${planDecision.feedback ?? ""}`,
				planDecision: { version: planDecision.version, kind: planDecision.kind },
			});
			continue;
		}
		if (message?.role === "user" && jobReport) {
			// A background job report is a system notice, not something the user typed.
			items.push({
				type: "system",
				key: `e${entry.id}`,
				id: entry.id,
				text: userText(message.content),
				jobId: jobReport.jobId,
			});
			continue;
		}
		if (message?.role === "user") {
			const defaultImagePrompt =
				entry.kind === NekoInput.kind
					? savedDefaultImagePrompt(message.content, (entry.data as InputData | undefined)?.defaultImagePrompt)
					: undefined;
			items.push({
				type: "user",
				...((entry.data as InputData | undefined)?.subagentRoundId
					? { subagentRoundId: (entry.data as InputData).subagentRoundId! }
					: {}),
				key: `e${entry.id}`,
				id: entry.id,
				text:
					defaultImagePrompt && Array.isArray(message.content)
						? userText(message.content.slice(1))
						: userText(message.content),
				...(defaultImagePrompt ? { defaultImagePrompt } : {}),
				images: imageDescriptors(entry.id, message.content, (entry.data as InputData | undefined)?.images),
				...((entry.data as InputData | undefined)?.skill ? { skill: (entry.data as InputData).skill! } : {}),
			});
			continue;
		}
		if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const assistant = message as AssistantMessage;
			items.push(assistantItem(assistant, entry.id));
			// 以 toolUse 结束的回答才会真正执行工具；其余只保留已流式展示过的卡片（note 标记未运行）。
			const ran = assistant.stopReason === "toolUse";
			for (const block of assistant.content) {
				if (block.type !== "toolCall") continue;
				const result = results.get(block.id);
				if (result !== undefined) {
					items.push(withArgs(result, block.name, block.arguments));
				} else {
					const summary = summarizeToolCall(block.name, block.arguments);
					const slot = live.tools?.find((s) => s.callId === block.id);
					const synthesized = block.name === "write" ? synthesizedWriteDiff(block.arguments) : null;
					items.push({
						type: "tool",
						key: `t${block.id}`,
						callId: block.id,
						name: block.name,
						summary: summary.args,
						detail: summary.detail ?? null,
						phase: slot?.status ?? "done",
						isError: false,
						output: slot?.output ?? null,
						result: null,
						durationMs: null,
						note: ran ? null : "Not run: response interrupted.",
						diff: synthesized?.diff ?? null,
						diffAdded: synthesized?.added ?? null,
						diffRemoved: synthesized?.removed ?? null,
						diffTruncated: synthesized?.truncated ?? false,
						...interactionField(block.name, (slot as { details?: unknown } | undefined)?.details),
					});
				}
			}
			continue;
		}
		if (entry.kind === "pi.tool-result") continue; // 已合入对应工具卡片
		if (entry.kind === "pi.compaction") {
			items.push({ type: "system", key: `e${entry.id}`, id: entry.id, text: "[context compacted]" });
		} else if (entry.kind === "pi.reset") {
			items.push({ type: "system", key: `e${entry.id}`, id: entry.id, text: "[new context]" });
		}
	}

	const runningTool = live.tools?.find((slot) => slot.status === "running");
	const status =
		live.run === undefined
			? null
			: live.generation?.retry !== undefined
				? `Retrying (attempt ${live.generation.attempt + 1})...`
				: runningTool !== undefined
					? `Running ${runningTool.name}...`
					: "Thinking...";

	return {
		contextUsage: {
			tokens,
			window: contextWindow,
			percent: tokens !== null && contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
		},
		compaction: {
			active: [...(live.compactions ?? [])],
			latest: options.compaction ?? null,
			...(live.compactionFailure ? { failure: live.compactionFailure } : {}),
		},
		model: agentModel !== null ? `${agentModel.provider}/${agentModel.modelId}` : modelLabel,
		agent: {
			model: agentModel,
			thinkingLevel: agent?.thinkingLevel ?? "off",
		},
		cwd: savedWorkspace(agent?.cwd),
		busy: live.run !== undefined,
		queued: projectQueued(view),
		status,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost.total,
		},
		items,
		streaming: projectStreaming(live),
	};
}

function withArgs(item: Extract<ChatItem, { type: "tool" }>, name: string, args: unknown): ChatItem {
	const summary = summarizeToolCall(name, args);
	// write 的 diff 只依赖参数（无上游 details），在拿到 toolCall 参数时合成；edit 已在收集结果时透传。
	const synthesized = name === "write" ? synthesizedWriteDiff(args) : null;
	return {
		...item,
		name,
		summary: summary.args,
		detail: summary.detail ?? null,
		diff: synthesized?.diff ?? item.diff,
		diffAdded: synthesized?.added ?? item.diffAdded,
		diffRemoved: synthesized?.removed ?? item.diffRemoved,
		diffTruncated: synthesized?.truncated ?? false,
	};
}

function assistantItem(message: AssistantMessage, id: number): Extract<ChatItem, { type: "assistant" }> {
	let thinking = "";
	let text = "";
	for (const block of message.content) {
		if (block.type === "thinking" && block.thinking.trim() !== "") {
			thinking = thinking === "" ? block.thinking : `${thinking}\n\n${block.thinking}`;
		}
		if (block.type === "text" && block.text.trim() !== "") {
			text = text === "" ? block.text : `${text}\n\n${block.text}`;
		}
	}
	const hasToolCalls = message.content.some((block) => block.type === "toolCall");
	const note =
		message.stopReason === "length"
			? "Response truncated before completion."
			: !hasToolCalls && message.stopReason === "aborted"
				? "Stopped."
				: !hasToolCalls && message.stopReason === "error"
					? `Error: ${message.errorMessage ?? "Unknown error"}`
					: null;
	return {
		type: "assistant",
		key: `e${id}`,
		id,
		thinking,
		text,
		stopReason: message.stopReason ?? null,
		errorMessage: message.errorMessage ?? null,
		note,
	};
}

function projectStreaming(live: LiveState): StreamingView | null {
	const message = live.generation?.message as AssistantMessage | undefined;
	if (message === undefined) return null;
	let thinking = "";
	let text = "";
	const toolCalls: StreamingToolCall[] = [];
	for (const block of message.content) {
		if (block.type === "thinking" && block.thinking.trim() !== "") {
			thinking = thinking === "" ? block.thinking : `${thinking}\n\n${block.thinking}`;
			continue;
		}
		if (block.type === "text" && block.text.trim() !== "") {
			text = text === "" ? block.text : `${text}\n\n${block.text}`;
			continue;
		}
		if (block.type === "toolCall") {
			const slot = live.tools?.find((candidate) => candidate.callId === block.id) as ToolSlot | undefined;
			const summary = summarizeToolCall(block.name, block.arguments);
			const synthesized = block.name === "write" ? synthesizedWriteDiff(block.arguments) : null;
			toolCalls.push({
				callId: block.id,
				name: block.name,
				summary: summary.args,
				detail: summary.detail ?? null,
				phase: slot === undefined || slot.status === "pending" ? "pending" : slot.status,
				output: slot?.status === "running" ? (slot.output ?? null) : null,
				diff: synthesized?.diff ?? null,
				diffAdded: synthesized?.added ?? null,
				diffRemoved: synthesized?.removed ?? null,
				diffTruncated: synthesized?.truncated ?? false,
			});
		}
	}
	return { thinking, text, toolCalls };
}

/** Match Pi durable's footer: use the latest successful answer after the newest compaction. */
export function contextTokens(entries: ConversationView["entries"]): number | null {
	const compacted = entries.reduce((id, entry) => (entry.kind === "pi.compaction" ? Math.max(id, entry.id) : id), 0);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		const message = entry.model?.[0];
		if (entry.id < compacted || entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return null;
}
