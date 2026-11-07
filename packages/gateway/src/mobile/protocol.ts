import {
	arr,
	bool,
	compile,
	int,
	lit,
	nul,
	num,
	obj,
	opt,
	type Schema,
	type Static,
	str,
	union,
	type Validator,
} from "@earendil-works/pi-schema";
import { RUNNING_VERSION } from "@neko-harness/core/application-version";
import { CODEMODE_VIEW_LIMITS } from "@neko-harness/core/codemode-mode";
import { PLAN_LIMITS, QUESTION_LIMITS, TODO_LIMITS } from "@neko-harness/core/interactions";

export const MOBILE_LIMITS = {
	maxFrameBytes: 262_144,
	maxPayloadBytes: 131_072,
	pageItems: 50,
	chunkBytes: 65_536,
	maxConcurrentRequests: 8,
	maxSendBufferBytes: 2_097_152,
} as const;

export const MOBILE_API_VERSIONS: readonly number[] = [1];
/** 能力随实现追加；命名以 design D6 为准。 */
export const MOBILE_CAPABILITIES: readonly string[] = [
	"workspaces",
	"sessions",
	"chat",
	"subagents",
	"approvals",
	"media",
	"todos",
	"questions",
	"plan",
];
export const MOBILE_CLOSE_REVOKED = 4401;
export const MOBILE_CLOSE_INCOMPATIBLE = 4402;
export const MOBILE_CLOSE_SLOW_CONSUMER = 4408;

export const MobileHelloParams = obj(
	{
		apiVersions: arr(int(), { minItems: 1 }),
		app: obj(
			{
				version: str({ minLength: 1, maxLength: 64 }),
				platform: str({ minLength: 1, maxLength: 64 }),
				build: str({ maxLength: 128 }),
			},
			{ open: true },
		),
	},
	{ open: true },
);

export type MobileHelloParamsType = Static<typeof MobileHelloParams>;

export type JsonRpcId = number | string;

export type JsonRpcRequest = {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly method: string;
	readonly params?: unknown;
};

export function asJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.jsonrpc !== "2.0") return undefined;
	if (typeof record.id !== "string" && typeof record.id !== "number") return undefined;
	if (typeof record.method !== "string" || record.method === "") return undefined;
	return { jsonrpc: "2.0", id: record.id, method: record.method, params: record.params };
}

export type MobileErrorCode =
	| "unauthorized"
	| "revoked"
	| "incompatible"
	| "invalid_params"
	| "not_found"
	| "gone"
	| "stale_ref"
	| "content_changed"
	| "busy_limit"
	| "rejected"
	| "internal";

const validators = new WeakMap<object, Validator<unknown>>();

/** Validates `value` against a mobile protocol schema, compiling each schema once. */
export function checkSchema(schema: Schema, value: unknown): boolean {
	let validator = validators.get(schema);
	if (!validator) {
		validator = compile(schema as Schema<unknown>);
		validators.set(schema, validator);
	}
	return validator.check(value);
}

const helloParams = compile(MobileHelloParams);
export function isMobileHelloParams(value: unknown): value is MobileHelloParamsType {
	return helloParams.check(value);
}

export function negotiateApiVersion(clientVersions: readonly number[]): number | undefined {
	let best: number | undefined;
	for (const version of MOBILE_API_VERSIONS) {
		if (clientVersions.includes(version) && (best === undefined || version > best)) best = version;
	}
	return best;
}

export function incompatibleNeeds(clientVersions: readonly number[]): "app" | "computer" {
	const serverMax = Math.max(...MOBILE_API_VERSIONS);
	return clientVersions.length > 0 && clientVersions.every((version) => version > serverMax) ? "computer" : "app";
}

export function buildHelloResult(serverId: string, serverName: string, apiVersion: number): Record<string, unknown> {
	return {
		apiVersion,
		serverId,
		serverName,
		gatewayVersion: RUNNING_VERSION,
		capabilities: MOBILE_CAPABILITIES,
		limits: MOBILE_LIMITS,
	};
}

// ——— mobile-api-v1 业务方法 schemas（fixtures 契约锚点；形状与 docs/mobile/api-v1.md 一致） ———

const text = str();
const count = int({ minimum: 0 });
const nullable = <T>(schema: Schema<T>) => union([schema, nul()]);

/** 大字段引用：`agentId` 存在时指向子 agent 视图，否则指向主会话。 */
export const MobileContentRefSchema = obj(
	{
		sessionId: text,
		agentId: opt(text),
		key: text,
		field: text,
		digest: text,
		bytes: count,
	},
	{ open: true },
);

export const MobileImageRefSchema = obj(
	{
		name: text,
		mimeType: text,
		width: count,
		height: count,
		bytes: count,
		entryId: count,
		contentIndex: count,
	},
	{ open: true },
);

const planStatus = union([
	lit("awaiting_approval"),
	lit("approved"),
	lit("revision_requested"),
	lit("superseded"),
	lit("cancelled"),
]);

const questionStatus = union([lit("pending"), lit("answered"), lit("skipped"), lit("cancelled")]);

/** Structured state of a todo / ask_user call in history; present only for those tools. */
export const MobileToolInteractionSchema = union([
	obj(
		{
			kind: lit("ask_user"),
			id: count,
			question: text,
			multiple: bool(),
			options: arr(obj({ id: text, label: text, recommended: opt(bool()) }, { open: true })),
			status: questionStatus,
			optionIds: opt(arr(text)),
			labels: opt(arr(text)),
			text: opt(nullable(text)),
		},
		{ open: true },
	),
	obj(
		{
			kind: lit("todo"),
			action: union([lit("list"), lit("replace")]),
			revision: count,
			completed: count,
			total: count,
		},
		{ open: true },
	),
	obj(
		{
			kind: lit("submit_plan"),
			version: text,
			title: text,
			steps: arr(text),
			note: text,
		},
		{ open: true },
	),
]);

export const MobileCodemodeSchema = obj(
	{
		calls: arr(
			obj(
				{
					id: count,
					name: text,
					args: str({ maxLength: CODEMODE_VIEW_LIMITS.argsChars }),
					status: union([lit("running"), lit("ok"), lit("error"), lit("cancelled")]),
					durationMs: opt(num()),
					error: opt(str({ maxLength: CODEMODE_VIEW_LIMITS.errorChars })),
				},
				{ open: true },
			),
			{ maxItems: CODEMODE_VIEW_LIMITS.maxCalls },
		),
		omitted: count,
		fullOutputPath: opt(text),
	},
	{ open: true },
);

export const MobileToolItemSchema = obj(
	{
		callId: text,
		name: text,
		summary: text,
		status: union([lit("running"), lit("done"), lit("error")]),
		detail: opt(text),
		output: opt(text),
		result: opt(text),
		diff: opt(text),
		diffAdded: opt(num()),
		diffRemoved: opt(num()),
		diffTruncated: opt(bool()),
		durationMs: opt(num()),
		note: opt(text),
		interaction: opt(MobileToolInteractionSchema),
		codemode: opt(MobileCodemodeSchema),
	},
	{ open: true },
);

/** 超过 8 KiB 的字符串字段只留 2 KiB 预览，并在 `refs` 中给出完整内容引用（每个字段至多一个）。 */
export const MobileChatItemSchema = obj(
	{
		key: text,
		type: union([lit("user"), lit("assistant"), lit("tool"), lit("error"), lit("system")]),
		text: opt(text),
		thinking: opt(text),
		note: opt(text),
		/** assistant 的失败原因；与已生成文本并存。 */
		error: opt(text),
		skill: opt(text),
		jobId: opt(text),
		tool: opt(MobileToolItemSchema),
		images: opt(arr(MobileImageRefSchema)),
		refs: opt(arr(MobileContentRefSchema)),
	},
	{ open: true },
);

export const MobileStreamingSchema = obj(
	{
		text: text,
		thinking: text,
		/** 快照只携带尾部；被省略的前缀 UTF-16 长度。 */
		textOmitted: count,
		thinkingOmitted: count,
		toolCalls: arr(
			obj(
				{
					callId: text,
					name: text,
					summary: text,
					status: union([lit("running"), lit("done")]),
				},
				{ open: true },
			),
		),
	},
	{ open: true },
);

export const MobileUsageSchema = obj(
	{
		input: count,
		output: count,
		cacheRead: count,
		cacheWrite: count,
		totalTokens: count,
		cost: num({ minimum: 0 }),
	},
	{ open: true },
);

export const MobileSubagentRoundSchema = obj(
	{
		taskId: count,
		/** 主会话中发起委派的工具调用，用于把工具卡关联到子详情。 */
		callId: text,
		agentId: text,
		round: opt(count),
		role: text,
		title: text,
		status: union([lit("queued"), lit("running"), lit("completed"), lit("failed"), lit("cancelled")]),
		approvalCount: count,
		readonly: bool(),
		createdAt: num(),
		endedAt: nullable(num()),
		usage: opt(MobileUsageSchema),
	},
	{ open: true },
);

export const MobileAgentSchema = obj(
	{
		agentId: text,
		role: text,
		title: text,
		status: union([lit("idle"), lit("queued"), lit("running")]),
		activeRoundId: nullable(count),
		lastRoundId: count,
		roundCount: count,
		approvalCount: count,
	},
	{ open: true },
);

export const MobileQueuedSchema = obj(
	{
		id: count,
		mode: union([lit("steer"), lit("followUp")]),
		preview: str(),
		images: count,
	},
	{ open: true },
);

const mobileChatStatusProperties = {
	busy: bool(),
	/** Absent on a computer without queue visibility; empty means supported with none. */
	queued: opt(arr(MobileQueuedSchema)),
	/** Absent on a computer without todos; present with `count: 0` when supported with none. */
	todos: opt(obj({ revision: count, count: count, completed: count }, { open: true })),
	/** Absent on a computer without questions; `pendingCount: 0` means supported with none. */
	questions: opt(obj({ revision: count, pendingCount: count }, { open: true })),
	/**
	 * Absent on a computer without plan mode; `pending: false` means supported with no plan awaiting approval.
	 * `version` names the newest plan (the pending one when `pending`), absent before the first plan.
	 */
	plan: opt(obj({ revision: count, pending: bool(), version: opt(str({ minLength: 1 })) }, { open: true })),
	status: nullable(text),
	usage: MobileUsageSchema,
	taskUsage: opt(MobileUsageSchema),
	contextUsage: opt(obj({ tokens: nullable(num()), window: num(), percent: nullable(num()) }, { open: true })),
	agent: obj({ model: nullable(text), thinkingLevel: nullable(text) }, { open: true }),
	subagents: arr(MobileSubagentRoundSchema),
	agents: arr(MobileAgentSchema),
	approvalCount: count,
	compaction: opt(obj({ phase: text, at: num() }, { open: true })),
	/** Why the newest run ended without an answer: Pi's reason code and a bounded detail; absent when there is none. */
	runFailure: opt(obj({ reason: text, detail: opt(text) }, { open: true })),
	readonly: opt(bool()),
};

export const MobileChatStatusSchema = obj(mobileChatStatusProperties, { open: true });

export const MobileChatSnapshotSchema = obj(
	{
		...mobileChatStatusProperties,
		items: arr(MobileChatItemSchema),
		historyBefore: nullable(text),
		streaming: nullable(MobileStreamingSchema),
	},
	{ open: true },
);

export const MobileWorkspaceSchema = obj({ root: text, name: text }, { open: true });

export const MobileSessionSummarySchema = obj(
	{
		id: text,
		workspace: text,
		title: text,
		preview: text,
		lastUsedAt: int(),
		lastMessageAt: int(),
		archived: bool(),
		/** A question of this session waits for an answer; absent when the computer cannot tell. */
		awaitingAnswer: opt(bool()),
		/** A submitted plan of this idle session waits for approval; absent when the computer cannot tell. */
		awaitingPlan: opt(bool()),
	},
	{ open: true },
);

export const MobileApprovalSchema = obj(
	{
		id: count,
		version: text,
		taskId: count,
		agentId: opt(text),
		title: opt(text),
		command: text,
		cwd: text,
		timeoutSeconds: opt(num({ minimum: 0 })),
		requestedAt: num(),
	},
	{ open: true },
);

export const MobileTodoItemSchema = obj(
	{
		id: str({ minLength: 1, maxLength: TODO_LIMITS.idChars }),
		text: str({ minLength: 1, maxLength: TODO_LIMITS.textChars }),
		status: union([lit("pending"), lit("in_progress"), lit("completed")]),
	},
	{ open: true },
);
export const MobileTodoListSchema = obj(
	{
		revision: count,
		items: arr(MobileTodoItemSchema, { maxItems: TODO_LIMITS.maxItems }),
	},
	{ open: true },
);
export const MobileQuestionOptionSchema = obj(
	{
		id: str({ minLength: 1, maxLength: QUESTION_LIMITS.optionIdChars }),
		label: str({ minLength: 1, maxLength: QUESTION_LIMITS.labelChars }),
		description: opt(str({ maxLength: QUESTION_LIMITS.descriptionChars })),
		recommended: opt(bool()),
	},
	{ open: true },
);
/** Bounded list entry; `questions.get` returns the full record. */
export const MobileQuestionSummarySchema = obj(
	{
		id: count,
		version: text,
		preview: str({ maxLength: QUESTION_LIMITS.previewChars }),
		multiple: bool(),
		optionCount: count,
		createdAt: num(),
	},
	{ open: true },
);
export const MobileQuestionListSchema = obj(
	{
		revision: count,
		pending: arr(MobileQuestionSummarySchema, { maxItems: QUESTION_LIMITS.maxPending }),
	},
	{ open: true },
);
export const MobileQuestionSchema = obj(
	{
		id: count,
		callId: text,
		version: text,
		question: str({ maxLength: QUESTION_LIMITS.questionChars }),
		multiple: bool(),
		options: arr(MobileQuestionOptionSchema, { maxItems: QUESTION_LIMITS.maxOptions }),
		status: questionStatus,
		answer: nullable(
			obj(
				{
					optionIds: arr(str(), { maxItems: QUESTION_LIMITS.maxOptions }),
					text: nullable(str({ maxLength: QUESTION_LIMITS.textChars })),
				},
				{ open: true },
			),
		),
		createdAt: num(),
		settledAt: nullable(num()),
	},
	{ open: true },
);
export const MobileQuestionResponseSchema = union([
	obj({
		kind: lit("answer"),
		optionIds: opt(arr(str(), { maxItems: QUESTION_LIMITS.maxOptions })),
		text: opt(str({ maxLength: QUESTION_LIMITS.textChars })),
	}),
	obj({ kind: lit("skip") }),
]);
export const MobilePlanSchema = obj(
	{
		version: str({ minLength: 1 }),
		title: str({ maxLength: PLAN_LIMITS.titleChars }),
		steps: arr(str({ maxLength: PLAN_LIMITS.stepChars }), { maxItems: PLAN_LIMITS.maxSteps }),
		note: str({ maxLength: PLAN_LIMITS.noteChars }),
		status: planStatus,
		feedback: nullable(str({ maxLength: PLAN_LIMITS.feedbackChars })),
		createdAt: num(),
		settledAt: nullable(num()),
	},
	{ open: true },
);
export const MobilePlanDecisionSchema = union([
	obj({ kind: lit("approve") }),
	obj({ kind: lit("revise"), feedback: str({ minLength: 1, maxLength: PLAN_LIMITS.feedbackChars }) }),
]);

const sessionListParams = obj(
	{
		workspace: text,
		query: opt(text),
		cursor: opt(text),
	},
	{ open: true },
);
const sessionListResult = obj(
	{
		sessions: arr(MobileSessionSummarySchema),
		nextCursor: opt(text),
	},
	{ open: true },
);
const subscription = { subscriptionId: str({ minLength: 1 }) };
const pageResult = obj({ items: arr(MobileChatItemSchema), historyBefore: nullable(text) }, { open: true });
const pageParams = obj(
	{
		...subscription,
		before: str({ minLength: 1 }),
		limit: opt(int({ minimum: 1, maximum: 50 })),
	},
	{ open: true },
);
const chunkResultProperties = { data: text, nextOffset: count, total: count, done: bool() };
const chunkResult = obj(chunkResultProperties, { open: true });

export const MOBILE_API_V1_METHODS: Readonly<Record<string, { readonly params: unknown; readonly result: unknown }>> = {
	"server.hello": { params: MobileHelloParams, result: buildHelloResultSchema() },
	"workspaces.list": { params: nul(), result: obj({ workspaces: arr(MobileWorkspaceSchema) }, { open: true }) },
	"sessions.list": { params: sessionListParams, result: sessionListResult },
	"sessions.create": { params: obj({ workspace: text }, { open: true }), result: MobileSessionSummarySchema },
	"chat.attach": {
		params: obj({ sessionId: str({ minLength: 1 }) }, { open: true }),
		result: obj({ subscriptionId: text, sessionId: text, snapshot: MobileChatSnapshotSchema }, { open: true }),
	},
	"chat.detach": { params: obj(subscription, { open: true }), result: nul() },
	"chat.history": { params: pageParams, result: pageResult },
	"chat.content": {
		params: obj({ ref: MobileContentRefSchema, offset: count }, { open: true }),
		result: chunkResult,
	},
	"chat.submit": {
		params: obj(
			{
				...subscription,
				requestId: str({ minLength: 1, maxLength: 128 }),
				text: str({ minLength: 1, maxLength: 65_536 }),
				mode: opt(lit("steer")),
			},
			{ open: true },
		),
		result: obj({ accepted: lit(true), queued: bool() }, { open: true }),
	},
	"chat.submissionStatus": {
		params: obj({ ...subscription, requestId: str({ minLength: 1, maxLength: 128 }) }, { open: true }),
		result: obj({ status: union([lit("accepted"), lit("unknown")]) }, { open: true }),
	},
	"chat.steer": {
		params: obj({ ...subscription, id: count }, { open: true }),
		result: obj(
			{
				result: union([lit("steered"), lit("withdrawn"), lit("placed"), lit("settled"), lit("unknown")]),
				id: opt(count),
				text: opt(str()),
				images: opt(count),
			},
			{ open: true },
		),
	},
	"chat.withdraw": {
		params: obj({ ...subscription, id: count }, { open: true }),
		result: obj(
			{
				result: union([lit("withdrawn"), lit("placed"), lit("settled"), lit("unknown")]),
				text: opt(str()),
				images: opt(count),
			},
			{ open: true },
		),
	},
	"chat.abort": { params: obj(subscription, { open: true }), result: obj({ accepted: bool() }, { open: true }) },
	"subagents.open": {
		params: obj({ ...subscription, agentId: opt(str({ minLength: 1 })), taskId: opt(count) }, { open: true }),
		result: obj(
			{
				subagentSubscriptionId: text,
				agentId: text,
				snapshot: MobileChatSnapshotSchema,
			},
			{ open: true },
		),
	},
	"subagents.history": {
		params: obj(
			{
				subagentSubscriptionId: str({ minLength: 1 }),
				before: str({ minLength: 1 }),
				limit: opt(int({ minimum: 1, maximum: 50 })),
			},
			{ open: true },
		),
		result: pageResult,
	},
	"subagents.close": {
		params: obj({ subagentSubscriptionId: str({ minLength: 1 }) }, { open: true }),
		result: nul(),
	},
	"subagents.stop": {
		params: obj({ ...subscription, taskId: count }, { open: true }),
		result: obj({ stopped: bool() }, { open: true }),
	},
	"approvals.list": {
		params: obj(subscription, { open: true }),
		result: obj({ approvals: arr(MobileApprovalSchema) }, { open: true }),
	},
	"approvals.get": { params: obj({ ...subscription, id: count }, { open: true }), result: MobileApprovalSchema },
	"approvals.decide": {
		params: obj(
			{
				...subscription,
				taskId: count,
				id: count,
				version: str({ minLength: 1 }),
				decision: union([lit("allow"), lit("deny")]),
			},
			{ open: true },
		),
		result: obj(
			{
				status: union([lit("pending"), lit("allowed"), lit("denied"), lit("cancelled")]),
			},
			{ open: true },
		),
	},
	"todos.get": { params: obj(subscription, { open: true }), result: MobileTodoListSchema },
	"questions.list": { params: obj(subscription, { open: true }), result: MobileQuestionListSchema },
	"questions.get": { params: obj({ ...subscription, id: count }, { open: true }), result: MobileQuestionSchema },
	"questions.respond": {
		params: obj(
			{
				...subscription,
				id: count,
				version: str({ minLength: 1 }),
				response: MobileQuestionResponseSchema,
			},
			{ open: true },
		),
		result: MobileQuestionSchema,
	},
	"plan.get": {
		params: obj({ ...subscription, version: str({ minLength: 1 }) }, { open: true }),
		result: MobilePlanSchema,
	},
	"plan.respond": {
		params: obj(
			{
				...subscription,
				version: str({ minLength: 1 }),
				decision: MobilePlanDecisionSchema,
			},
			{ open: true },
		),
		result: MobilePlanSchema,
	},
	"plan.exit": {
		params: obj(subscription, { open: true }),
		result: obj({ mode: lit("normal"), revision: count }, { open: true }),
	},
	"media.read": {
		params: obj(
			{
				...subscription,
				agentId: opt(str({ minLength: 1 })),
				entryId: count,
				contentIndex: count,
				offset: count,
			},
			{ open: true },
		),
		result: obj({ ...chunkResultProperties, mimeType: text }, { open: true }),
	},
};

function buildHelloResultSchema() {
	return obj(
		{
			apiVersion: int({ minimum: 1 }),
			serverId: text,
			serverName: text,
			gatewayVersion: text,
			capabilities: arr(text),
			limits: obj(
				{
					maxFrameBytes: int(),
					maxPayloadBytes: int(),
					pageItems: int(),
					chunkBytes: int(),
					maxConcurrentRequests: int(),
					maxSendBufferBytes: int(),
				},
				{ open: true },
			),
		},
		{ open: true },
	);
}

const patchBody = {
	seq: int({ minimum: 1 }),
	upserts: arr(MobileChatItemSchema),
	status: opt(MobileChatStatusSchema),
	/** 整段替换流式区（含结束时置 null）。 */
	streaming: opt(nullable(MobileStreamingSchema)),
	/** 在当前流式文本末尾追加。 */
	streamingAppend: opt(obj({ text: opt(text), thinking: opt(text) }, { open: true })),
};

export const MOBILE_API_V1_NOTIFICATIONS: Readonly<Record<string, unknown>> = {
	"workspaces.changed": obj({ revision: int({ minimum: 1 }) }, { open: true }),
	"sessions.changed": obj({ revision: int({ minimum: 1 }) }, { open: true }),
	"chat.patch": obj({ subscriptionId: text, ...patchBody }, { open: true }),
	"chat.reset": obj({ subscriptionId: text, seq: int({ minimum: 1 }) }, { open: true }),
	"subagents.patch": obj({ subagentSubscriptionId: text, ...patchBody }, { open: true }),
	"subagents.reset": obj({ subagentSubscriptionId: text, seq: int({ minimum: 1 }) }, { open: true }),
	"approvals.changed": obj({ subscriptionId: text, revision: int({ minimum: 1 }) }, { open: true }),
	/** Invalidation hint: read `todos.get`; revisions only grow, so accept a result no older than the one held. */
	"todos.changed": obj({ subscriptionId: text, revision: int({ minimum: 1 }) }, { open: true }),
	"questions.changed": obj({ subscriptionId: text, revision: int({ minimum: 1 }) }, { open: true }),
	/** Invalidation hint: read `plan.get` for the version the status names, or re-attach for the latest plan. */
	"plan.changed": obj({ subscriptionId: text, revision: int({ minimum: 1 }) }, { open: true }),
};
