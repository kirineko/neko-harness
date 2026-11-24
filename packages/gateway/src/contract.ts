/** Browser-safe Chord v2 contracts. All wire values are validated schemas. */
import {
	type Contract,
	str as chordStr,
	type Held,
	hostKind,
	method,
	type Reference,
	remote,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
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
import { MCP_EXPOSURES, MCP_SERVER_STATUSES, MCP_SIGN_IN_STATUSES, MCP_TRANSPORTS } from "@neko-harness/core/mcp";

/** Every gateway service lives on the one host kind that serves it; the server id is verified through application info. */
export const GatewayKind = hostKind("neko");
export const GATEWAY_ADDRESS = GatewayKind();

/** Makes `context` optional on a Chord `Reference` or `Held` method, defaulting to `BACKGROUND_CONTEXT`. */
export type ClientMethod<F> = F extends (context: Context) => Promise<infer R>
	? (context?: Context) => Promise<R>
	: F extends (args: infer A, context: Context) => Promise<infer R>
		? (args: A, context?: Context) => Promise<R>
		: F;

export type ClientWrapped<R> = {
	readonly [K in keyof R]: K extends "release" | "retry" | "state" | "variant" ? R[K] : ClientMethod<R[K]>;
};

export type ClientRef<C extends Contract> = ClientWrapped<Reference<C>>;
export type ClientHeld<C extends Contract> = ClientWrapped<Held<C>>;

function wrapRawRef<T extends object>(raw: T): T {
	return new Proxy(raw, {
		get(target, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "release" || prop === "retry") return value.bind(target);
			// Chord's built reference methods have length 1 `(context)` for no-arg methods and length 2 `(args, context)` otherwise.
			if (value.length === 1) {
				return (context?: Context) => (value as (c: Context) => unknown).call(target, context ?? BACKGROUND_CONTEXT);
			}
			return (args: unknown, context?: Context) =>
				(value as (a: unknown, c: Context) => unknown).call(target, args, context ?? BACKGROUND_CONTEXT);
		},
	});
}

export function wrapClientRef<R extends object>(ref: R): ClientWrapped<R> {
	return wrapRawRef(ref) as unknown as ClientWrapped<R>;
}

export function wrapClientHeld<R extends object>(ref: R): ClientWrapped<R> {
	return wrapRawRef(ref) as unknown as ClientWrapped<R>;
}

/** Encodes a subagent target (round `taskId` or `agentId`) into Chord v2's flat required `target` param. */
export function encodeSubagentTarget(target: number | string): string {
	return typeof target === "number" ? `round:${target}` : `agent:${target}`;
}

export type DecodedSubagentTarget =
	| { readonly kind: "round"; readonly taskId: number }
	| { readonly kind: "agent"; readonly agentId: string };

/** Decodes `NekoSubagent`'s flat `target` param; returns `undefined` for malformed values. */
export function decodeSubagentTarget(target: string): DecodedSubagentTarget | undefined {
	if (target.startsWith("round:")) {
		const raw = target.slice("round:".length);
		if (!/^\d+$/.test(raw)) return undefined;
		const taskId = Number(raw);
		return Number.isSafeInteger(taskId) ? { kind: "round", taskId } : undefined;
	}
	if (target.startsWith("agent:")) {
		const agentId = target.slice("agent:".length);
		return agentId.length > 0 ? { kind: "agent", agentId } : undefined;
	}
	return undefined;
}

const paramStr = chordStr();
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
const modelInput = obj({ provider: text, modelId: text });
const changeProperties = { model: opt(modelInput), thinkingLevel: opt(thinking) };
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

export const NekoSessionDirectory = remote("neko.session-directory", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: { ready: { state: { snapshot: DirectoryStateSchema } } },
});

export const NekoSessionManagement = remote("neko.session-management", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			methods: {
				create: method(obj({ ...changeProperties, cwd: opt(text) }), SessionSummarySchema),
				archive: method(text, nil),
				attach: method(text, AttachmentSchema),
				detach: method(),
				fork: method(text, SessionSummarySchema),
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

export const NekoModels = remote("neko.models", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: { ready: { methods: { list: method(undefined, arr(modelInfo)) } } },
});

const imageChunk = obj({ data: text, total: integer, mimeType: text }, { open: true });

export const NekoSubagent = remote("neko.subagent", {
	version: 1,
	params: {
		sessionId: paramStr,
		attachmentId: paramStr,
		target: paramStr,
	},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { revision: integer },
			methods: {
				chunk: method(
					obj({
						kind: oneOf(["view", "history"]),
						before: opt(integer),
						token: opt(integer),
						offset: integer,
					}),
					obj({ token: integer, data: text, next: union([integer, nil]) }, { open: true }),
				),
				getImage: method(obj({ entryId: integer, contentIndex: integer, offset: integer }), imageChunk),
				decideApproval: method(
					obj({ id: integer, version: text, decision: oneOf(["allowed", "denied"]) }),
					oneOf(["pending", "allowed", "denied", "cancelled"]),
				),
				stop: method(union([nil, obj({ taskId: integer })]), nil),
			},
		},
	},
});
export type NekoSubagent = ClientHeld<typeof NekoSubagent>;

export const NekoChat = remote("neko.chat", {
	version: 1,
	params: { sessionId: paramStr, attachmentId: paramStr },
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { view: ChatViewSchema },
			methods: {
				submit: method(
					obj({
						content: text,
						images: opt(arr(text, { maxItems: 4 })),
						requestId: opt(text),
						whenBusy: opt(oneOf(["steer", "followUp"])),
					}),
					nil,
				),
				abort: method(),
				/** Run again on the context as it is after a run that ended without an answer. */
				continueRun: method(),
				withdraw: method(obj({ id: integer }), WithdrawResultSchema),
				steer: method(obj({ id: integer }), SteerResultSchema),
				questionGet: method(obj({ id: integer }), union([QuestionRecordSchema, nil])),
				questionRespond: method(
					obj({ id: integer, version: text, response: QuestionResponseSchema }),
					QuestionRecordSchema,
				),
				planGet: method(obj({ version: text }), union([PlanRecordSchema, nil])),
				planRespond: method(obj({ version: text, decision: PlanDecisionSchema }), PlanRecordSchema),
				planMode: method(obj({ mode: oneOf(["normal", "plan"]) }), PlanViewSchema),
				usage: method(undefined, usage),
				workspaceDir: method(obj({ path: text }), WorkspaceDirSchema),
				workspaceFile: method(obj({ path: text }), WorkspaceFileSchema),
				changesList: method(undefined, ChangeListSchema),
				changeGet: method(obj({ path: text }), union([ChangeDetailSchema, nil])),
				skills: method(undefined, arr(obj({ name: text, description: text, location: text, level }, { open: true }))),
				jobOutput: method(obj({ jobId: text, since: opt(integer) }), JobOutputSchema),
				jobStop: method(obj({ jobId: text }), JobSummarySchema),
				configure: method(change, nil),
				compact: method(obj({ instructions: opt(text) }), nil),
				importImage: method(text, obj({ id: text, name: text }, { open: true })),
				draftImage: method(obj({ id: text, offset: integer }), imageChunk),
				beginImage: method(obj({ name: text, mimeType: text, size: int({ minimum: 1, maximum: 20971520 }) }), text),
				appendImage: method(obj({ id: text, offset: integer, data: str({ maxLength: 350000 }) }), nil),
				finishImage: method(text, nil),
				releaseImage: method(text, nil),
				getImage: method(obj({ entryId: integer, contentIndex: integer, offset: integer }), imageChunk),
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

export const NekoWorkspaces = remote("neko.workspaces", {
	version: 2,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { snapshot: WorkspaceStateSchema },
			methods: {
				add: method(obj({ path: text }), WorkspaceSummarySchema),
				remove: method(obj({ path: text }), nul()),
				browse: method(browse, page),
			},
		},
	},
});

const provider = str({ minLength: 1, maxLength: 64 });
export const NekoCredentials = remote("neko.credentials", {
	version: 2,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { snapshot: CredentialStateSchema },
			methods: {
				save: method(obj({ provider, key: str({ minLength: 1, maxLength: 8192 }) }), nil),
				remove: method(obj({ provider }), nil),
				setEnabled: method(obj({ provider, enabled: boolean }), nil),
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
export const NekoSearchSettings = remote("neko.search-settings", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { snapshot: SearchSettingsStateSchema },
			methods: {
				set: method(obj({ provider: oneOf(["tavily", "deepseek"]) }), nil),
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
export const NekoContextSettings = remote("neko.context-settings", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { snapshot: ContextSettingsStateSchema },
			methods: {
				set: method(ContextSettingsPatchSchema, nil),
				reset: method(obj({}), nil),
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
export const NekoCodemodeSettings = remote("neko.codemode-settings", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { snapshot: CodemodeSettingsStateSchema },
			methods: {
				set: method(obj({ mode: oneOf([...CODEMODE_MODES]) }), nil),
				reset: method(obj({}), nil),
			},
		},
	},
});

const mcpExposure = oneOf([...MCP_EXPOSURES]);
const mcpTransport = oneOf([...MCP_TRANSPORTS]);
const mcpServerStatus = oneOf([...MCP_SERVER_STATUSES]);
const mcpSignInStatus = oneOf([...MCP_SIGN_IN_STATUSES]);

const mcpOAuthInputFields = {
	clientId: opt(text),
	clientSecret: opt(text),
	callbackPort: opt(int({ minimum: 1, maximum: 65535 })),
	callbackUrl: opt(text),
	scope: opt(text),
	clientName: opt(text),
	clientRegistration: opt(oneOf(["auto", "dcr"])),
	authServerMetadataUrl: opt(text),
};
const mcpBaseConfigFields = {
	enabled: opt(boolean),
	description: opt(text),
	timeout: opt(num()),
	exposure: opt(mcpExposure),
};
const mcpKeyValue = obj({ key: text, value: text });
export const McpServerConfigInputSchema = union([
	obj({
		transport: lit("stdio"),
		command: text,
		args: opt(arr(text)),
		env: opt(arr(mcpKeyValue)),
		cwd: opt(text),
		...mcpBaseConfigFields,
	}),
	obj({
		transport: lit("http"),
		url: text,
		headers: opt(arr(mcpKeyValue)),
		oauth: opt(obj(mcpOAuthInputFields)),
		...mcpBaseConfigFields,
	}),
]);
const McpServerConfigStateSchema = union([
	obj(
		{
			transport: lit("stdio"),
			command: text,
			args: opt(arr(text)),
			env: opt(map(text)),
			cwd: opt(text),
			...mcpBaseConfigFields,
		},
		{ open: true },
	),
	obj(
		{
			transport: lit("http"),
			url: text,
			headers: opt(map(text)),
			oauth: opt(obj(mcpOAuthInputFields, { open: true })),
			...mcpBaseConfigFields,
		},
		{ open: true },
	),
]);
export const McpToolInfoSchema = obj(
	{
		name: text,
		registeredName: text,
		title: opt(text),
		description: text,
		readOnly: boolean,
	},
	{ open: true },
);
export const McpServerSnapshotSchema = obj(
	{
		name: text,
		transport: mcpTransport,
		enabled: boolean,
		exposure: mcpExposure,
		config: McpServerConfigStateSchema,
		status: mcpServerStatus,
		error: nullableString,
		stderrTail: text,
		tools: arr(McpToolInfoSchema),
		oauth: obj({ supported: boolean, signedIn: boolean }, { open: true }),
	},
	{ open: true },
);
export const McpSignInSnapshotSchema = obj(
	{
		id: text,
		server: text,
		status: mcpSignInStatus,
		authorizationUrl: text,
		error: nullableString,
	},
	{ open: true },
);
export const McpStateSchema = obj(
	{
		revision: integer,
		configPath: text,
		configError: nullableString,
		entryErrors: arr(text),
		rawJson: text,
		servers: arr(McpServerSnapshotSchema),
		signIns: arr(McpSignInSnapshotSchema),
	},
	{ open: true },
);
export const McpBeginSignInResultSchema = union([
	obj({ status: lit("authorized") }, { open: true }),
	obj({ status: lit("redirect"), id: text, authorizationUrl: text }, { open: true }),
]);
export const NekoMcp = remote("neko.mcp", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { snapshot: McpStateSchema },
			methods: {
				upsertServer: method(obj({ name: text, config: McpServerConfigInputSchema }), McpStateSchema),
				removeServer: method(obj({ name: text }), McpStateSchema),
				setEnabled: method(obj({ name: text, enabled: boolean }), McpStateSchema),
				saveRawConfig: method(obj({ rawJson: text }), McpStateSchema),
				reconnect: method(obj({ name: text }), McpStateSchema),
				beginSignIn: method(obj({ server: text }), McpBeginSignInResultSchema),
				pasteSignIn: method(obj({ id: text, redirectUrl: text }), McpStateSchema),
				cancelSignIn: method(obj({ id: text }), McpStateSchema),
				signOut: method(obj({ server: text }), McpStateSchema),
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
export const NekoDefaultModel = remote("neko.default-model", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			state: { snapshot: DefaultModelStateSchema },
			methods: {
				set: method(modelInput, nil),
				clear: method(),
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
export const NekoWorkspaceFiles = remote("neko.workspace-files", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			methods: {
				search: method(obj({ workspaceRoot: text, query: text }), FileCandidatesSchema),
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
export const NekoSkillMarket = remote("neko.skill-market", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: {
			methods: {
				list: method(obj({ query: opt(text), workspaceRoot: opt(text) }), arr(marketSkill)),
				detail: method(obj({ name: text, workspaceRoot: opt(text) }), marketSkill),
				preview: method(obj({ name: text }), preview),
				install: method(obj({ name: text, scope, workspaceRoot: opt(text), overwrite: opt(boolean) }), installResult),
				uninstall: method(obj({ name: text, scope, workspaceRoot: opt(text) }), nil),
			},
		},
	},
});

export type NekoSessionDirectory = ClientHeld<typeof NekoSessionDirectory>;
export type NekoSessionManagement = ClientHeld<typeof NekoSessionManagement>;
export type NekoModels = ClientHeld<typeof NekoModels>;
export type NekoChat = ClientHeld<typeof NekoChat>;
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
export type NekoWorkspaces = ClientHeld<typeof NekoWorkspaces>;
export type NekoWorkspaceFiles = ClientHeld<typeof NekoWorkspaceFiles>;
export type NekoCredentials = ClientHeld<typeof NekoCredentials>;
export type NekoSearchSettings = ClientHeld<typeof NekoSearchSettings>;
export type NekoContextSettings = ClientHeld<typeof NekoContextSettings>;
export type NekoCodemodeSettings = ClientHeld<typeof NekoCodemodeSettings>;
export type NekoCodemodeSettingsState = Static<typeof CodemodeSettingsStateSchema>;
export type NekoMcp = ClientHeld<typeof NekoMcp>;
export type NekoMcpState = Static<typeof McpStateSchema>;
export type NekoMcpServer = Static<typeof McpServerSnapshotSchema>;
export type NekoMcpSignIn = Static<typeof McpSignInSnapshotSchema>;
export type NekoMcpBeginSignInResult = Static<typeof McpBeginSignInResultSchema>;
export type NekoMcpServerConfigInput = Static<typeof McpServerConfigInputSchema>;
export type NekoDefaultModel = ClientHeld<typeof NekoDefaultModel>;
export type NekoDefaultModelState = Static<typeof DefaultModelStateSchema>;
export type NekoSkillMarket = ClientHeld<typeof NekoSkillMarket>;
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
export const NekoApplicationInfo = remote("neko.application-info", {
	version: 1,
	params: {},
	hostAddress: () => GATEWAY_ADDRESS,
	variants: {
		ready: { state: { info: ApplicationInfoSchema }, methods: { check: method(undefined, ApplicationInfoSchema) } },
	},
});
export type NekoApplicationInfo = ClientHeld<typeof NekoApplicationInfo>;
