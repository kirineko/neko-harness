/** Browser-safe Chord 1.3 contracts. All wire values are validated schemas. */
import { type HostNamed, hostNamed, method, type Ref, type RemoteContract, remote } from "@earendil-works/chord";
import { PLAN_LIMITS, QUESTION_LIMITS, TODO_LIMITS } from "@neko-harness/core/interactions";
import { type Static, type TSchema, Type } from "typebox";

/** Every gateway service lives on the one host that serves it; the server id is verified through application info. */
export const GATEWAY_HOST = "neko";
// Chord does not export MethodSpec; keep public schema tuples so emitted declarations stay portable.
export type Definition = {
	version: number;
	input: TSchema;
	variants: Record<string, { state?: Record<string, TSchema>; methods?: Record<string, readonly [TSchema, TSchema]> }>;
};
export type WireDef<D extends Definition> = {
	version: D["version"];
	input: D["input"];
	host: HostNamed;
	variants: {
		[K in keyof D["variants"]]: {
			state: D["variants"][K] extends { state: infer S extends Record<string, TSchema> } ? S : Record<never, never>;
			methods: D["variants"][K] extends { methods: infer M extends Record<string, readonly [TSchema, TSchema]> }
				? { [P in keyof M]: ReturnType<typeof method<M[P][0], M[P][1]>> }
				: Record<never, never>;
		};
	};
};
export const rpc = <A extends TSchema, R extends TSchema>(args: A, result: R): readonly [A, R] => [args, result];
export function contract<const D extends Definition>(name: string, def: D): RemoteContract<WireDef<D>> {
	const variants = Object.fromEntries(
		Object.entries(def.variants).map(([key, value]) => [
			key,
			{
				...value,
				methods: Object.fromEntries(
					Object.entries(value.methods ?? {}).map(([member, [args, result]]) => [member, method(args, result)]),
				),
			},
		]),
	);
	return remote(name, { ...def, host: hostNamed(GATEWAY_HOST), variants } as unknown as Parameters<
		typeof remote
	>[1]) as unknown as RemoteContract<WireDef<D>>;
}
const str = Type.String();
const num = Type.Number();
const bool = Type.Boolean();
const nil = Type.Null();
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableString = Type.Union([str, nil]);
const phase = Type.Enum(["pending", "running", "done"]);
const level = Type.Enum(["project", "user", "builtin"]);
const thinking = Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const model = Type.Object({ provider: str, modelId: str });
const change = Type.Object(
	{ model: Type.Optional(model), thinkingLevel: Type.Optional(thinking) },
	{ additionalProperties: false },
);
const usage = Type.Object({ input: num, output: num, cacheRead: num, cacheWrite: num, cost: num });
const image = Type.Object({
	name: str,
	mimeType: str,
	width: integer,
	height: integer,
	bytes: integer,
	entryId: integer,
	contentIndex: integer,
});
const skill = Type.Object({ name: str, location: str, body: str, args: str });
const call = Type.Object({
	callId: str,
	name: str,
	summary: str,
	detail: nullableString,
	phase,
	output: nullableString,
	diff: nullableString,
	diffAdded: Type.Union([num, nil]),
	diffRemoved: Type.Union([num, nil]),
	diffTruncated: Type.Optional(bool),
});
export const DelegationSchema = Type.Object({
	parentId: integer,
	agentId: Type.Optional(str),
	round: Type.Optional(integer),
	runnerId: Type.Optional(integer),
	inputEntryId: Type.Optional(integer),
	answerEntryId: Type.Optional(integer),
	roundUsage: Type.Optional(Type.Union([usage, nil])),
	taskId: integer,
	callId: str,
	childId: integer,
	role: Type.Enum(["explore", "plan", "coder"]),
	title: str,
	createdAt: num,
	startedAt: Type.Union([num, nil]),
	endedAt: Type.Union([num, nil]),
	status: Type.Enum(["queued", "running", "completed", "failed", "cancelled"]),
	report: nullableString,
	approvalCount: Type.Optional(integer),
	historyThrough: Type.Optional(integer),
	historyUsage: Type.Optional(usage),
});
export const SubagentSummarySchema = Type.Object({
	agentId: str,
	parentId: integer,
	childId: integer,
	role: Type.Enum(["explore", "plan", "coder"]),
	title: str,
	status: Type.Enum(["idle", "queued", "running"]),
	activeRoundId: Type.Union([integer, nil]),
	lastRoundId: integer,
	lastReport: Type.Optional(nullableString),
	roundCount: integer,
	taskTitle: str,
	approvalCount: integer,
	createdAt: num,
	historyThrough: Type.Optional(integer),
	historyUsage: Type.Optional(usage),
});
const jobStatus = Type.Enum(["running", "exited", "failed", "stopped", "lost"]);
/** One background job without its output; `command` is clipped by the host so the list stays bounded. */
export const JobSummarySchema = Type.Object({
	jobId: str,
	title: str,
	command: str,
	cwd: str,
	status: jobStatus,
	startedAt: num,
	endedAt: Type.Union([num, nil]),
	exitCode: Type.Union([num, nil]),
	reason: Type.Optional(Type.Enum(["timeout", "spawn-error", "restart", "aborted"])),
	timeoutSeconds: Type.Optional(num),
	outputBytes: integer,
});
export const JobOutputSchema = Type.Object({
	job: JobSummarySchema,
	text: str,
	/** Pass back as `since` to continue reading. */
	offset: integer,
	truncated: bool,
	dropped: integer,
});
/** A user input waiting in the inbox; the preview is clipped by the host so the view stays bounded. */
export const QueuedInputSchema = Type.Object({
	id: integer,
	mode: Type.Enum(["steer", "followUp"]),
	preview: str,
	images: integer,
	skill: Type.Optional(Type.Object({ name: str, args: str })),
});
/** `text` is the full original input of a withdrawn message, for restoring the draft. */
export const WithdrawResultSchema = Type.Object({
	result: Type.Enum(["withdrawn", "placed", "settled", "unknown"]),
	text: Type.Optional(str),
	images: Type.Optional(integer),
});
/** `steered` carries the input's new submission id; `withdrawn` only when it could not be re-admitted, with its text. */
export const SteerResultSchema = Type.Object({
	result: Type.Enum(["steered", "withdrawn", "placed", "settled", "unknown"]),
	id: Type.Optional(integer),
	text: Type.Optional(str),
	images: Type.Optional(integer),
});
export const TodoItemSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: TODO_LIMITS.idChars }),
		text: Type.String({ minLength: 1, maxLength: TODO_LIMITS.textChars }),
		status: Type.Enum(["pending", "in_progress", "completed"]),
	},
	{ additionalProperties: false },
);
export const TodoListSchema = Type.Object({
	revision: integer,
	items: Type.Array(TodoItemSchema, { maxItems: TODO_LIMITS.maxItems }),
});
export const QuestionOptionSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.optionIdChars }),
		label: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.labelChars }),
		description: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.descriptionChars })),
		recommended: Type.Optional(bool),
	},
	{ additionalProperties: false },
);
const questionStatus = Type.Enum(["pending", "answered", "skipped", "cancelled"]);
/** Bounded entry of the pending list; the full record is read with `questionGet`. */
export const QuestionSummarySchema = Type.Object({
	id: integer,
	version: str,
	preview: Type.String({ maxLength: QUESTION_LIMITS.previewChars }),
	multiple: bool,
	optionCount: integer,
	createdAt: num,
});
/** Wire bounds mirror core's browse and change limits; the host enforces the real ones before sending. */
const WorkspaceEntrySchema = Type.Object(
	{
		name: str,
		path: str,
		kind: Type.Enum(["file", "directory", "symlink"]),
		protected: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
export const WorkspaceDirSchema = Type.Object({
	path: str,
	entries: Type.Array(WorkspaceEntrySchema, { maxItems: 1000 }),
	limited: bool,
	incomplete: bool,
});
export const WorkspaceFileSchema = Type.Object({
	path: str,
	size: num,
	mtimeMs: num,
	kind: Type.Enum(["text", "binary", "protected"]),
	content: Type.Optional(str),
	truncated: bool,
});
export const ChangeSummarySchema = Type.Object({ revision: integer, files: integer, added: integer, removed: integer });
export const ChangedFileSchema = Type.Object(
	{
		path: str,
		outside: Type.Optional(Type.Literal(true)),
		ops: integer,
		added: integer,
		removed: integer,
		agents: Type.Array(str, { maxItems: 64 }),
		lastSeq: integer,
	},
	{ additionalProperties: false },
);
export const ChangeListSchema = Type.Object({
	revision: integer,
	files: Type.Array(ChangedFileSchema, { maxItems: 500 }),
	truncated: bool,
});
export const ChangeOpSchema = Type.Object(
	{
		seq: integer,
		agent: str,
		tool: Type.Enum(["edit", "write"]),
		diff: str,
		added: integer,
		removed: integer,
		truncated: bool,
	},
	{ additionalProperties: false },
);
export const ChangeDetailSchema = Type.Object({
	path: str,
	outside: Type.Optional(Type.Literal(true)),
	ops: Type.Array(ChangeOpSchema, { maxItems: 50 }),
	truncated: bool,
});
export const QuestionListSchema = Type.Object({
	revision: integer,
	pending: Type.Array(QuestionSummarySchema, { maxItems: QUESTION_LIMITS.maxPending }),
});
export const QuestionRecordSchema = Type.Object({
	id: integer,
	callId: str,
	version: str,
	question: Type.String({ maxLength: QUESTION_LIMITS.questionChars }),
	multiple: bool,
	options: Type.Array(QuestionOptionSchema, { maxItems: QUESTION_LIMITS.maxOptions }),
	status: questionStatus,
	answer: Type.Union([
		Type.Object({
			optionIds: Type.Array(Type.String(), { maxItems: QUESTION_LIMITS.maxOptions }),
			text: Type.Union([Type.String({ maxLength: QUESTION_LIMITS.textChars }), nil]),
		}),
		nil,
	]),
	createdAt: num,
	settledAt: Type.Union([num, nil]),
});
export const QuestionResponseSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("answer"),
			optionIds: Type.Optional(Type.Array(Type.String(), { maxItems: QUESTION_LIMITS.maxOptions })),
			text: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.textChars })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("skip") }, { additionalProperties: false }),
]);
export const PlanRecordSchema = Type.Object({
	version: str,
	title: Type.String({ maxLength: PLAN_LIMITS.titleChars }),
	steps: Type.Array(Type.String({ maxLength: PLAN_LIMITS.stepChars }), { maxItems: PLAN_LIMITS.maxSteps }),
	note: Type.String({ maxLength: PLAN_LIMITS.noteChars }),
	status: Type.Enum(["awaiting_approval", "approved", "revision_requested", "superseded", "cancelled"]),
	feedback: Type.Union([Type.String({ maxLength: PLAN_LIMITS.feedbackChars }), nil]),
	createdAt: num,
	settledAt: Type.Union([num, nil]),
});
export const PlanViewSchema = Type.Object({
	mode: Type.Enum(["normal", "plan"]),
	revision: integer,
	current: Type.Union([PlanRecordSchema, nil]),
});
export const PlanDecisionSchema = Type.Union([
	Type.Object({ kind: Type.Literal("approve") }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("revise"), feedback: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.feedbackChars }) },
		{ additionalProperties: false },
	),
]);
/** What a todo / ask_user call shows in history, from the persisted tool details. */
export const ToolInteractionSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("ask_user"),
		id: integer,
		question: str,
		multiple: bool,
		options: Type.Array(Type.Object({ id: str, label: str, recommended: Type.Optional(bool) })),
		status: questionStatus,
		optionIds: Type.Optional(Type.Array(str)),
		labels: Type.Optional(Type.Array(str)),
		text: Type.Optional(Type.Union([str, nil])),
	}),
	Type.Object({
		kind: Type.Literal("todo"),
		action: Type.Enum(["list", "replace"]),
		revision: integer,
		completed: integer,
		total: integer,
	}),
	Type.Object({
		kind: Type.Literal("submit_plan"),
		version: str,
		title: str,
		steps: Type.Array(str),
		note: str,
	}),
]);
export const ChatViewSchema = Type.Object({
	historyBefore: Type.Optional(Type.Union([integer, nil])),
	agents: Type.Optional(Type.Array(SubagentSummarySchema)),
	/** Absent on a gateway without background jobs; empty means supported with none. */
	jobs: Type.Optional(Type.Array(JobSummarySchema)),
	/** Absent on a gateway without queue visibility; empty means supported with none. */
	queued: Type.Optional(Type.Array(QueuedInputSchema)),
	/** Absent on a gateway without todos; empty items means supported with none. */
	todos: Type.Optional(TodoListSchema),
	/** Absent on a gateway without ask_user; empty `pending` means supported with none. */
	questions: Type.Optional(QuestionListSchema),
	/** Absent on a gateway without plan mode; `current` is null before the first plan. */
	plan: Type.Optional(PlanViewSchema),
	/** Absent on a gateway without file change tracking; zero files means supported with none. */
	changes: Type.Optional(ChangeSummarySchema),
	rounds: Type.Optional(Type.Array(DelegationSchema)),
	subagents: Type.Optional(Type.Array(DelegationSchema)),
	taskUsage: Type.Optional(usage),
	model: str,
	agent: Type.Object({ model: Type.Union([model, nil]), thinkingLevel: Type.Union([thinking, nil]) }),
	cwd: str,
	busy: bool,
	status: nullableString,
	usage,
	contextUsage: Type.Optional(
		Type.Object({ tokens: Type.Union([num, nil]), window: num, percent: Type.Union([num, nil]) }),
	),
	compaction: Type.Optional(
		Type.Object({
			failure: Type.Optional(
				Type.Object({ taskId: integer, reason: Type.Enum(["manual", "threshold", "overflow"]), error: str }),
			),
			active: Type.Array(
				Type.Object({
					taskId: integer,
					reason: Type.Enum(["manual", "threshold", "overflow"]),
					blocking: bool,
					attempt: integer,
					retry: Type.Optional(Type.Object({ at: num, error: str })),
				}),
			),
			latest: Type.Union([
				nil,
				Type.Object({
					taskId: integer,
					phase: Type.Enum(["summarizing", "waiting-to-apply", "applied", "nothing", "skipped", "cancelled", "failed"]),
					at: num,
				}),
			]),
		}),
	),
	items: Type.Array(
		Type.Union([
			Type.Object({
				type: Type.Literal("user"),
				order: Type.Optional(num),
				key: str,
				id: integer,
				text: str,
				images: Type.Optional(Type.Array(image)),
				skill: Type.Optional(skill),
				defaultImagePrompt: Type.Optional(Type.Object({ version: Type.Integer({ minimum: 1 }), text: str })),
			}),
			Type.Object({
				type: Type.Literal("assistant"),
				order: Type.Optional(num),
				key: str,
				id: integer,
				thinking: str,
				text: str,
				stopReason: nullableString,
				errorMessage: nullableString,
				note: nullableString,
			}),
			Type.Object({
				type: Type.Literal("tool"),
				order: Type.Optional(num),
				key: str,
				images: Type.Optional(Type.Array(image)),
				callId: str,
				name: str,
				summary: str,
				detail: nullableString,
				phase,
				isError: bool,
				output: nullableString,
				result: nullableString,
				durationMs: Type.Union([num, nil]),
				note: nullableString,
				diff: nullableString,
				diffAdded: Type.Union([num, nil]),
				diffRemoved: Type.Union([num, nil]),
				diffTruncated: Type.Optional(bool),
				interaction: Type.Optional(ToolInteractionSchema),
			}),
			Type.Object({
				type: Type.Literal("system"),
				order: Type.Optional(num),
				key: str,
				id: integer,
				text: str,
				jobId: Type.Optional(str),
				planDecision: Type.Optional(
					Type.Object({ version: str, kind: Type.Enum(["approve", "revise"]) }, { additionalProperties: false }),
				),
			}),
		]),
	),
	streaming: Type.Union([nil, Type.Object({ thinking: str, text: str, toolCalls: Type.Array(call) })]),
});
export const SessionSummarySchema = Type.Object({
	workspaceRoot: str,
	lastUsedAt: num,
	title: str,
	firstPromptPreview: str,
	createdAt: num,
	lastMessageAt: Type.Union([num, nil]),
	model: Type.Union([model, nil]),
	status: Type.Enum(["idle", "running", "error"]),
	/** A question of this session waits for an answer; absent on a gateway that cannot tell. */
	awaitingAnswer: Type.Optional(bool),
	/** A submitted plan of this idle session waits for approval; absent on a gateway without plan mode. */
	awaitingPlan: Type.Optional(bool),
	id: str,
});
export const DirectoryStateSchema = Type.Object({ revision: integer, sessions: Type.Array(SessionSummarySchema) });
export const WorkspaceSummarySchema = Type.Object({ path: str, createdAt: num });
export const WorkspaceStateSchema = Type.Object({ revision: integer, workspaces: Type.Array(WorkspaceSummarySchema) });
const credentialStatus = Type.Object({
	savedConfigured: bool,
	environmentConfigured: bool,
	source: Type.Enum(["saved", "environment", "runtime", "keyless", "none"]),
	/** Model providers only: whether the user enabled the provider; absent for search credentials. */
	enabled: Type.Optional(bool),
});
export const CredentialStateSchema = Type.Object({
	revision: integer,
	/** Keyed by credential provider id from the core catalog. */
	statuses: Type.Record(str, credentialStatus),
});
export const AttachmentSchema = Type.Object({ sessionId: str, attachmentId: str });
const chatInput = Type.Object({ sessionId: str, attachmentId: str }, { additionalProperties: false });
export const NekoSessionDirectory = contract("neko.session-directory", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: { ready: { state: { state: DirectoryStateSchema } } },
});
export const NekoSessionManagement = contract("neko.session-management", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			methods: {
				create: rpc(
					Type.Object({ ...change.properties, cwd: Type.Optional(str) }, { additionalProperties: false }),
					SessionSummarySchema,
				),
				archive: rpc(str, nil),
				attach: rpc(str, AttachmentSchema),
				detach: rpc(nil, nil),
				fork: rpc(str, SessionSummarySchema),
			},
		},
	},
});
const resize = Type.Object({
	maxWidth: Type.Optional(integer),
	maxHeight: Type.Optional(integer),
	maxBytes: Type.Optional(integer),
	jpegQuality: Type.Optional(integer),
});
const inputLimits = Type.Object({
	maxRequestBytes: Type.Optional(integer),
	images: Type.Optional(
		Type.Object({
			resize: Type.Optional(resize),
			maxPerMessage: Type.Optional(integer),
			maxPerRequest: Type.Optional(integer),
		}),
	),
});
const modelInfo = Type.Object({
	provider: str,
	modelId: str,
	name: str,
	/** Whether the model's provider has credentials. */
	available: bool,
	contextWindow: num,
	input: Type.Array(str),
	inputLimits: Type.Optional(inputLimits),
	reasoning: bool,
	supportedThinkingLevels: Type.Array(thinking),
	thinkingLevelAdjustments: Type.Object({
		off: thinking,
		minimal: thinking,
		low: thinking,
		medium: thinking,
		high: thinking,
		xhigh: thinking,
		max: thinking,
	}),
});
export const NekoModels = contract("neko.models", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: { ready: { methods: { list: rpc(nil, Type.Array(modelInfo)) } } },
});
const imageChunk = Type.Object({ data: str, total: integer, mimeType: str });
export const NekoSubagent = contract("neko.subagent", {
	version: 1,
	input: Type.Object({
		sessionId: str,
		attachmentId: str,
		taskId: Type.Optional(integer),
		agentId: Type.Optional(str),
	}),
	variants: {
		ready: {
			state: { revision: integer },
			methods: {
				chunk: rpc(
					Type.Object({
						kind: Type.Enum(["view", "history"]),
						before: Type.Optional(integer),
						token: Type.Optional(integer),
						offset: integer,
					}),
					Type.Object({ token: integer, data: str, next: Type.Union([integer, nil]) }),
				),
				getImage: rpc(Type.Object({ entryId: integer, contentIndex: integer, offset: integer }), imageChunk),
				decideApproval: rpc(
					Type.Object({ id: integer, version: str, decision: Type.Enum(["allowed", "denied"]) }),
					Type.Enum(["pending", "allowed", "denied", "cancelled"]),
				),
				stop: rpc(Type.Union([nil, Type.Object({ taskId: integer })]), nil),
			},
		},
	},
});
export type NekoSubagent = Ref<typeof NekoSubagent>;
export const NekoChat = contract("neko.chat", {
	version: 1,
	input: chatInput,
	variants: {
		ready: {
			state: { view: ChatViewSchema },
			methods: {
				submit: rpc(
					Type.Object(
						{
							content: str,
							images: Type.Optional(Type.Array(str, { maxItems: 4 })),
							requestId: Type.Optional(str),
							whenBusy: Type.Optional(Type.Enum(["steer", "followUp"])),
						},
						{ additionalProperties: false },
					),
					nil,
				),
				abort: rpc(nil, nil),
				withdraw: rpc(Type.Object({ id: integer }, { additionalProperties: false }), WithdrawResultSchema),
				steer: rpc(Type.Object({ id: integer }, { additionalProperties: false }), SteerResultSchema),
				questionGet: rpc(
					Type.Object({ id: integer }, { additionalProperties: false }),
					Type.Union([QuestionRecordSchema, nil]),
				),
				questionRespond: rpc(
					Type.Object({ id: integer, version: str, response: QuestionResponseSchema }, { additionalProperties: false }),
					QuestionRecordSchema,
				),
				planGet: rpc(
					Type.Object({ version: str }, { additionalProperties: false }),
					Type.Union([PlanRecordSchema, nil]),
				),
				planRespond: rpc(
					Type.Object({ version: str, decision: PlanDecisionSchema }, { additionalProperties: false }),
					PlanRecordSchema,
				),
				planMode: rpc(
					Type.Object({ mode: Type.Enum(["normal", "plan"]) }, { additionalProperties: false }),
					PlanViewSchema,
				),
				usage: rpc(nil, usage),
				workspaceDir: rpc(Type.Object({ path: str }, { additionalProperties: false }), WorkspaceDirSchema),
				workspaceFile: rpc(Type.Object({ path: str }, { additionalProperties: false }), WorkspaceFileSchema),
				changesList: rpc(nil, ChangeListSchema),
				changeGet: rpc(
					Type.Object({ path: str }, { additionalProperties: false }),
					Type.Union([ChangeDetailSchema, nil]),
				),
				skills: rpc(nil, Type.Array(Type.Object({ name: str, description: str, location: str, level }))),
				jobOutput: rpc(
					Type.Object({ jobId: str, since: Type.Optional(integer) }, { additionalProperties: false }),
					JobOutputSchema,
				),
				jobStop: rpc(Type.Object({ jobId: str }, { additionalProperties: false }), JobSummarySchema),
				configure: rpc(change, nil),
				compact: rpc(Type.Object({ instructions: Type.Optional(str) }, { additionalProperties: false }), nil),
				importImage: rpc(str, Type.Object({ id: str, name: str })),
				draftImage: rpc(Type.Object({ id: str, offset: integer }, { additionalProperties: false }), imageChunk),
				beginImage: rpc(
					Type.Object(
						{ name: str, mimeType: str, size: Type.Integer({ minimum: 1, maximum: 20971520 }) },
						{ additionalProperties: false },
					),
					str,
				),
				appendImage: rpc(
					Type.Object(
						{ id: str, offset: integer, data: Type.String({ maxLength: 350000 }) },
						{ additionalProperties: false },
					),
					nil,
				),
				finishImage: rpc(str, nil),
				releaseImage: rpc(str, nil),
				getImage: rpc(
					Type.Object({ entryId: integer, contentIndex: integer, offset: integer }, { additionalProperties: false }),
					imageChunk,
				),
			},
		},
	},
});
const browse = Type.Object(
	{ path: str, query: Type.Optional(str), showHidden: Type.Optional(bool), cursor: Type.Optional(str) },
	{ additionalProperties: false },
);
const page = Type.Object({
	path: str,
	parent: nullableString,
	entries: Type.Array(Type.Object({ name: str, path: str, error: Type.Optional(str) })),
	next: nullableString,
});
export const NekoWorkspaces = contract("neko.workspaces", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			state: { state: WorkspaceStateSchema },
			methods: {
				add: rpc(Type.Object({ path: str }, { additionalProperties: false }), WorkspaceSummarySchema),
				browse: rpc(browse, page),
			},
		},
	},
});
const provider = Type.String({ minLength: 1, maxLength: 64 });
export const NekoCredentials = contract("neko.credentials", {
	version: 2,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			state: { state: CredentialStateSchema },
			methods: {
				save: rpc(
					Type.Object(
						{ provider, key: Type.String({ minLength: 1, maxLength: 8192 }) },
						{ additionalProperties: false },
					),
					nil,
				),
				remove: rpc(Type.Object({ provider }, { additionalProperties: false }), nil),
				setEnabled: rpc(Type.Object({ provider, enabled: bool }, { additionalProperties: false }), nil),
			},
		},
	},
});
export const SearchSettingsStateSchema = Type.Object({
	revision: integer,
	selected: Type.Enum(["tavily", "deepseek"]),
});
export const NekoSearchSettings = contract("neko.search-settings", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			state: { state: SearchSettingsStateSchema },
			methods: {
				set: rpc(Type.Object({ provider: Type.Enum(["tavily", "deepseek"]) }, { additionalProperties: false }), nil),
			},
		},
	},
});
const contextSource = Type.Enum(["default", "config", "saved"]);
export const ContextSettingsStateSchema = Type.Object({
	revision: integer,
	effective: Type.Object({
		compaction: Type.Object({
			enabled: bool,
			triggerPercent: Type.Union([integer, nil]),
			keepRecentTokens: integer,
		}),
		pruning: Type.Object({
			enabled: bool,
			triggerPercent: integer,
			keepRecent: integer,
			minChars: integer,
			minSavePercent: integer,
		}),
	}),
	sources: Type.Object({
		compaction: Type.Object({ enabled: contextSource, triggerPercent: contextSource, keepRecentTokens: contextSource }),
		pruning: Type.Object({
			enabled: contextSource,
			triggerPercent: contextSource,
			keepRecent: contextSource,
			minChars: contextSource,
			minSavePercent: contextSource,
		}),
	}),
});
const nullable = <T extends ReturnType<typeof Type.Integer> | typeof bool>(schema: T) => Type.Union([schema, nil]);
const ContextSettingsPatchSchema = Type.Object(
	{
		compaction: Type.Optional(
			Type.Object(
				{
					enabled: Type.Optional(nullable(bool)),
					triggerPercent: Type.Optional(nullable(integer)),
					keepRecentTokens: Type.Optional(nullable(integer)),
				},
				{ additionalProperties: false },
			),
		),
		pruning: Type.Optional(
			Type.Object(
				{
					enabled: Type.Optional(nullable(bool)),
					triggerPercent: Type.Optional(nullable(integer)),
					keepRecent: Type.Optional(nullable(integer)),
					minChars: Type.Optional(nullable(integer)),
					minSavePercent: Type.Optional(nullable(integer)),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export const NekoContextSettings = contract("neko.context-settings", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			state: { state: ContextSettingsStateSchema },
			methods: {
				set: rpc(ContextSettingsPatchSchema, nil),
				reset: rpc(Type.Object({}, { additionalProperties: false }), nil),
			},
		},
	},
});
const defaultModelSource = Type.Enum(["cli", "saved", "config", "default"]);
export const DefaultModelStateSchema = Type.Object({
	effective: model,
	source: defaultModelSource,
});
export const NekoDefaultModel = contract("neko.default-model", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			state: { state: DefaultModelStateSchema },
			methods: {
				set: rpc(model, nil),
				clear: rpc(nil, nil),
			},
		},
	},
});
export const FileCandidatesSchema = Type.Object({
	entries: Type.Array(Type.Object({ name: str, path: str, kind: Type.Enum(["file", "directory"]) }), { maxItems: 100 }),
	limited: bool,
	incomplete: bool,
});
export const NekoWorkspaceFiles = contract("neko.workspace-files", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			methods: {
				search: rpc(
					Type.Object({ workspaceRoot: str, query: str }, { additionalProperties: false }),
					FileCandidatesSchema,
				),
			},
		},
	},
});
const marketSkill = Type.Object({
	name: str,
	description: str,
	category: str,
	source: str,
	license: str,
	version: str,
	sha256: str,
	sizeBytes: integer,
	uploadedAt: str,
	installed: Type.Object({ project: bool, user: bool, builtin: bool }),
	activeLevel: Type.Union([level, nil]),
});
const preview = Type.Object({ body: str, files: Type.Array(str) });
const scope = Type.Enum(["user", "project"]);
const installResult = Type.Object({ name: str, scope, path: str, shadowedBy: Type.Optional(scope) });
export const NekoSkillMarket = contract("neko.skill-market", {
	version: 1,
	input: Type.Object({}, { additionalProperties: false }),
	variants: {
		ready: {
			methods: {
				list: rpc(
					Type.Object(
						{ query: Type.Optional(str), workspaceRoot: Type.Optional(str) },
						{ additionalProperties: false },
					),
					Type.Array(marketSkill),
				),
				detail: rpc(
					Type.Object({ name: str, workspaceRoot: Type.Optional(str) }, { additionalProperties: false }),
					marketSkill,
				),
				preview: rpc(Type.Object({ name: str }, { additionalProperties: false }), preview),
				install: rpc(
					Type.Object(
						{ name: str, scope, workspaceRoot: Type.Optional(str), overwrite: Type.Optional(bool) },
						{ additionalProperties: false },
					),
					installResult,
				),
				uninstall: rpc(
					Type.Object({ name: str, scope, workspaceRoot: Type.Optional(str) }, { additionalProperties: false }),
					nil,
				),
			},
		},
	},
});
export type NekoSessionDirectory = Ref<typeof NekoSessionDirectory>;
export type NekoSessionManagement = Ref<typeof NekoSessionManagement>;
export type NekoModels = Ref<typeof NekoModels>;
export type NekoChat = Ref<typeof NekoChat>;
export type WireJobSummary = Static<typeof JobSummarySchema>;
export type WireJobOutput = Static<typeof JobOutputSchema>;
export type WireQueuedInput = Static<typeof QueuedInputSchema>;
export type WireWithdrawResult = Static<typeof WithdrawResultSchema>;
export type WireSteerResult = Static<typeof SteerResultSchema>;
export type WireTodoList = Static<typeof TodoListSchema>;
export type WireTodoItem = Static<typeof TodoItemSchema>;
export type WireQuestionList = Static<typeof QuestionListSchema>;
export type WireQuestionSummary = Static<typeof QuestionSummarySchema>;
export type WireQuestionRecord = Static<typeof QuestionRecordSchema>;
export type WirePlanRecord = Static<typeof PlanRecordSchema>;
export type WirePlanView = Static<typeof PlanViewSchema>;
export type WirePlanDecision = Static<typeof PlanDecisionSchema>;
export type WireQuestionResponse = Static<typeof QuestionResponseSchema>;
export type WireWorkspaceDir = Static<typeof WorkspaceDirSchema>;
export type WireWorkspaceFile = Static<typeof WorkspaceFileSchema>;
export type WireChangeSummary = Static<typeof ChangeSummarySchema>;
export type WireChangeList = Static<typeof ChangeListSchema>;
export type WireChangeDetail = Static<typeof ChangeDetailSchema>;
export type NekoWorkspaces = Ref<typeof NekoWorkspaces>;
export type NekoWorkspaceFiles = Ref<typeof NekoWorkspaceFiles>;
export type NekoCredentials = Ref<typeof NekoCredentials>;
export type NekoSearchSettings = Ref<typeof NekoSearchSettings>;
export type NekoContextSettings = Ref<typeof NekoContextSettings>;
export type NekoDefaultModel = Ref<typeof NekoDefaultModel>;
export type NekoDefaultModelState = Static<typeof DefaultModelStateSchema>;
export type NekoSkillMarket = Ref<typeof NekoSkillMarket>;
export type NekoSessionSummary = Static<typeof SessionSummarySchema>;
export type NekoDirectoryState = Static<typeof DirectoryStateSchema>;
export type NekoWorkspaceSummary = Static<typeof WorkspaceSummarySchema>;
export type NekoWorkspaceState = Static<typeof WorkspaceStateSchema>;
export type NekoCredentialState = Static<typeof CredentialStateSchema>;
export type NekoSearchSettingsState = Static<typeof SearchSettingsStateSchema>;
export type NekoContextSettingsState = Static<typeof ContextSettingsStateSchema>;
export type NekoContextSettingsPatch = Static<typeof ContextSettingsPatchSchema>;
export type NekoAttachment = Static<typeof AttachmentSchema>;
export type NekoBrowseOptions = Static<typeof browse>;
export type NekoDirectoryPage = Static<typeof page>;
export type NekoMarketSkill = Static<typeof marketSkill>;
export type NekoMarketPreview = Static<typeof preview>;
export type NekoMarketInstallResult = Static<typeof installResult>;
export type NekoCreateSessionOptions = Parameters<NekoSessionManagement["create"]>[0];
export type NekoSubmitInput = Parameters<NekoChat["submit"]>[0];

/** Windows command shell status; absent on other platforms and on older gateways. */
export const ShellStatusSchema = Type.Union([
	Type.Object({ status: Type.Literal("ready"), path: str, source: Type.Enum(["config", "auto"]) }),
	Type.Object({
		status: Type.Literal("missing"),
		reason: Type.Enum(["not_found", "invalid_config"]),
		detail: Type.Optional(str),
	}),
]);
export type NekoShellStatus = Static<typeof ShellStatusSchema>;

/** Stable bootstrap contract: keep this available even when business protocol changes. */
export const ApplicationInfoSchema = Type.Object({
	runningVersion: str,
	installedVersion: nullableString,
	protocolVersion: Type.Integer({ minimum: 1 }),
	latestVersion: nullableString,
	checkedAt: Type.Union([integer, nil]),
	checkState: Type.Enum(["unknown", "checking", "ok", "failed", "development"]),
	serverId: str,
	shell: Type.Optional(ShellStatusSchema),
});
export const NekoApplicationInfo = contract("neko.application-info", {
	version: 1,
	input: Type.Object({}),
	variants: {
		ready: { state: { info: ApplicationInfoSchema }, methods: { check: rpc(nil, ApplicationInfoSchema) } },
	},
});
export type NekoApplicationInfo = Ref<typeof NekoApplicationInfo>;
