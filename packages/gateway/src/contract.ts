/** Browser-safe Chord 1.3 contracts. All wire values are validated schemas. */
import { type HostNamed, hostNamed, method, type Ref, type RemoteContract, remote } from "@earendil-works/chord";
import {
	arr,
	bool,
	int,
	lit,
	map,
	nul,
	num,
	obj,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { CODEMODE_MODES } from "@neko-harness/core/codemode-mode";
import { PLAN_LIMITS, QUESTION_LIMITS, TODO_LIMITS } from "@neko-harness/core/interactions";

/** Every gateway service lives on the one host that serves it; the server id is verified through application info. */
export const GATEWAY_HOST = "neko";
// Chord does not export MethodSpec; keep public schema tuples so emitted declarations stay portable.
export type Definition = {
	version: number;
	input: Schema;
	variants: Record<string, { state?: Record<string, Schema>; methods?: Record<string, readonly [Schema, Schema]> }>;
};
export type WireDef<D extends Definition> = {
	version: D["version"];
	input: D["input"];
	host: HostNamed;
	variants: {
		[K in keyof D["variants"]]: {
			state: D["variants"][K] extends { state: infer S extends Record<string, Schema> } ? S : Record<never, never>;
			methods: D["variants"][K] extends { methods: infer M extends Record<string, readonly [Schema, Schema]> }
				? { [P in keyof M]: ReturnType<typeof method<M[P][0], M[P][1]>> }
				: Record<never, never>;
		};
	};
};
export const rpc = <A extends Schema, R extends Schema>(args: A, result: R): readonly [A, R] => [args, result];
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
const text = str();
const number = num();
const boolean = bool();
const nil = nul();
const integer = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableString = union([text, nil]);
const phase = oneOf(["pending", "running", "done"]);
const level = oneOf(["project", "user", "builtin"]);
const thinking = oneOf(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const model = obj({ provider: text, modelId: text }, { open: true });
const changeProperties = { model: opt(model), thinkingLevel: opt(thinking) };
const change = obj(changeProperties);
const usage = obj(
	{ input: number, output: number, cacheRead: number, cacheWrite: number, cost: number },
	{ open: true },
);
const image = obj(
	{
		name: text,
		mimeType: text,
		width: integer,
		height: integer,
		bytes: integer,
		entryId: integer,
		contentIndex: integer,
	},
	{ open: true },
);
const skill = obj({ name: text, location: text, body: text, args: text }, { open: true });
/** Nested calls of a codemode script; the projection bounds the list, previews and errors. */
export const CodemodeViewSchema = obj(
	{
		calls: arr(
			obj(
				{
					id: integer,
					name: text,
					args: text,
					status: oneOf(["running", "ok", "error", "cancelled"]),
					durationMs: union([number, nil]),
					error: nullableString,
				},
				{ open: true },
			),
		),
		omitted: integer,
		fullOutputPath: nullableString,
	},
	{ open: true },
);
const call = obj(
	{
		callId: text,
		name: text,
		summary: text,
		detail: nullableString,
		phase,
		output: nullableString,
		diff: nullableString,
		diffAdded: union([number, nil]),
		diffRemoved: union([number, nil]),
		diffTruncated: opt(boolean),
		codemode: opt(CodemodeViewSchema),
	},
	{ open: true },
);
export const DelegationSchema = obj(
	{
		parentId: integer,
		agentId: opt(text),
		round: opt(integer),
		runnerId: opt(integer),
		inputEntryId: opt(integer),
		answerEntryId: opt(integer),
		roundUsage: opt(union([usage, nil])),
		taskId: integer,
		callId: text,
		childId: integer,
		role: oneOf(["explore", "plan", "coder"]),
		title: text,
		createdAt: number,
		startedAt: union([number, nil]),
		endedAt: union([number, nil]),
		status: oneOf(["queued", "running", "completed", "failed", "cancelled"]),
		report: nullableString,
		approvalCount: opt(integer),
		historyThrough: opt(integer),
		historyUsage: opt(usage),
	},
	{ open: true },
);
export const SubagentSummarySchema = obj(
	{
		agentId: text,
		parentId: integer,
		childId: integer,
		role: oneOf(["explore", "plan", "coder"]),
		title: text,
		status: oneOf(["idle", "queued", "running"]),
		activeRoundId: union([integer, nil]),
		lastRoundId: integer,
		lastReport: opt(nullableString),
		roundCount: integer,
		taskTitle: text,
		approvalCount: integer,
		createdAt: number,
		historyThrough: opt(integer),
		historyUsage: opt(usage),
	},
	{ open: true },
);
const jobStatus = oneOf(["running", "exited", "failed", "stopped", "lost"]);
/** One background job without its output; `command` is clipped by the host so the list stays bounded. */
export const JobSummarySchema = obj(
	{
		jobId: text,
		title: text,
		command: text,
		cwd: text,
		status: jobStatus,
		startedAt: number,
		endedAt: union([number, nil]),
		exitCode: union([number, nil]),
		reason: opt(oneOf(["timeout", "spawn-error", "restart", "aborted"])),
		timeoutSeconds: opt(number),
		outputBytes: integer,
	},
	{ open: true },
);
export const JobOutputSchema = obj(
	{
		job: JobSummarySchema,
		text: text,
		/** Pass back as `since` to continue reading. */
		offset: integer,
		truncated: boolean,
		dropped: integer,
	},
	{ open: true },
);
/** A user input waiting in the inbox; the preview is clipped by the host so the view stays bounded. */
export const QueuedInputSchema = obj(
	{
		id: integer,
		mode: oneOf(["steer", "followUp"]),
		preview: text,
		images: integer,
		skill: opt(obj({ name: text, args: text }, { open: true })),
	},
	{ open: true },
);
/** `text` is the full original input of a withdrawn message, for restoring the draft. */
export const WithdrawResultSchema = obj(
	{
		result: oneOf(["withdrawn", "placed", "settled", "unknown"]),
		text: opt(text),
		images: opt(integer),
	},
	{ open: true },
);
/** `steered` carries the input's new submission id; `withdrawn` only when it could not be re-admitted, with its text. */
export const SteerResultSchema = obj(
	{
		result: oneOf(["steered", "withdrawn", "placed", "settled", "unknown"]),
		id: opt(integer),
		text: opt(text),
		images: opt(integer),
	},
	{ open: true },
);
export const TodoItemSchema = obj({
	id: str({ minLength: 1, maxLength: TODO_LIMITS.idChars }),
	text: str({ minLength: 1, maxLength: TODO_LIMITS.textChars }),
	status: oneOf(["pending", "in_progress", "completed"]),
});
export const TodoListSchema = obj(
	{
		revision: integer,
		items: arr(TodoItemSchema, { maxItems: TODO_LIMITS.maxItems }),
	},
	{ open: true },
);
export const QuestionOptionSchema = obj({
	id: str({ minLength: 1, maxLength: QUESTION_LIMITS.optionIdChars }),
	label: str({ minLength: 1, maxLength: QUESTION_LIMITS.labelChars }),
	description: opt(str({ maxLength: QUESTION_LIMITS.descriptionChars })),
	recommended: opt(boolean),
});
const questionStatus = oneOf(["pending", "answered", "skipped", "cancelled"]);
/** Bounded entry of the pending list; the full record is read with `questionGet`. */
export const QuestionSummarySchema = obj(
	{
		id: integer,
		version: text,
		preview: str({ maxLength: QUESTION_LIMITS.previewChars }),
		multiple: boolean,
		optionCount: integer,
		createdAt: number,
	},
	{ open: true },
);
/** Wire bounds mirror core's browse and change limits; the host enforces the real ones before sending. */
const WorkspaceEntrySchema = obj({
	name: text,
	path: text,
	kind: oneOf(["file", "directory", "symlink"]),
	protected: opt(lit(true)),
});
export const WorkspaceDirSchema = obj(
	{
		path: text,
		entries: arr(WorkspaceEntrySchema, { maxItems: 1000 }),
		limited: boolean,
		incomplete: boolean,
	},
	{ open: true },
);
export const WorkspaceFileSchema = obj(
	{
		path: text,
		size: number,
		mtimeMs: number,
		kind: oneOf(["text", "binary", "protected"]),
		content: opt(text),
		truncated: boolean,
	},
	{ open: true },
);
export const ChangeSummarySchema = obj(
	{ revision: integer, files: integer, added: integer, removed: integer },
	{ open: true },
);
export const ChangedFileSchema = obj({
	path: text,
	outside: opt(lit(true)),
	ops: integer,
	added: integer,
	removed: integer,
	agents: arr(text, { maxItems: 64 }),
	lastSeq: integer,
});
export const ChangeListSchema = obj(
	{
		revision: integer,
		files: arr(ChangedFileSchema, { maxItems: 500 }),
		truncated: boolean,
	},
	{ open: true },
);
export const ChangeOpSchema = obj({
	seq: integer,
	agent: text,
	tool: oneOf(["edit", "write"]),
	diff: text,
	added: integer,
	removed: integer,
	truncated: boolean,
});
export const ChangeDetailSchema = obj(
	{
		path: text,
		outside: opt(lit(true)),
		ops: arr(ChangeOpSchema, { maxItems: 50 }),
		truncated: boolean,
	},
	{ open: true },
);
export const QuestionListSchema = obj(
	{
		revision: integer,
		pending: arr(QuestionSummarySchema, { maxItems: QUESTION_LIMITS.maxPending }),
	},
	{ open: true },
);
export const QuestionRecordSchema = obj(
	{
		id: integer,
		callId: text,
		version: text,
		question: str({ maxLength: QUESTION_LIMITS.questionChars }),
		multiple: boolean,
		options: arr(QuestionOptionSchema, { maxItems: QUESTION_LIMITS.maxOptions }),
		status: questionStatus,
		answer: union([
			obj(
				{
					optionIds: arr(str(), { maxItems: QUESTION_LIMITS.maxOptions }),
					text: union([str({ maxLength: QUESTION_LIMITS.textChars }), nil]),
				},
				{ open: true },
			),
			nil,
		]),
		createdAt: number,
		settledAt: union([number, nil]),
	},
	{ open: true },
);
export const QuestionResponseSchema = union([
	obj({
		kind: lit("answer"),
		optionIds: opt(arr(str(), { maxItems: QUESTION_LIMITS.maxOptions })),
		text: opt(str({ maxLength: QUESTION_LIMITS.textChars })),
	}),
	obj({ kind: lit("skip") }),
]);
export const PlanRecordSchema = obj(
	{
		version: text,
		title: str({ maxLength: PLAN_LIMITS.titleChars }),
		steps: arr(str({ maxLength: PLAN_LIMITS.stepChars }), { maxItems: PLAN_LIMITS.maxSteps }),
		note: str({ maxLength: PLAN_LIMITS.noteChars }),
		status: oneOf(["awaiting_approval", "approved", "revision_requested", "superseded", "cancelled"]),
		feedback: union([str({ maxLength: PLAN_LIMITS.feedbackChars }), nil]),
		createdAt: number,
		settledAt: union([number, nil]),
	},
	{ open: true },
);
export const PlanViewSchema = obj(
	{
		mode: oneOf(["normal", "plan"]),
		revision: integer,
		current: union([PlanRecordSchema, nil]),
	},
	{ open: true },
);
export const PlanDecisionSchema = union([
	obj({ kind: lit("approve") }),
	obj({ kind: lit("revise"), feedback: str({ minLength: 1, maxLength: PLAN_LIMITS.feedbackChars }) }),
]);
/** What a todo / ask_user call shows in history, from the persisted tool details. */
export const ToolInteractionSchema = union([
	obj(
		{
			kind: lit("ask_user"),
			id: integer,
			question: text,
			multiple: boolean,
			options: arr(obj({ id: text, label: text, recommended: opt(boolean) }, { open: true })),
			status: questionStatus,
			optionIds: opt(arr(text)),
			labels: opt(arr(text)),
			text: opt(union([text, nil])),
		},
		{ open: true },
	),
	obj(
		{
			kind: lit("todo"),
			action: oneOf(["list", "replace"]),
			revision: integer,
			completed: integer,
			total: integer,
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
export const ChatViewSchema = obj(
	{
		historyBefore: opt(union([integer, nil])),
		agents: opt(arr(SubagentSummarySchema)),
		/** Absent on a gateway without background jobs; empty means supported with none. */
		jobs: opt(arr(JobSummarySchema)),
		/** Absent on a gateway without queue visibility; empty means supported with none. */
		queued: opt(arr(QueuedInputSchema)),
		/** Absent on a gateway without todos; empty items means supported with none. */
		todos: opt(TodoListSchema),
		/** Absent on a gateway without ask_user; empty `pending` means supported with none. */
		questions: opt(QuestionListSchema),
		/** Absent on a gateway without plan mode; `current` is null before the first plan. */
		plan: opt(PlanViewSchema),
		/** Absent on a gateway without file change tracking; zero files means supported with none. */
		changes: opt(ChangeSummarySchema),
		rounds: opt(arr(DelegationSchema)),
		subagents: opt(arr(DelegationSchema)),
		taskUsage: opt(usage),
		model: text,
		agent: obj({ model: union([model, nil]), thinkingLevel: union([thinking, nil]) }, { open: true }),
		cwd: text,
		busy: boolean,
		status: nullableString,
		usage,
		contextUsage: opt(
			obj({ tokens: union([number, nil]), window: number, percent: union([number, nil]) }, { open: true }),
		),
		compaction: opt(
			obj(
				{
					failure: opt(
						obj({ taskId: integer, reason: oneOf(["manual", "threshold", "overflow"]), error: text }, { open: true }),
					),
					active: arr(
						obj(
							{
								taskId: integer,
								reason: oneOf(["manual", "threshold", "overflow"]),
								blocking: boolean,
								attempt: integer,
								retry: opt(obj({ at: number, error: text }, { open: true })),
							},
							{ open: true },
						),
					),
					latest: union([
						nil,
						obj(
							{
								taskId: integer,
								phase: oneOf([
									"summarizing",
									"waiting-to-apply",
									"applied",
									"nothing",
									"skipped",
									"cancelled",
									"failed",
								]),
								at: number,
							},
							{ open: true },
						),
					]),
				},
				{ open: true },
			),
		),
		/** Why the newest run ended without an answer; Pi's reason code as open text. */
		runFailure: opt(obj({ reason: text, detail: opt(text) }, { open: true })),
		/** Present when this gateway accepts `continueRun`; absent on an older gateway. */
		continuable: opt(lit(true)),
		items: arr(
			union([
				obj(
					{
						type: lit("user"),
						order: opt(number),
						key: text,
						id: integer,
						text: text,
						images: opt(arr(image)),
						skill: opt(skill),
						defaultImagePrompt: opt(obj({ version: int({ minimum: 1 }), text: text }, { open: true })),
					},
					{ open: true },
				),
				obj(
					{
						type: lit("assistant"),
						order: opt(number),
						key: text,
						id: integer,
						thinking: text,
						text: text,
						stopReason: nullableString,
						errorMessage: nullableString,
						note: nullableString,
					},
					{ open: true },
				),
				obj(
					{
						type: lit("tool"),
						order: opt(number),
						key: text,
						images: opt(arr(image)),
						callId: text,
						name: text,
						summary: text,
						detail: nullableString,
						phase,
						isError: boolean,
						output: nullableString,
						result: nullableString,
						durationMs: union([number, nil]),
						note: nullableString,
						diff: nullableString,
						diffAdded: union([number, nil]),
						diffRemoved: union([number, nil]),
						diffTruncated: opt(boolean),
						interaction: opt(ToolInteractionSchema),
						codemode: opt(CodemodeViewSchema),
					},
					{ open: true },
				),
				obj(
					{
						type: lit("system"),
						order: opt(number),
						key: text,
						id: integer,
						text: text,
						jobId: opt(text),
						planDecision: opt(obj({ version: text, kind: oneOf(["approve", "revise"]) })),
					},
					{ open: true },
				),
			]),
		),
		streaming: union([nil, obj({ thinking: text, text: text, toolCalls: arr(call) }, { open: true })]),
	},
	{ open: true },
);
export const SessionSummarySchema = obj(
	{
		workspaceRoot: text,
		lastUsedAt: number,
		title: text,
		firstPromptPreview: text,
		createdAt: number,
		lastMessageAt: union([number, nil]),
		model: union([model, nil]),
		status: oneOf(["idle", "running", "error"]),
		/** A question of this session waits for an answer; absent on a gateway that cannot tell. */
		awaitingAnswer: opt(boolean),
		/** A submitted plan of this idle session waits for approval; absent on a gateway without plan mode. */
		awaitingPlan: opt(boolean),
		id: text,
	},
	{ open: true },
);
export const DirectoryStateSchema = obj({ revision: integer, sessions: arr(SessionSummarySchema) }, { open: true });
export const WorkspaceSummarySchema = obj({ path: text, createdAt: number }, { open: true });
export const WorkspaceStateSchema = obj({ revision: integer, workspaces: arr(WorkspaceSummarySchema) }, { open: true });
const credentialStatus = obj(
	{
		savedConfigured: boolean,
		environmentConfigured: boolean,
		source: oneOf(["saved", "environment", "runtime", "keyless", "none"]),
		/** Model providers only: whether the user enabled the provider; absent for search credentials. */
		enabled: opt(boolean),
	},
	{ open: true },
);
export const CredentialStateSchema = obj(
	{
		revision: integer,
		/** Keyed by credential provider id from the core catalog. */
		statuses: map(credentialStatus),
	},
	{ open: true },
);
export const AttachmentSchema = obj({ sessionId: text, attachmentId: text }, { open: true });
const chatInput = obj({ sessionId: text, attachmentId: text });
export const NekoSessionDirectory = contract("neko.session-directory", {
	version: 1,
	input: obj({}),
	variants: { ready: { state: { state: DirectoryStateSchema } } },
});
export const NekoSessionManagement = contract("neko.session-management", {
	version: 1,
	input: obj({}),
	variants: {
		ready: {
			methods: {
				create: rpc(obj({ ...changeProperties, cwd: opt(text) }), SessionSummarySchema),
				archive: rpc(text, nil),
				attach: rpc(text, AttachmentSchema),
				detach: rpc(nil, nil),
				fork: rpc(text, SessionSummarySchema),
			},
		},
	},
});
const resize = obj(
	{
		maxWidth: opt(integer),
		maxHeight: opt(integer),
		maxBytes: opt(integer),
		jpegQuality: opt(integer),
	},
	{ open: true },
);
const inputLimits = obj(
	{
		maxRequestBytes: opt(integer),
		images: opt(
			obj(
				{
					resize: opt(resize),
					maxPerMessage: opt(integer),
					maxPerRequest: opt(integer),
				},
				{ open: true },
			),
		),
	},
	{ open: true },
);
const modelInfo = obj(
	{
		provider: text,
		modelId: text,
		name: text,
		/** Whether the model's provider has credentials. */
		available: boolean,
		contextWindow: number,
		input: arr(text),
		inputLimits: opt(inputLimits),
		reasoning: boolean,
		supportedThinkingLevels: arr(thinking),
		thinkingLevelAdjustments: obj(
			{
				off: thinking,
				minimal: thinking,
				low: thinking,
				medium: thinking,
				high: thinking,
				xhigh: thinking,
				max: thinking,
			},
			{ open: true },
		),
	},
	{ open: true },
);
export const NekoModels = contract("neko.models", {
	version: 1,
	input: obj({}),
	variants: { ready: { methods: { list: rpc(nil, arr(modelInfo)) } } },
});
const imageChunk = obj({ data: text, total: integer, mimeType: text }, { open: true });
export const NekoSubagent = contract("neko.subagent", {
	version: 1,
	input: obj(
		{
			sessionId: text,
			attachmentId: text,
			taskId: opt(integer),
			agentId: opt(text),
		},
		{ open: true },
	),
	variants: {
		ready: {
			state: { revision: integer },
			methods: {
				chunk: rpc(
					obj(
						{
							kind: oneOf(["view", "history"]),
							before: opt(integer),
							token: opt(integer),
							offset: integer,
						},
						{ open: true },
					),
					obj({ token: integer, data: text, next: union([integer, nil]) }, { open: true }),
				),
				getImage: rpc(obj({ entryId: integer, contentIndex: integer, offset: integer }, { open: true }), imageChunk),
				decideApproval: rpc(
					obj({ id: integer, version: text, decision: oneOf(["allowed", "denied"]) }, { open: true }),
					oneOf(["pending", "allowed", "denied", "cancelled"]),
				),
				stop: rpc(union([nil, obj({ taskId: integer }, { open: true })]), nil),
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
					obj({
						content: text,
						images: opt(arr(text, { maxItems: 4 })),
						requestId: opt(text),
						whenBusy: opt(oneOf(["steer", "followUp"])),
					}),
					nil,
				),
				abort: rpc(nil, nil),
				/** Run again on the context as it is after a run that ended without an answer. */
				continueRun: rpc(nil, nil),
				withdraw: rpc(obj({ id: integer }), WithdrawResultSchema),
				steer: rpc(obj({ id: integer }), SteerResultSchema),
				questionGet: rpc(obj({ id: integer }), union([QuestionRecordSchema, nil])),
				questionRespond: rpc(
					obj({ id: integer, version: text, response: QuestionResponseSchema }),
					QuestionRecordSchema,
				),
				planGet: rpc(obj({ version: text }), union([PlanRecordSchema, nil])),
				planRespond: rpc(obj({ version: text, decision: PlanDecisionSchema }), PlanRecordSchema),
				planMode: rpc(obj({ mode: oneOf(["normal", "plan"]) }), PlanViewSchema),
				usage: rpc(nil, usage),
				workspaceDir: rpc(obj({ path: text }), WorkspaceDirSchema),
				workspaceFile: rpc(obj({ path: text }), WorkspaceFileSchema),
				changesList: rpc(nil, ChangeListSchema),
				changeGet: rpc(obj({ path: text }), union([ChangeDetailSchema, nil])),
				skills: rpc(nil, arr(obj({ name: text, description: text, location: text, level }, { open: true }))),
				jobOutput: rpc(obj({ jobId: text, since: opt(integer) }), JobOutputSchema),
				jobStop: rpc(obj({ jobId: text }), JobSummarySchema),
				configure: rpc(change, nil),
				compact: rpc(obj({ instructions: opt(text) }), nil),
				importImage: rpc(text, obj({ id: text, name: text }, { open: true })),
				draftImage: rpc(obj({ id: text, offset: integer }), imageChunk),
				beginImage: rpc(obj({ name: text, mimeType: text, size: int({ minimum: 1, maximum: 20971520 }) }), text),
				appendImage: rpc(obj({ id: text, offset: integer, data: str({ maxLength: 350000 }) }), nil),
				finishImage: rpc(text, nil),
				releaseImage: rpc(text, nil),
				getImage: rpc(obj({ entryId: integer, contentIndex: integer, offset: integer }), imageChunk),
			},
		},
	},
});
const browse = obj({ path: text, query: opt(text), showHidden: opt(boolean), cursor: opt(text) });
const page = obj(
	{
		path: text,
		parent: nullableString,
		entries: arr(obj({ name: text, path: text, error: opt(text) }, { open: true })),
		next: nullableString,
	},
	{ open: true },
);
export const NekoWorkspaces = contract("neko.workspaces", {
	version: 2,
	input: obj({}),
	variants: {
		ready: {
			state: { state: WorkspaceStateSchema },
			methods: {
				add: rpc(obj({ path: text }), WorkspaceSummarySchema),
				remove: rpc(obj({ path: text }), nul()),
				browse: rpc(browse, page),
			},
		},
	},
});
const provider = str({ minLength: 1, maxLength: 64 });
export const NekoCredentials = contract("neko.credentials", {
	version: 2,
	input: obj({}),
	variants: {
		ready: {
			state: { state: CredentialStateSchema },
			methods: {
				save: rpc(obj({ provider, key: str({ minLength: 1, maxLength: 8192 }) }), nil),
				remove: rpc(obj({ provider }), nil),
				setEnabled: rpc(obj({ provider, enabled: boolean }), nil),
			},
		},
	},
});
export const SearchSettingsStateSchema = obj(
	{
		revision: integer,
		selected: oneOf(["tavily", "deepseek"]),
	},
	{ open: true },
);
export const NekoSearchSettings = contract("neko.search-settings", {
	version: 1,
	input: obj({}),
	variants: {
		ready: {
			state: { state: SearchSettingsStateSchema },
			methods: {
				set: rpc(obj({ provider: oneOf(["tavily", "deepseek"]) }), nil),
			},
		},
	},
});
const contextSource = oneOf(["default", "config", "saved"]);
export const ContextSettingsStateSchema = obj(
	{
		revision: integer,
		effective: obj(
			{
				compaction: obj(
					{
						enabled: boolean,
						triggerPercent: union([integer, nil]),
						keepRecentTokens: integer,
					},
					{ open: true },
				),
				pruning: obj(
					{
						enabled: boolean,
						triggerPercent: integer,
						keepRecent: integer,
						minChars: integer,
						minSavePercent: integer,
					},
					{ open: true },
				),
			},
			{ open: true },
		),
		sources: obj(
			{
				compaction: obj(
					{ enabled: contextSource, triggerPercent: contextSource, keepRecentTokens: contextSource },
					{ open: true },
				),
				pruning: obj(
					{
						enabled: contextSource,
						triggerPercent: contextSource,
						keepRecent: contextSource,
						minChars: contextSource,
						minSavePercent: contextSource,
					},
					{ open: true },
				),
			},
			{ open: true },
		),
	},
	{ open: true },
);
const nullable = <T>(schema: Schema<T>) => union([schema, nil]);
const ContextSettingsPatchSchema = obj({
	compaction: opt(
		obj({
			enabled: opt(nullable(boolean)),
			triggerPercent: opt(nullable(integer)),
			keepRecentTokens: opt(nullable(integer)),
		}),
	),
	pruning: opt(
		obj({
			enabled: opt(nullable(boolean)),
			triggerPercent: opt(nullable(integer)),
			keepRecent: opt(nullable(integer)),
			minChars: opt(nullable(integer)),
			minSavePercent: opt(nullable(integer)),
		}),
	),
});
export const NekoContextSettings = contract("neko.context-settings", {
	version: 1,
	input: obj({}),
	variants: {
		ready: {
			state: { state: ContextSettingsStateSchema },
			methods: {
				set: rpc(ContextSettingsPatchSchema, nil),
				reset: rpc(obj({}), nil),
			},
		},
	},
});
export const CodemodeSettingsStateSchema = obj(
	{
		revision: integer,
		effective: obj({ mode: oneOf([...CODEMODE_MODES]) }, { open: true }),
		source: oneOf(["default", "config", "saved"]),
	},
	{ open: true },
);
export const NekoCodemodeSettings = contract("neko.codemode-settings", {
	version: 1,
	input: obj({}),
	variants: {
		ready: {
			state: { state: CodemodeSettingsStateSchema },
			methods: {
				set: rpc(obj({ mode: oneOf([...CODEMODE_MODES]) }), nil),
				reset: rpc(obj({}), nil),
			},
		},
	},
});
const defaultModelSource = oneOf(["cli", "saved", "config", "default"]);
export const DefaultModelStateSchema = obj(
	{
		effective: model,
		source: defaultModelSource,
	},
	{ open: true },
);
export const NekoDefaultModel = contract("neko.default-model", {
	version: 1,
	input: obj({}),
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
export const FileCandidatesSchema = obj(
	{
		entries: arr(obj({ name: text, path: text, kind: oneOf(["file", "directory"]) }, { open: true }), {
			maxItems: 100,
		}),
		limited: boolean,
		incomplete: boolean,
	},
	{ open: true },
);
export const NekoWorkspaceFiles = contract("neko.workspace-files", {
	version: 1,
	input: obj({}),
	variants: {
		ready: {
			methods: {
				search: rpc(obj({ workspaceRoot: text, query: text }), FileCandidatesSchema),
			},
		},
	},
});
const marketSkill = obj(
	{
		name: text,
		description: text,
		category: text,
		source: text,
		license: text,
		version: text,
		sha256: text,
		sizeBytes: integer,
		uploadedAt: text,
		installed: obj({ project: boolean, user: boolean, builtin: boolean }, { open: true }),
		activeLevel: union([level, nil]),
	},
	{ open: true },
);
const preview = obj({ body: text, files: arr(text) }, { open: true });
const scope = oneOf(["user", "project"]);
const installResult = obj({ name: text, scope, path: text, shadowedBy: opt(scope) }, { open: true });
export const NekoSkillMarket = contract("neko.skill-market", {
	version: 1,
	input: obj({}),
	variants: {
		ready: {
			methods: {
				list: rpc(obj({ query: opt(text), workspaceRoot: opt(text) }), arr(marketSkill)),
				detail: rpc(obj({ name: text, workspaceRoot: opt(text) }), marketSkill),
				preview: rpc(obj({ name: text }), preview),
				install: rpc(obj({ name: text, scope, workspaceRoot: opt(text), overwrite: opt(boolean) }), installResult),
				uninstall: rpc(obj({ name: text, scope, workspaceRoot: opt(text) }), nil),
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
export type WireRunFailure = NonNullable<Static<typeof ChatViewSchema>["runFailure"]>;
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
export type NekoCodemodeSettings = Ref<typeof NekoCodemodeSettings>;
export type NekoCodemodeSettingsState = Static<typeof CodemodeSettingsStateSchema>;
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
export const ShellStatusSchema = union([
	obj({ status: lit("ready"), path: text, source: oneOf(["config", "auto"]) }, { open: true }),
	obj(
		{
			status: lit("missing"),
			reason: oneOf(["not_found", "invalid_config"]),
			detail: opt(text),
		},
		{ open: true },
	),
]);
export type NekoShellStatus = Static<typeof ShellStatusSchema>;

/** Stable bootstrap contract: keep this available even when business protocol changes. */
export const ApplicationInfoSchema = obj(
	{
		runningVersion: text,
		installedVersion: nullableString,
		protocolVersion: int({ minimum: 1 }),
		latestVersion: nullableString,
		checkedAt: union([integer, nil]),
		checkState: oneOf(["unknown", "checking", "ok", "failed", "development"]),
		serverId: text,
		shell: opt(ShellStatusSchema),
	},
	{ open: true },
);
export const NekoApplicationInfo = contract("neko.application-info", {
	version: 1,
	input: obj({}, { open: true }),
	variants: {
		ready: { state: { info: ApplicationInfoSchema }, methods: { check: rpc(nil, ApplicationInfoSchema) } },
	},
});
export type NekoApplicationInfo = Ref<typeof NekoApplicationInfo>;
