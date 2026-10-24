import { homedir } from "node:os";
import { join } from "node:path";
import type { AttachedReplicatedState, Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	CredentialStore,
	ModelInputLimits,
	ModelThinkingLevel,
	Provider,
	UserMessage,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { PI_ATTRIBUTION } from "@earendil-works/pi-ai/utils/identity";
import {
	type AgentEventStream,
	AssistantEntry,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	type ConversationView,
	type ConversationWatch,
	type Cursor,
	createRegistry,
	defineDoc,
	type Extension,
	Harness,
	InboxDoc,
	type InputEntry,
	LiveDoc as importLiveDoc,
	MemoryStorage,
	type Submission,
	type SubmissionId,
	type Tx,
	UsageDoc,
	type UsageState,
	watchEvents,
} from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { AgentFileSearch } from "./agent-file-search.ts";
import { type CompactionRecord, readCompaction } from "./compaction.ts";
import { ContextPruner } from "./context-pruning.ts";
import {
	applyContextPatch,
	type ContextSettings,
	type ContextSettingsPatch,
	type ContextSettingsState,
	createCompactionPolicy,
	emptySavedContextSettings,
	parseContextSettingsPatch,
	resolveContextSettings,
	type SavedContextSettings,
	sanitizeSavedContextSettings,
} from "./context-settings.ts";
import {
	type CredentialProviderId,
	type CredentialStatus,
	credentialProvider,
	FileCredentialStore,
	InMemoryCredentialStore,
	isModelProvider,
	LOCKED_PROVIDERS,
	MODEL_PROVIDERS,
	type ModelProviderId,
	normalizeEnabledProviders,
} from "./credentials.ts";
import { type ChangeDetail, type ChangeList, type ChangeSummary, ChangeTracker } from "./file-changes.ts";
import { ImageDetails } from "./image-metadata.ts";
import { addDefaultImagePrompt } from "./image-prompt.ts";
import { imagePrompt, prepareInput } from "./images.ts";
import { type InputData, NekoInput } from "./input.ts";
import {
	type PlanDecision,
	type PlanMode,
	type PlanRecord,
	type PlanView,
	type QuestionList,
	type QuestionRecord,
	type QuestionResponse,
	type TodoList,
	validatePlanDecision,
} from "./interactions.ts";
import { JobManager } from "./job-engine.ts";
import { type JobOutputRead, type JobSummary, JobsDoc, summarizeJobRecord } from "./jobs.ts";
import {
	agentInPlanMode,
	approvedPlanPrompt,
	createPlanExtension,
	PLAN_BUSY,
	PlanService,
	planAgentChange,
	planRevisionPrompt,
} from "./plan.ts";
import type { PlanItem } from "./plan-doc.ts";
import { totalUsage } from "./projection.ts";
import { expandSkillCommand } from "./prompt/invoke.ts";
import { createNekoPrompt } from "./prompt/prompt.ts";
import { createResourceLoader, scanSkillsByLevel } from "./prompt/resources.ts";
import type { SkillLevel } from "./prompt/skills.ts";
import { createResourceSnapshots } from "./prompt/snapshots.ts";
import { queuedUserInput } from "./queued.ts";
import {
	DEFAULT_SEARCH_PROVIDER,
	isSearchProvider,
	type SearchProviderId,
	type SearchSettings,
} from "./search-providers.ts";
import { mergeUsage, SessionMetadataDoc, SessionMetadataManager } from "./session-metadata.ts";
import { subagentUsageTotals, subtractSubagentUsage } from "./subagent-usage.ts";
import {
	createSubagentExtension,
	DelegationsDoc,
	installSubagentCoordinator,
	refreshDelegations,
	removeMainOnlyTools,
} from "./subagents.ts";
import { createTodoExtension, TodosDoc } from "./todos.ts";
import { createApprovalExtension, prepareApprovalConversations, ToolApprovals } from "./tool-approvals.ts";
import { createQuestionExtension, UserQuestions } from "./user-questions.ts";
import { createDeepseekProvider } from "./web-search/deepseek.ts";
import { createWebSearchTools } from "./web-search/index.ts";
import { createTavilyProvider } from "./web-search/tavily.ts";
import {
	createWindowsShellResolver,
	summarizeWindowsShell,
	type WindowsShellResolver,
	type WindowsShellSummary,
} from "./windows-shell.ts";
import {
	accessibleWorkspace,
	executionWorkspace,
	type NekoWorkspace,
	normalizeWorkspace,
	savedWorkspace,
	WORKSPACE_BUSY,
	WORKSPACE_LAST,
	WORKSPACE_UNKNOWN,
} from "./workspace.ts";
import { type DirChildren, type FileContent, WorkspaceFiles } from "./workspace-files.ts";

/** The built-in DeepSeek chat model used when the caller does not choose one. */
export const DEFAULT_MODEL = { provider: "deepseek", modelId: "deepseek-flash" } as const;

/** Default SQLite storage file: ~/.neko/neko.sqlite. */
export const DEFAULT_STORAGE_PATH = join(homedir(), ".neko", "neko.sqlite");

export type NekoModelRef = {
	readonly provider: string;
	readonly modelId: string;
};

/** Which link of the default-model chain produced the effective model. */
export type NekoDefaultModelSource = "cli" | "saved" | "config" | "default";
/** The effective default model for new sessions, with the chain link that produced it. */
export type NekoDefaultModelState = {
	readonly effective: NekoModelRef;
	readonly source: NekoDefaultModelSource;
};

export type NekoRuntimeOptions = {
	/** Chord context for every runtime call; default `BACKGROUND_CONTEXT` (never cancels). */
	readonly context?: Context;
	readonly onReport?: (error: unknown) => void;
	/** "sqlite" persists to disk (default); "memory" keeps everything in process, for tests. */
	readonly storage?: "sqlite" | "memory";
	/** SQLite file path; default `~/.neko/neko.sqlite`. */
	readonly storagePath?: string;
	/** Explicit in-memory DeepSeek override; never persisted or written to process.env. */
	readonly apiKey?: string;
	/** Explicit in-memory Tavily override for the web-search tools; never persisted or written to process.env. */
	readonly tavilyApiKey?: string;
	readonly credentials?: CredentialStore;
	readonly credentialsPath?: string;
	/** Search provider used until the user saves a choice (config `webSearch.provider`); default "tavily". */
	readonly searchProvider?: SearchProviderId;
	/** Config-file context settings (compaction trigger, tool result pruning); saved UI values take precedence. */
	readonly contextSettings?: ContextSettings;
	/** Model the root conversation runs with; default the built-in DeepSeek chat model. */
	readonly model?: NekoModelRef;
	/** Explicit per-launch override (CLI `--model`); wins over the saved default and the config value for new sessions. */
	readonly modelOverride?: NekoModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	/** Working directory of the conversation's tools; default `process.cwd()`. */
	readonly cwd?: string;
	/** Extra pi-ai providers registered next to the built-in DeepSeek one. */
	readonly providers?: readonly Provider[];
	/** Extra extensions installed after CodingTools, e.g. custom tools; tests use this with the faux provider. */
	readonly extensions?: readonly Extension[];
	/** User-level resources root for the prompt extension (`<home>/.agents`); defaults to the OS home. Tests override for isolation. */
	readonly promptHome?: string;
	/** Windows: bash.exe for commands (config `shell.path`); ignored on other platforms. */
	readonly shellPath?: string;
	/** Replaces the Windows Git Bash probe; tests inject it to exercise the Windows path on any platform. */
	readonly shellResolver?: WindowsShellResolver;
	/** Shortens built-in waits so tests need not sit through them; not exposed by the CLI or the config file. */
	readonly timings?: NekoRuntimeTimings;
};

export type NekoRuntimeTimings = {
	/** How long `job start` waits for an early exit; default `JOB_LIMITS.startWindowMs`. */
	readonly jobStartWindowMs?: number;
	/** Per-attempt timeout of the session title request; default 20s. */
	readonly namingRequestTimeoutMs?: number;
	/** Wait before the second title attempt; default 2s. */
	readonly namingRetryDelayMs?: number;
	/** Base delay of Pi's durable generation retry; default is Pi's own. */
	readonly retryBaseDelayMs?: number;
};

export type NekoSubmitOptions = {
	readonly requestId?: string;
	readonly imageNames?: readonly string[];
	readonly whenBusy?: "steer" | "followUp" | "reject";
};

/** `placed`: already in the transcript; `settled`: already finished; `unknown`: not a queued user input of this session. */
export type NekoWithdrawResult = "withdrawn" | "placed" | "settled" | "unknown";
/** A withdrawn input returns its full text (skills in their typed `/skill:` form) so a frontend can restore the draft. */
export type NekoWithdrawal = { result: NekoWithdrawResult; text?: string; images?: number };
/** `steered`: the queued input now waits as a steer (`id` is its new submission id); `withdrawn` only when it could not be re-admitted. */
export type NekoSteering = { result: "steered" | NekoWithdrawResult; id?: number; text?: string; images?: number };

/** Terminal outcome of one submitted input, with the answer text already extracted. */
export type NekoAnswer =
	| { readonly status: "done"; readonly text: string }
	| { readonly status: "unanswered"; readonly reason: string; readonly detail?: string };

/** One conversation of a runtime: the handle plus the per-session operations frontends subscribe to. */
export type NekoSession = {
	/** Conversation identity; compare by `id`. */
	readonly id: ConversationId;
	/** The underlying pi-durable conversation. */
	readonly conversation: Conversation;
	/** Durably admit user input; the returned submission settles when the run answers it. */
	submit(content: UserMessage["content"], options?: NekoSubmitOptions): Promise<Submission>;
	/** Wait for a submission and extract the answer text. */
	waitAnswer(submission: Submission): Promise<NekoAnswer>;
	/** The conversation's structural view as a read-only Chord state, updated after every commit. */
	viewState(): Promise<AttachedReplicatedState<ConversationView>>;
	/** The structural view as a serialized exact-frame watch with bounded pending frames. */
	watch(): Promise<ConversationWatch>;
	/** Coding-agent style agent events (message/tool deltas) for this conversation. */
	events(): Promise<AgentEventStream>;
	/** Token and cost totals of this conversation's `pi.usage`. */
	usage(): Promise<UsageState>;
	/** Withdraw queued inputs and abort the current run. */
	abort(): Promise<void>;
	/** Withdraw one queued user input (`ChatView.queued[].id`) without touching the run or the other queued inputs. */
	withdraw(submissionId: number): Promise<NekoWithdrawal>;
	/** Turn one queued user input into a steer (placed after the current tool round) without stopping the run. */
	steer(submissionId: number): Promise<NekoSteering>;
	compact(instructions?: string): Promise<void>;
	compactionRecord(): Promise<CompactionRecord | null>;
	/** Background jobs of this session: running ones and the latest terminal ones, without output. */
	jobs(): Promise<JobSummary[]>;
	/** Bounded output of one job, resuming after `since`; rejects for an unknown job. */
	jobOutput(jobId: string, since?: number): Promise<{ job: JobSummary; output: JobOutputRead }>;
	/** Stop one job of this session; an ended job is returned as it is, an unknown one rejects. */
	stopJob(jobId: string): Promise<JobSummary>;
	/** The model-maintained todo list; empty before the first `todo` call. */
	todos(): Promise<TodoList>;
	/** Questions waiting for the user (bounded summaries) with the index revision. */
	questions(): Promise<QuestionList>;
	/** One full question record; `undefined` when this session has no such question. */
	question(id: number): Promise<QuestionRecord | undefined>;
	/** Answer or skip a question; the first valid decision wins and later calls return it unchanged. */
	respondQuestion(id: number, version: string, response: QuestionResponse): Promise<QuestionRecord>;
	/** Plan mode and the newest submitted plan. */
	plan(): Promise<PlanView>;
	/** One plan by version; `undefined` when this session has no such plan. */
	planRecord(version: string): Promise<PlanRecord | undefined>;
	/** Enter or leave plan mode; only an idle session accepts it (`PLAN_BUSY`). Leaving cancels a waiting plan. */
	setPlanMode(mode: PlanMode): Promise<PlanView>;
	/**
	 * Approve or ask for changes to a plan. The first valid decision wins and later calls return it unchanged.
	 * Approval leaves plan mode and submits the execute input exactly once; changes keep plan mode and submit the feedback.
	 */
	respondPlan(version: string, decision: PlanDecision): Promise<PlanRecord>;
	/** Direct children of one workspace directory ("" is the root), read-only and bounded. */
	workspaceDir(path: string, signal?: AbortSignal): Promise<DirChildren>;
	/** Text content of one workspace file; credential and binary files return a kind without content. */
	workspaceFile(path: string, signal?: AbortSignal): Promise<FileContent>;
	/** Small summary of the files agents changed through edit/write (main agent and subagents). */
	changeSummary(): Promise<ChangeSummary>;
	/** Changed files, most recent first. */
	changes(): Promise<ChangeList>;
	/** Every recorded edit/write of one changed file (workspace-relative, or absolute when outside); `undefined` if none. */
	change(path: string): Promise<ChangeDetail | undefined>;
};

/** Directory entry of `listConversations()`. */
export type NekoConversationInfo = {
	readonly id: ConversationId;
	/** Archived conversations are hidden from listings and lookups (soft delete). */
	readonly archived: boolean;
	readonly workspaceRoot: string;
	readonly lastUsedAt: number;
	readonly title: string;
	readonly firstPromptPreview: string;
	readonly createdAt: number;
	readonly lastMessageAt: number | null;
	readonly model: NekoModelRef | null;
	readonly status: "idle" | "running" | "error";
	/** A question of this running session waits for the user's answer. */
	readonly awaitingAnswer: boolean;
	/** A submitted plan of this idle session waits for approval. */
	readonly awaitingPlan: boolean;
};

/** A chat model offered by the runtime's Models registry, for frontend selectors. */
/** A model offered for selection; `available` means its provider has credentials. */
export type NekoSelectableModel = NekoModelInfo & { readonly available: boolean };

export type NekoModelInfo = {
	readonly provider: string;
	readonly modelId: string;
	readonly name: string;
	readonly contextWindow: number;
	readonly input: readonly string[];
	readonly inputLimits?: ModelInputLimits;
	/** Whether the model supports thinking/reasoning levels. */
	readonly reasoning: boolean;
	readonly supportedThinkingLevels: readonly ModelThinkingLevel[];
	readonly thinkingLevelAdjustments: Record<ModelThinkingLevel, ModelThinkingLevel>;
};

/** One skill offered by a conversation's workspace, for frontend completion. */
export type NekoSkillInfo = {
	readonly name: string;
	readonly description: string;
	/** Absolute path of the SKILL.md file. */
	readonly location: string;
	/** Discovery level this skill was resolved from (project > user > builtin). */
	readonly level: SkillLevel;
};

/** What one conversation currently runs with (resolved agent). */
export type NekoAgentInfo = {
	readonly cwd: string;
	readonly model?: NekoModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	/** Names of the selected extensions, in effect order. */
	readonly extensions: readonly string[];
};

/** Changes `configureConversation` applies to one conversation's agent. */
export type NekoConversationChange = {
	readonly model?: NekoModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
};

export type NekoCreateConversationOptions = {
	readonly model?: NekoModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly cwd?: string;
};

/** Browse calls without a caller signal still need one to pass along. */
const neverAborted = () => new AbortController().signal;

/**
 * Soft-delete marker stored per conversation. pi-durable 1.1.0 has no conversation
 * deletion, so `archiveConversation` writes this document and listings filter on it.
 */
const ArchivedDoc = defineDoc<{ archived: boolean }>({
	kind: "app.neko.conversation",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ archived: false }),
});

const WorkspacesDoc = defineDoc<{ items: NekoWorkspace[] }>({
	kind: "app.neko.workspaces",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
});

/**
 * Workspaces the user removed. Implicit registration (startup scan, fork) skips these paths and their conversations
 * are hidden from the directory; an explicit add clears the entry, which restores them.
 */
const RemovedWorkspacesDoc = defineDoc<{ paths: string[] }>({
	kind: "app.neko.workspaces-removed",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ paths: [] }),
});

/** User-level search provider choice; `null` means "never saved", so the config value or the default applies. */
const SearchSettingsDoc = defineDoc<{ provider: SearchProviderId | null }>({
	kind: "app.neko.search-settings",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ provider: null }),
});

/** User-level model provider enablement; `null` means "never saved", so only the default providers are enabled. */
const ProviderSettingsDoc = defineDoc<{ enabled: string[] | null }>({
	kind: "app.neko.provider-settings",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ enabled: null }),
});

/** User-level default model; `null` means "never saved", so the config value or the built-in default applies. */
const DefaultModelDoc = defineDoc<{ model: NekoModelRef | null }>({
	kind: "app.neko.default-model",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ model: null }),
});

/** User-level context settings saved from a UI; `null` fields were never saved. */
const ContextSettingsDoc = defineDoc<SavedContextSettings>({
	kind: "app.neko.context-settings",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: emptySavedContextSettings,
});

const ActivityDoc = defineDoc<{ lastUsedAt: number }>({
	kind: "app.neko.activity",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ lastUsedAt: 0 }),
});

/** A running neko-harness runtime: one open storage and its conversations, root plus created ones. */
export type NekoRuntime = {
	readonly workspaceFiles: WorkspaceFiles;
	/** Windows command shell state (undefined on other platforms); `refresh` re-probes instead of using the cache. */
	shellStatus(options?: { readonly refresh?: boolean }): WindowsShellSummary | undefined;
	readonly closed: Harness["closed"];
	/** Chord context bound to every runtime call. */
	readonly context: Context;
	/** The underlying pi-durable Harness, for callers that need more. */
	readonly harness: Harness;
	readonly approvals: ToolApprovals;
	readonly questions: UserQuestions;
	/** The root conversation. */
	readonly conversation: Conversation;
	/** The root session: same conversation, bundled per-session operations. */
	readonly root: NekoSession;

	/** Durably admit user input to the root conversation; the returned submission settles when the run answers it. */
	submit(content: UserMessage["content"], options?: NekoSubmitOptions): Promise<Submission>;
	/** Wait for a submission on the root conversation and extract the answer text. */
	waitAnswer(submission: Submission): Promise<NekoAnswer>;
	/** The root conversation's structural view as a read-only Chord state, updated after every commit. */
	viewState(id?: ConversationId): Promise<AttachedReplicatedState<ConversationView>>;
	/** The structural view as a serialized exact-frame watch with bounded pending frames. */
	watch(id?: ConversationId): Promise<ConversationWatch>;
	/** Coding-agent style agent events (message/tool deltas). */
	events(id?: ConversationId): Promise<AgentEventStream>;
	/** Token and cost totals of a conversation's `pi.usage` (default: root). */
	usage(id?: ConversationId): Promise<UsageState>;
	/** Withdraw queued inputs and abort the current run (default: root). */
	abort(id?: ConversationId): Promise<void>;
	compact(instructions?: string, id?: ConversationId): Promise<void>;

	/** Every conversation of this storage, root included, with its soft-delete state. */
	listConversations(): Promise<NekoConversationInfo[]>;
	onDirectoryChange(listener: () => void): () => void;
	namingUsage(id?: ConversationId): Promise<UsageState>;
	globalUsage(): Promise<UsageState>;
	listWorkspaces(): Promise<NekoWorkspace[]>;
	addWorkspace(path: string): Promise<NekoWorkspace>;
	/**
	 * Remove a workspace from the directory and hide its conversations (nothing is deleted or archived). Rejects with
	 * `WORKSPACE_UNKNOWN` / `WORKSPACE_LAST` / `WORKSPACE_BUSY`. Adding the directory again restores everything.
	 */
	removeWorkspace(path: string): Promise<void>;
	touchConversation(id: ConversationId): Promise<void>;
	forkConversation(id: ConversationId): Promise<NekoSession>;
	/** Create a new ownerless conversation; starts as a copy of the runtime's model/thinking/cwd choices. */
	createConversation(options?: NekoCreateConversationOptions): Promise<NekoSession>;
	/** Acquire a session by id; `undefined` for unknown or archived conversations. */
	getConversation(id: ConversationId): Promise<NekoSession | undefined>;
	/** Soft delete: hide the conversation from listings and lookups. pi-durable cannot delete conversations. */
	archiveConversation(id: ConversationId): Promise<void>;
	/** Change a conversation's model and/or thinking level; `false` when the conversation is unknown or archived. */
	configureConversation(id: ConversationId, change: NekoConversationChange): Promise<boolean>;
	/** Every chat model in the Models registry, for frontend model selectors. */
	/** Every registered model, regardless of provider enablement; for lookups of a session's own model. */
	listModels(): NekoModelInfo[];
	/** Models of enabled providers only, each marked with whether its provider has credentials. */
	listSelectableModels(): Promise<NekoSelectableModel[]>;
	/** Enabled model providers in catalog order; always includes the locked ones. */
	enabledProviders(): readonly ModelProviderId[];
	setProviderEnabled(provider: ModelProviderId, enabled: boolean): Promise<void>;
	/** The effective default model for new sessions and which chain link produced it. */
	defaultModel(): Promise<NekoDefaultModelState>;
	/** Validate and persist the user's default model (`null` clears it); applies from the next conversation creation. */
	setDefaultModel(ref: NekoModelRef | null): Promise<void>;
	credentialStatus(provider: CredentialProviderId): Promise<CredentialStatus>;
	/** Effective context settings (saved > config > default) with the source of every value. */
	contextSettings(): Promise<ContextSettingsState>;
	/** Validate and persist a patch of saved overrides (`null` clears one); applies from the next check. */
	setContextSettings(patch: ContextSettingsPatch): Promise<ContextSettingsState>;
	/** Clear every saved override. */
	resetContextSettings(): Promise<ContextSettingsState>;
	/** The search provider the next tool call uses. */
	searchSettings(): Promise<SearchSettings>;
	/** Persist the user's search provider choice; the next tool call uses it. */
	setSearchProvider(provider: SearchProviderId): Promise<void>;
	saveCredential(provider: CredentialProviderId, key: string): Promise<void>;
	removeCredential(provider: CredentialProviderId): Promise<void>;
	/** The conversation's resolved agent: effective model, thinking level, selected extension names. */
	getAgent(id?: ConversationId): Promise<NekoAgentInfo>;
	/** Skills available to a conversation's workspace (project > user > builtin, merged). */
	listSkills(id?: ConversationId): Promise<NekoSkillInfo[]>;
	/**
	 * Skills at every level for one workspace WITHOUT merging (duplicates across levels included),
	 * each tagged with its level. Market/install UIs derive install state from this.
	 */
	listSkillsByLevel(cwd?: string): Promise<NekoSkillInfo[]>;
	/**
	 * Install an extension, replacing one with the same name in place (pi-durable reload semantics):
	 * running work finishes on the code it started with; the next phase, request, or call uses the new code.
	 */
	installExtension(extension: Extension): void;
	/** Close the Harness and its storage. */
	close(): Promise<void>;
};

/**
 * Open the neko-harness runtime: SQLite storage, the built-in DeepSeek provider
 * (Chat Completions via pi-ai), and the CodingTools extension (read/write/edit/bash
 * on a LocalExecutionEnv).
 */
export async function createNekoRuntime(options: NekoRuntimeOptions = {}): Promise<NekoRuntime> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const defaultCwd = normalizeWorkspace(options.cwd);
	const model: NekoModelRef = options.model ?? DEFAULT_MODEL;
	const modelOverride = options.modelOverride;
	const providers = options.providers ?? [];

	const credentials =
		options.credentials ??
		(options.storage === "memory" && !options.credentialsPath
			? new InMemoryCredentialStore()
			: new FileCredentialStore(options.credentialsPath));
	const runtimeKeys = new Map<CredentialProviderId, string>();
	const deepseekKey = options.apiKey?.trim();
	if (deepseekKey) runtimeKeys.set("deepseek", deepseekKey);
	const tavilyKey = options.tavilyApiKey?.trim();
	if (tavilyKey) runtimeKeys.set("tavily", tavilyKey);
	const effectiveCredentials: CredentialStore = runtimeKeys.size
		? {
				read: async (id) => {
					const override = runtimeKeys.get(id as CredentialProviderId);
					return override !== undefined ? { type: "api_key", key: override } : credentials.read(id);
				},
				list: () => credentials.list(),
				modify: (id, fn) => credentials.modify(id, fn),
				delete: (id) => credentials.delete(id),
			}
		: credentials;
	const models = createModels({ credentials: effectiveCredentials });
	for (const provider of builtinProviders()) if (isModelProvider(provider.id)) models.setProvider(provider);
	for (const provider of providers) models.setProvider(provider);
	let enabled = new Set<string>(normalizeEnabledProviders(null));
	/** Catalog providers need to be enabled and hold credentials; extra providers passed in code are unmanaged. */
	const guardProvider = async (ref: NekoModelRef | undefined): Promise<void> => {
		if (!ref || !isModelProvider(ref.provider)) return;
		const spec = credentialProvider(ref.provider);
		if (!enabled.has(ref.provider))
			throw new Error(
				`PROVIDER_DISABLED: ${spec.name} is not enabled. Enable it in /login or Web settings, or switch model.`,
			);
		if (!(await models.checkAuth(ref.provider)))
			throw new Error(`PROVIDER_KEY_REQUIRED: Configure a ${spec.name} API key in /login or Web settings.`);
	};
	const resolveLevel = (ref: NekoModelRef, level: ModelThinkingLevel) => {
		const info = models.getModel(ref.provider, ref.modelId);
		if (!info) throw new Error("Unknown model");
		return clampThinkingLevel(info, level);
	};

	let modelInfoCache: NekoModelInfo[] | undefined;
	// Built once: the catalog is static, and projections look a model up on every view update.
	const allModels = (): NekoModelInfo[] => {
		modelInfoCache ??= models.getModels().map((model) => ({
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			input: model.input,
			...(model.inputLimits ? { inputLimits: model.inputLimits } : {}),
			reasoning: model.reasoning,
			supportedThinkingLevels: getSupportedThinkingLevels(model),
			thinkingLevelAdjustments: Object.fromEntries(
				(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => [
					level,
					clampThinkingLevel(model, level),
				]),
			) as Record<ModelThinkingLevel, ModelThinkingLevel>,
		}));
		return modelInfoCache;
	};

	// Only Windows probes for Git Bash; elsewhere the resolver stays absent and execution is untouched.
	const shellResolver =
		options.shellResolver ??
		(process.platform === "win32" ? createWindowsShellResolver({ configPath: options.shellPath }) : undefined);
	const workspaceFiles = new WorkspaceFiles(undefined, shellResolver);
	const storage =
		options.storage === "memory"
			? new MemoryStorage()
			: await openNodeSqliteStorage(options.storagePath ?? DEFAULT_STORAGE_PATH);

	const registry = createRegistry();
	registry.install(createCodingTools({ images: await createNodePhotonImages() }));
	registry.install(ImageDetails);
	registry.install(AgentFileSearch);
	const tavily = createTavilyProvider(async () => {
		const saved = await effectiveCredentials.read("tavily");
		if (saved?.type === "api_key" && saved.key) return saved.key;
		return process.env.TAVILY_API_KEY || undefined;
	});
	// Same precedence as the model: runtime override, saved value, then DEEPSEEK_API_KEY.
	const deepseekApiKey = async () => {
		const saved = await effectiveCredentials.read("deepseek");
		if (saved?.type === "api_key" && saved.key) return saved.key;
		return process.env.DEEPSEEK_API_KEY || undefined;
	};
	const deepseek = createDeepseekProvider(deepseekApiKey);
	let searchProvider: SearchProviderId = options.searchProvider ?? DEFAULT_SEARCH_PROVIDER;
	// Chosen per call so a saved choice applies to the next tool call without a restart.
	registry.install(createWebSearchTools(async () => (searchProvider === "deepseek" ? deepseek : tavily)));
	const loadResources = createResourceLoader(options.promptHome);
	const resourceSnapshots = createResourceSnapshots(loadResources, (id, requestId) =>
		storage.submissionByRequest(id, requestId, context),
	);
	registry.install(createNekoPrompt(resourceSnapshots.current));
	registry.install(
		createSubagentExtension(
			async (id, requestId, cwd) => {
				resourceSnapshots.stage(id, requestId, cwd, await loadResources(cwd));
			},
			resourceSnapshots.discard,
			(ref) => guardProvider(ref),
		),
	);
	const jobs = new JobManager(
		options.timings?.jobStartWindowMs === undefined ? {} : { startWindowMs: options.timings.jobStartWindowMs },
	);
	registry.install(jobs.extension);
	registry.install(createTodoExtension());
	let questions!: UserQuestions;
	registry.install(createQuestionExtension(() => questions));
	let plans!: PlanService;
	registry.install(createPlanExtension(() => plans));
	for (const extension of options.extensions ?? []) registry.install(extension);
	let approvals!: ToolApprovals;
	const approvalExtension = createApprovalExtension(() => approvals);
	registry.install(approvalExtension);

	let savedContext: SavedContextSettings = emptySavedContextSettings();
	let contextState = resolveContextSettings(options.contextSettings, savedContext);
	// The whole catalog, enabled or not: a session may still use a model of a disabled provider, and each model's
	// threshold depends only on its own window.
	const compactionFor = createCompactionPolicy(
		new Map(allModels().map((model) => [`${model.provider}/${model.modelId}`, model.contextWindow])),
	);
	const harness = await Harness.open(
		storage,
		{
			models,
			// Model vendors that only accept Pi's client are the reason for this; it matches Pi's default today, and
			// stating it keeps an upstream change of that default from silently changing what neko sends.
			identity: { userAgent: "detailed", attribution: PI_ATTRIBUTION },
			registry,
			settings: {
				...(options.timings?.retryBaseDelayMs === undefined
					? {}
					: { retry: { baseDelayMs: options.timings.retryBaseDelayMs } }),
				// Read at every use, so a saved change applies from the next threshold check without a restart.
				get compaction() {
					return compactionFor(contextState);
				},
			},
			onReport: options.onReport,
			conversationCreated: async (tx, record) => {
				(await tx.doc(SessionMetadataDoc, record.id)).createdAt = Date.now();
			},
			env: ({ cwd }) => workspaceFiles.env(executionWorkspace(cwd)),
		},
		context,
	);
	const scanConversations = () =>
		harness.commit(async (tx) => {
			const records: ConversationRecord[] = [];
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanConversations({}, 1000, cursor);
				records.push(...page.items);
				cursor = page.next;
			} while (cursor);
			return records;
		}, context);
	approvals = new ToolApprovals(harness, context);
	questions = new UserQuestions(harness, context);
	plans = new PlanService(harness, context);
	const changes = new ChangeTracker(harness, context);
	const existing = await scanConversations();
	questions.track(...existing.map((r) => r.id));

	try {
		await installSubagentCoordinator(
			harness,
			existing.map((r) => r.id),
			context,
		);
		await removeMainOnlyTools(
			harness,
			existing.map((r) => r.id),
			context,
		);
		await prepareApprovalConversations(
			harness,
			existing.map((r) => r.id),
			approvalExtension,
			context,
		);
		for (const record of existing) {
			const target = await harness.conversation(record.id, context);
			if (target) {
				savedWorkspace((await target.agent(context)).cwd);
				if (!(await harness.snapshot(SessionMetadataDoc, record.id, context))?.createdAt)
					throw new Error(
						"Unsupported session metadata format; use a new storage file. Existing data was not deleted.",
					);
			}
		}
	} catch (error) {
		await workspaceFiles.close();
		await harness.close(context);
		throw error;
	}
	await questions.reconcileAll();
	// Root conversation: the launch-time effective default (CLI --model wins over the config/built-in
	// base), matching the pre-split `options.model ?? fileConfig.defaultModel ?? DEFAULT_MODEL` behavior.
	const rootModel = modelOverride ?? model;
	const conversation = await harness.root(context, {
		agent: {
			model: rootModel,
			thinkingLevel: resolveLevel(rootModel, options.thinkingLevel ?? "high"),
			cwd: defaultCwd,
		},
	});
	enabled = new Set(
		normalizeEnabledProviders((await harness.snapshot(ProviderSettingsDoc, conversation.id, context))?.enabled),
	);
	const savedSearch = (await harness.snapshot(SearchSettingsDoc, conversation.id, context))?.provider;
	if (isSearchProvider(savedSearch)) searchProvider = savedSearch;
	savedContext = sanitizeSavedContextSettings(await harness.snapshot(ContextSettingsDoc, conversation.id, context));
	contextState = resolveContextSettings(options.contextSettings, savedContext);
	const persistContext = async (next: SavedContextSettings): Promise<ContextSettingsState> => {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(ContextSettingsDoc, conversation.id);
			doc.compaction = next.compaction;
			doc.pruning = next.pruning;
		}, context);
		savedContext = next;
		contextState = resolveContextSettings(options.contextSettings, savedContext);
		return contextState;
	};
	const removedWorkspaces = async (): Promise<ReadonlySet<string>> =>
		new Set((await harness.snapshot(RemovedWorkspacesDoc, conversation.id, context))?.paths ?? []);
	/** Explicit registration also lifts a removal; implicit registration (startup scan, fork) leaves removed paths out. */
	const registerWorkspace = async (path: string, explicit: boolean): Promise<void> => {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(WorkspacesDoc, conversation.id);
			const removed = await tx.doc(RemovedWorkspacesDoc, conversation.id);
			if (removed.paths.includes(path)) {
				if (!explicit) return;
				removed.paths = removed.paths.filter((entry) => entry !== path);
			}
			if (!doc.items.some((item) => item.path === path)) doc.items.push({ path, createdAt: Date.now() });
		}, context);
	};
	const addWorkspace = async (input: string): Promise<NekoWorkspace> => {
		const path = accessibleWorkspace(input);
		await registerWorkspace(path, true);
		return (await harness.snapshot(WorkspacesDoc, conversation.id, context))!.items.find((item) => item.path === path)!;
	};
	for (const record of [...existing, { id: conversation.id }]) {
		const target = await harness.conversation(record.id, context);
		if (target) await registerWorkspace(savedWorkspace((await target.agent(context)).cwd), false);
	}
	await registerWorkspace(defaultCwd, true);
	const removeWorkspace = async (path: string): Promise<void> => {
		const items = (await harness.snapshot(WorkspacesDoc, conversation.id, context))?.items ?? [];
		if (!items.some((item) => item.path === path)) throw new Error(WORKSPACE_UNKNOWN);
		if (items.length <= 1) throw new Error(WORKSPACE_LAST);
		for (const record of await scanConversations()) {
			if (record.owner) continue;
			if ((await harness.snapshot(ArchivedDoc, record.id, context))?.archived) continue;
			const target = await harness.conversation(record.id, context);
			if (!target || savedWorkspace((await target.agent(context)).cwd) !== path) continue;
			const info = await harness.snapshot(SessionMetadataDoc, record.id, context);
			if (info?.status === "running" || info?.awaiting === true || info?.awaitingPlan === true)
				throw new Error(WORKSPACE_BUSY);
		}
		await harness.commit(async (tx) => {
			const doc = await tx.doc(WorkspacesDoc, conversation.id);
			const removed = await tx.doc(RemovedWorkspacesDoc, conversation.id);
			doc.items = doc.items.filter((item) => item.path !== path);
			if (!removed.paths.includes(path)) removed.paths.push(path);
		}, context);
	};

	const jobIo = (id: ConversationId) => ({
		commit: <T>(change: (tx: Tx) => T | Promise<T>) => harness.commit(change, context),
		state: () => harness.snapshot(JobsDoc, id, context),
	});
	let lastActivity = 0;
	for (const record of existing)
		lastActivity = Math.max(lastActivity, (await harness.snapshot(ActivityDoc, record.id, context))?.lastUsedAt ?? 0);
	const touchConversation = async (id: ConversationId): Promise<void> => {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(ActivityDoc, id);
			lastActivity = Math.max(Date.now(), lastActivity + 1, doc.lastUsedAt + 1);
			doc.lastUsedAt = lastActivity;
		}, context);
	};
	if (existing.length === 0) await touchConversation(conversation.id);
	const metadata = new SessionMetadataManager(
		harness,
		storage,
		context,
		registry,
		options.onReport,
		(provider, modelId) =>
			guardProvider({ provider, modelId }).then(
				() => true,
				() => false,
			),
		{
			...(options.timings?.namingRequestTimeoutMs === undefined
				? {}
				: { requestTimeoutMs: options.timings.namingRequestTimeoutMs }),
			...(options.timings?.namingRetryDelayMs === undefined
				? {}
				: { retryDelayMs: options.timings.namingRetryDelayMs }),
		},
	);
	if (existing.length === 0) await metadata.initialize(conversation.id);
	for (const record of existing)
		if (!record.owner && !(await harness.snapshot(ArchivedDoc, record.id, context))?.archived)
			await metadata.restore(record.id);
	const pruner = new ContextPruner({
		harness,
		context,
		settings: () => contextState.effective.pruning,
		windowOf: async (id) => {
			const target = await harness.conversation(id, context);
			const model = (await target?.agent(context))?.model;
			return (model && models.getModel(model.provider, model.modelId)?.contextWindow) || 0;
		},
		report: (error) => options.onReport?.(error),
	});
	let closing: Promise<void> | undefined;
	const cleanup = () => {
		if (!closing)
			closing = (async () => {
				pruner.close();
				jobs.shutdown();
				await workspaceFiles.close();
				await metadata.close();
			})();
		return closing;
	};
	void harness.closed.then(cleanup).catch((error) => options.onReport?.(error));
	harness.resume();

	// Serialize admission and configuration; preprocessing must use the admitted model.
	const admissions = new Map<ConversationId, Promise<unknown>>();
	const admit = async <T>(id: ConversationId, operation: () => Promise<T>): Promise<T> => {
		const work = (admissions.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
		admissions.set(id, work);
		try {
			return await work;
		} finally {
			if (admissions.get(id) === work) admissions.delete(id);
		}
	};
	/** The agent configuration is a projection of the plan document; repair it before anything depends on it. */
	const syncPlanAgent = async (target: Conversation) => {
		const mode = await plans.mode(target.id);
		if ((mode === "plan") !== agentInPlanMode(await target.agent(context)))
			await target.configure(planAgentChange(mode), context);
	};
	const submitTo = async (
		target: Conversation,
		content: UserMessage["content"],
		submitOptions?: NekoSubmitOptions,
		extra?: Pick<InputData, "planDecision">,
	): Promise<Submission> =>
		admit(target.id, async () => {
			await syncPlanAgent(target);
			const agent = await target.agent(context);
			const workspace = executionWorkspace(agent.cwd);
			const duplicate =
				submitOptions?.requestId !== undefined &&
				(await storage.submissionByRequest(target.id, submitOptions.requestId, context));
			const data: InputData = { at: Date.now(), prompt: "", images: [], ...extra };
			let invocationName: string | undefined;
			if (!duplicate && typeof content === "string" && content.startsWith("/skill:")) {
				const end = content.indexOf(" ");
				invocationName = content.slice(7, end === -1 ? undefined : end);
			}
			const prepared = duplicate ? undefined : await loadResources(workspace, invocationName);
			if (prepared && invocationName !== undefined && typeof content === "string") {
				content = await expandSkillCommand(
					content,
					prepared.skills,
					async (path) => {
						if (prepared.invocation?.filePath !== path) throw new Error("Missing prepared skill content");
						return prepared.invocation.content;
					},
					undefined,
					(skill) => {
						data.skill = skill;
					},
				);
			}
			if (!duplicate) await guardProvider(agent.model);
			if (!duplicate && agent.model) {
				const resolved = models.getModel(agent.model.provider, agent.model.modelId);
				if (resolved) content = await prepareInput(content, resolved);
			}

			const requestId = submitOptions?.requestId ?? crypto.randomUUID();
			data.prompt = imagePrompt(content);
			if (!duplicate) {
				const input = addDefaultImagePrompt(content);
				content = input.content;
				if (input.defaultImagePrompt) data.defaultImagePrompt = input.defaultImagePrompt;
			}
			if (!duplicate && Array.isArray(content)) {
				let index = 0;
				for (const [contentIndex, block] of content.entries()) {
					if (block.type !== "image") continue;
					const bytes = Buffer.from(block.data, "base64");
					const { default: sharp } = await import("sharp");
					const info = await sharp(bytes).metadata();
					data.images.push({
						contentIndex,
						name: (submitOptions?.imageNames?.[index++] ?? "Image").replace(/\p{Cc}/gu, "").slice(0, 200),
						mimeType: block.mimeType,
						width: info.width!,
						height: info.height!,
						bytes: bytes.length,
					});
				}
			}
			if (prepared) resourceSnapshots.stage(target.id, requestId, workspace, prepared);
			let result: Submission;
			try {
				result = await target.submit(
					{
						type: "input",
						content,
						entry: { kind: NekoInput.kind, data },
						requestId,
						...(submitOptions?.whenBusy !== undefined ? { whenBusy: submitOptions.whenBusy } : {}),
					},
					context,
				);
			} catch (error) {
				resourceSnapshots.discard(target.id, requestId);
				throw error;
			}
			if (!extra?.planDecision) await plans.supersedePending(target.id);
			await touchConversation(target.id);
			await metadata.reconcile(target.id);
			return result;
		});

	/** Submit the input a settled plan decision calls for; the request id makes repeats and restarts harmless. */
	const dispatchPlan = async (target: Conversation, item: PlanItem) => {
		const approve = item.status === "approved";
		await submitTo(
			target,
			approve ? approvedPlanPrompt(item) : planRevisionPrompt(item, item.feedback ?? ""),
			{ requestId: `${approve ? "plan-exec" : "plan-revise"}:${item.version}`, whenBusy: "followUp" },
			{
				planDecision: {
					version: item.version,
					kind: approve ? "approve" : "revise",
					title: item.title,
					...(!approve && item.feedback ? { feedback: item.feedback } : {}),
				},
			},
		);
		await plans.markDispatched(target.id, item.version);
	};
	const isRunning = async (id: ConversationId) =>
		(await harness.snapshot(importLiveDoc, id, context))?.run !== undefined;

	const waitAnswerOf = async (target: Conversation, submission: Submission): Promise<NekoAnswer> => {
		const settled = await submission.wait(context);
		await metadata.flush();
		await metadata.reconcile(target.id);
		if (settled.status === "done" && settled.type === "input") {
			const entry = await target.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = entry?.model?.[0];
			const text =
				message?.role === "assistant"
					? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
					: "";
			return { status: "done", text };
		}
		const detail = settled.status === "unanswered" ? settled.detail : undefined;
		return {
			status: "unanswered",
			reason: settled.status === "unanswered" ? settled.reason : settled.status,
			...(detail !== undefined ? { detail: typeof detail === "string" ? detail : JSON.stringify(detail) } : {}),
		};
	};

	const makeSession = (target: Conversation): NekoSession => ({
		id: target.id,
		conversation: target,
		submit(content, submitOptions) {
			return submitTo(target, content, submitOptions);
		},
		waitAnswer(submission) {
			return waitAnswerOf(target, submission);
		},
		viewState() {
			return target.viewState(context);
		},
		watch() {
			return target.watch(context);
		},
		events() {
			return watchEvents(harness, target.id, context);
		},
		async usage() {
			return mergeUsage(
				(await harness.snapshot(UsageDoc, target.id, context)) ?? { models: {}, tools: {} },
				(await harness.snapshot(SessionMetadataDoc, target.id, context))?.namingUsage ?? { models: {}, tools: {} },
			);
		},
		compactionRecord() {
			return readCompaction(harness, storage, target.id, context);
		},
		jobs() {
			return jobs.list(jobIo(target.id), target.id);
		},
		jobOutput(jobId, since) {
			return jobs.readOutput(jobIo(target.id), target.id, jobId, since);
		},
		async stopJob(jobId) {
			const job = await jobs.stop(jobIo(target.id), target.id, jobId, "user", context);
			return summarizeJobRecord(job);
		},
		async todos() {
			const saved = await harness.snapshot(TodosDoc, target.id, context);
			return saved ? structuredClone(saved) : { revision: 0, items: [] };
		},
		questions() {
			return questions.list(target.id, context);
		},
		question(id) {
			return questions.get(target.id, id, context);
		},
		respondQuestion(id, version, response) {
			return questions.respond(target.id, id, version, response, context);
		},
		plan() {
			return plans.view(target.id);
		},
		planRecord(version) {
			return plans.get(target.id, version);
		},
		async setPlanMode(mode) {
			if (mode !== "normal" && mode !== "plan") throw new Error("Unknown plan mode.");
			return admit(target.id, async () => {
				if (await isRunning(target.id)) throw new Error(PLAN_BUSY);
				await plans.setMode(target.id, mode);
				await syncPlanAgent(target);
				return plans.view(target.id);
			});
		},
		async respondPlan(version, decision) {
			const parsed = validatePlanDecision(decision);
			const known = await plans.get(target.id, version);
			if (!known) throw new Error("Plan not found.");
			if (known.status === "awaiting_approval") {
				if (await isRunning(target.id)) throw new Error(PLAN_BUSY);
				await guardProvider((await target.agent(context)).model);
			}
			const { record, item } = await plans.decide(target.id, version, parsed);
			if ((item.status === "approved" || item.status === "revision_requested") && !item.dispatched)
				await dispatchPlan(target, item);
			return record;
		},
		async workspaceDir(path, signal) {
			return workspaceFiles.children(savedWorkspace((await target.agent(context)).cwd), path, signal ?? neverAborted());
		},
		async workspaceFile(path, signal) {
			return workspaceFiles.read(savedWorkspace((await target.agent(context)).cwd), path, signal ?? neverAborted());
		},
		changeSummary() {
			return changes.summary(target.id);
		},
		changes() {
			return changes.list(target.id);
		},
		change(path) {
			return changes.detail(target.id, path);
		},
		async compact(instructions) {
			const agent = await target.agent(context);
			await guardProvider(agent.model);
			await admit(target.id, async () => {
				const live = await harness.snapshot(importLiveDoc, target.id, context);
				if (
					live?.compactions?.length ||
					(await readCompaction(harness, storage, target.id, context))?.phase === "waiting-to-apply"
				)
					return;
				await target.compact(instructions?.trim() || undefined, context);
			});
		},
		async abort() {
			await target.abort(context);
			await plans.cancelPending(target.id);
		},
		async withdraw(submissionId) {
			const id = submissionId as SubmissionId;
			const inbox = await harness.snapshot(InboxDoc, target.id, context);
			const item = inbox?.items.find((i) => i.id === id);
			const input = item ? queuedUserInput(item) : undefined;
			if (item && !input) return { result: "unknown" };
			const requestId = (await (await harness.submission(id, context))?.status(context))?.requestId;
			const outcome = await harness.abortSubmission(id, context, target.id);
			if (outcome !== "aborted") {
				return { result: outcome === "already_placed" ? "placed" : outcome === "settled" ? "settled" : "unknown" };
			}
			if (requestId !== undefined) resourceSnapshots.discard(target.id, requestId);
			await metadata.reconcile(target.id);
			return { result: "withdrawn", ...(input ? { text: input.text, images: input.images } : {}) };
		},
		async steer(submissionId) {
			const id = submissionId as SubmissionId;
			const inbox = await harness.snapshot(InboxDoc, target.id, context);
			const item = inbox?.items.find((i) => i.id === id);
			const input = item ? queuedUserInput(item) : undefined;
			if (item && (!input || item.mode === "write")) return { result: "unknown" };
			if (item && input?.mode === "steer") return { result: "steered", id: submissionId };
			const requestId = (await (await harness.submission(id, context))?.status(context))?.requestId;
			const outcome = await harness.abortSubmission(id, context, target.id);
			if (outcome !== "aborted" || !item || !input) {
				return { result: outcome === "already_placed" ? "placed" : outcome === "settled" ? "settled" : "unknown" };
			}
			const steerRequestId = requestId !== undefined ? `steer:${requestId}` : crypto.randomUUID();
			try {
				const next = await target.submit(
					{
						type: "input",
						content: item.content as UserMessage["content"],
						...(item.entry ? { entry: item.entry as InputEntry } : {}),
						requestId: steerRequestId,
						whenBusy: "steer",
					},
					context,
				);
				if (requestId !== undefined) resourceSnapshots.move(target.id, requestId, steerRequestId);
				await metadata.reconcile(target.id);
				return { result: "steered", id: next.id };
			} catch {
				if (requestId !== undefined) resourceSnapshots.discard(target.id, requestId);
				await metadata.reconcile(target.id);
				return { result: "withdrawn", text: input.text, images: input.images };
			}
		},
	});

	const rootSession = makeSession(conversation);

	const sessionFor = async (id?: ConversationId): Promise<NekoSession> => {
		if (id === undefined || id === conversation.id) return rootSession;
		const session = await getConversation(id);
		if (session === undefined) throw new Error(`Conversation ${id} is not available (unknown or archived).`);
		return session;
	};

	const getConversation = async (id: ConversationId): Promise<NekoSession | undefined> => {
		// `conversation()` yields undefined for unknown ids; snapshot on an unknown id
		// would reject, so only read the archive marker for conversations that exist.
		const target = await harness.conversation(id, context);
		if (target === undefined) return undefined;
		const archived = (await harness.snapshot(ArchivedDoc, id, context))?.archived ?? false;
		const record = await harness.commit((tx) => tx.conversation(id), context);
		return archived || record?.owner ? undefined : makeSession(target);
	};

	// Repair interrupted plan steps: the agent configuration, and a decision whose input was never submitted.
	for (const id of new Set([conversation.id, ...existing.map((r) => r.id)])) {
		try {
			const session = await getConversation(id);
			if (!session) continue;
			await admit(id, () => syncPlanAgent(session.conversation));
			const pending = await plans.undispatched(id);
			if (pending) await dispatchPlan(session.conversation, pending);
		} catch (error) {
			options.onReport?.(error);
		}
	}

	return {
		context,
		async compact(instructions, id) {
			await (await sessionFor(id)).compact(instructions);
		},
		onDirectoryChange: (listener) => metadata.subscribe(listener),
		async namingUsage(id = conversation.id) {
			return structuredClone((await harness.snapshot(SessionMetadataDoc, id, context))!.namingUsage);
		},
		async globalUsage() {
			let total: UsageState = { models: {}, tools: {} };
			for (const record of await scanConversations()) {
				total = mergeUsage(total, (await harness.snapshot(UsageDoc, record.id, context)) ?? { models: {}, tools: {} });
				total = mergeUsage(
					total,
					(await harness.snapshot(SessionMetadataDoc, record.id, context))?.namingUsage ?? { models: {}, tools: {} },
				);
			}
			return total;
		},
		touchConversation,
		addWorkspace,
		removeWorkspace,
		async listWorkspaces() {
			return [...((await harness.snapshot(WorkspacesDoc, conversation.id, context))?.items ?? [])];
		},
		async forkConversation(id) {
			const source = await sessionFor(id);
			const agent = await source.conversation.agent(context);
			await registerWorkspace(savedWorkspace(agent.cwd), false);
			const newest = await source.conversation.entries({}, 1, undefined, context);
			const at = newest.items[0]?.id;
			const sourceMetadata = at === undefined ? undefined : await harness.snapshot(SessionMetadataDoc, id, context);
			const childId = await harness.commit(async (tx) => {
				const inherited: import("./subagents.ts").Delegation[] = [];
				if (at !== undefined) {
					const references = await refreshDelegations(tx, id);
					const calls = new Set<string>();
					let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
					do {
						const page = await tx.scanEntries({ conversationId: id, maxEntryId: at }, 100, cursor);
						for (const entry of page.items)
							for (const message of entry.model ?? []) {
								if (message.role === "assistant")
									for (const block of message.content) {
										if (block.type === "toolCall") calls.add(block.id);
									}
							}
						cursor = page.next;
					} while (cursor);
					const frozen = new Map<number, { through: number; state: UsageState }>();
					for (const reference of references) {
						if (!calls.has(reference.callId)) continue;
						let snapshot = frozen.get(reference.childId);
						if (!snapshot) {
							const latest = await tx.scanEntries({ conversationId: reference.childId as ConversationId }, 1);
							snapshot = {
								through: latest.items[0]?.id ?? 0,
								state: JSON.parse(JSON.stringify(await tx.doc(UsageDoc, reference.childId as ConversationId))),
							};
							frozen.set(reference.childId, snapshot);
						}
						const usage = totalUsage(snapshot.state);
						inherited.push({
							...reference,
							historyThrough: reference.historyThrough ?? snapshot.through,
							roundUsage:
								reference.roundUsage ??
								(reference.usageStart
									? subagentUsageTotals(subtractSubagentUsage(snapshot.state, reference.usageStart))
									: null),
							historyUsage: reference.historyUsage ?? {
								input: usage.input,
								output: usage.output,
								cacheRead: usage.cacheRead,
								cacheWrite: usage.cacheWrite,
								cost: usage.cost.total,
							},
						});
					}
				}
				// Pi transactions require table reads before the first table write.
				const child =
					at === undefined
						? await tx.createConversation({ ownership: { kind: "ownerless" } })
						: await tx.forkConversation(id, at, { ownership: { kind: "ownerless" } });
				(await tx.doc(DelegationsDoc, child.id)).items = inherited;
				if (sourceMetadata) {
					const doc = await tx.doc(SessionMetadataDoc, child.id);
					doc.title = sourceMetadata.title || sourceMetadata.firstPromptPreview;
					doc.firstPromptPreview = sourceMetadata.firstPromptPreview;
					doc.naming = "ready";
				}
				return child.id;
			}, context);
			const child = (await harness.conversation(childId, context))!;
			await child.configure(
				{ model: agent.model, thinkingLevel: agent.thinkingLevel, cwd: savedWorkspace(agent.cwd) },
				context,
			);
			await metadata.initialize(child.id);
			await touchConversation(child.id);
			return makeSession(child);
		},
		harness,
		approvals,
		questions,
		closed: harness.closed,
		workspaceFiles,
		shellStatus(call) {
			const status = workspaceFiles.shellStatus(call);
			return status === undefined ? undefined : summarizeWindowsShell(status);
		},
		conversation,
		root: rootSession,
		submit: rootSession.submit,
		waitAnswer: rootSession.waitAnswer,
		async viewState(id?: ConversationId) {
			return (await sessionFor(id)).viewState();
		},
		async watch(id?: ConversationId) {
			return (await sessionFor(id)).watch();
		},
		async events(id?: ConversationId) {
			return (await sessionFor(id)).events();
		},
		async usage(id?: ConversationId) {
			return (await sessionFor(id)).usage();
		},
		async abort(id?: ConversationId) {
			await (await sessionFor(id)).abort();
		},
		async listConversations() {
			// The directory hides archived conversations (soft-deleted).
			const records = await scanConversations();
			const infos: NekoConversationInfo[] = [];
			const removed = await removedWorkspaces();
			for (const record of records) {
				if (record.owner) continue;
				const archived = (await harness.snapshot(ArchivedDoc, record.id, context))?.archived ?? false;
				if (!archived) {
					const target = await harness.conversation(record.id, context);
					if (!target) continue;
					const workspaceRoot = savedWorkspace((await target.agent(context)).cwd);
					if (removed.has(workspaceRoot)) continue;
					const info = (await harness.snapshot(SessionMetadataDoc, record.id, context))!;
					infos.push({
						title: info.title,
						firstPromptPreview: info.firstPromptPreview,
						createdAt: info.createdAt,
						lastMessageAt: info.lastMessageAt,
						status: info.status,
						awaitingAnswer: info.awaiting === true,
						awaitingPlan: info.awaitingPlan === true,
						model: (await target.agent(context)).model ?? null,
						id: record.id,
						archived: false,
						workspaceRoot,
						lastUsedAt: (await harness.snapshot(ActivityDoc, record.id, context))?.lastUsedAt ?? 0,
					});
				}
			}
			return infos;
		},
		async createConversation(createOptions) {
			const workspace = await addWorkspace(createOptions?.cwd ?? defaultCwd);
			// Read at every creation, so a saved change applies without a restart (same as ProviderSettingsDoc).
			const savedDefault = (await harness.snapshot(DefaultModelDoc, conversation.id, context))?.model ?? null;
			const effective = createOptions?.model ?? modelOverride ?? savedDefault ?? model;
			const created = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: effective,
						thinkingLevel: resolveLevel(effective, createOptions?.thinkingLevel ?? options.thinkingLevel ?? "high"),
						cwd: workspace.path,
					},
				},
				context,
			);
			await metadata.initialize(created.id);
			await touchConversation(created.id);
			return makeSession(created);
		},
		getConversation,
		async archiveConversation(id) {
			await (await sessionFor(id)).abort();
			await questions.reconcile(id, context);
			await jobs.stopAll(jobIo(id), id);
			await metadata.archive(id);
			await changes.forget(id);
			await harness.commit(async (tx) => {
				(await tx.doc(ArchivedDoc, id)).archived = true;
			}, context);
			resourceSnapshots.forget(id);
		},
		async configureConversation(id, change) {
			return admit(id, async () => {
				const session = await getConversation(id);
				if (session === undefined) return false;
				const current = await session.conversation.agent(context);
				const ref = change.model ?? current.model;
				const targetModel = ref && models.getModel(ref.provider, ref.modelId);
				if (!targetModel) throw new Error("Unknown model");
				if (change.model && isModelProvider(ref.provider) && !enabled.has(ref.provider))
					throw new Error(`PROVIDER_DISABLED: ${credentialProvider(ref.provider).name} is not enabled.`);
				await session.conversation.configure(
					{ model: ref, thinkingLevel: clampThinkingLevel(targetModel, change.thinkingLevel ?? current.thinkingLevel) },
					context,
				);
				return true;
			});
		},
		async credentialStatus(provider) {
			const spec = credentialProvider(provider);
			const saved = await credentials.read(spec.id);
			const savedConfigured = saved?.type === "api_key" && Boolean(saved.key);
			const environmentConfigured = Boolean(process.env[spec.envVar]);
			return {
				savedConfigured,
				environmentConfigured,
				source: runtimeKeys.has(spec.id)
					? "runtime"
					: savedConfigured
						? "saved"
						: environmentConfigured
							? "environment"
							: spec.keyless
								? "keyless"
								: "none",
			};
		},
		async contextSettings() {
			return contextState;
		},
		async setContextSettings(patch) {
			return persistContext(applyContextPatch(savedContext, parseContextSettingsPatch(patch)));
		},
		async resetContextSettings() {
			return persistContext(emptySavedContextSettings());
		},
		async searchSettings() {
			return { selected: searchProvider };
		},
		async setSearchProvider(provider) {
			if (!isSearchProvider(provider)) throw new Error("Unknown search provider.");
			await harness.commit(async (tx) => {
				(await tx.doc(SearchSettingsDoc, conversation.id)).provider = provider;
			}, context);
			searchProvider = provider;
		},
		async saveCredential(provider, key) {
			const spec = credentialProvider(provider);
			if (
				typeof key !== "string" ||
				!key.trim() ||
				key.length > 4096 ||
				Array.from(key).some((char) => char.charCodeAt(0) < 32)
			)
				throw new Error("Enter a valid API key.");
			try {
				await credentials.modify(spec.id, async () => ({ type: "api_key", key: key.trim() }));
			} catch {
				throw new Error("Cannot save API key.");
			}
		},
		async removeCredential(provider) {
			const spec = credentialProvider(provider);
			try {
				await credentials.delete(spec.id);
			} catch {
				throw new Error("Cannot remove API key.");
			}
		},
		listModels() {
			return allModels();
		},
		async listSelectableModels() {
			const availability = new Map<string, boolean>();
			const result: NekoSelectableModel[] = [];
			for (const info of allModels()) {
				const managed = isModelProvider(info.provider);
				if (managed && !enabled.has(info.provider)) continue;
				if (!availability.has(info.provider))
					availability.set(info.provider, !managed || Boolean(await models.checkAuth(info.provider)));
				result.push({ ...info, available: availability.get(info.provider) ?? false });
			}
			return result;
		},
		enabledProviders() {
			return MODEL_PROVIDERS.map((item) => item.id).filter((id) => enabled.has(id));
		},
		async setProviderEnabled(provider, value) {
			if (!isModelProvider(provider)) throw new Error("Unknown model provider.");
			if (typeof value !== "boolean") throw new Error("Enabled must be a boolean.");
			if (!value && LOCKED_PROVIDERS.includes(provider)) throw new Error("DeepSeek is always enabled.");
			const next = new Set(enabled);
			if (value) next.add(provider);
			else next.delete(provider);
			const list = normalizeEnabledProviders([...next]);
			await harness.commit(async (tx) => {
				(await tx.doc(ProviderSettingsDoc, conversation.id)).enabled = list;
			}, context);
			enabled = new Set(list);
		},
		async defaultModel() {
			const saved = (await harness.snapshot(DefaultModelDoc, conversation.id, context))?.model ?? null;
			if (modelOverride) return { effective: modelOverride, source: "cli" };
			if (saved) return { effective: saved, source: "saved" };
			if (options.model) return { effective: model, source: "config" };
			return { effective: model, source: "default" };
		},
		async setDefaultModel(ref) {
			if (ref !== null) {
				if (!models.getModel(ref.provider, ref.modelId)) throw new Error("Unknown model");
				if (isModelProvider(ref.provider) && !enabled.has(ref.provider))
					throw new Error(`PROVIDER_DISABLED: ${credentialProvider(ref.provider).name} is not enabled.`);
			}
			await harness.commit(async (tx) => {
				(await tx.doc(DefaultModelDoc, conversation.id)).model = ref;
			}, context);
		},
		async getAgent(id?: ConversationId) {
			const session = await sessionFor(id);
			const agent = await session.conversation.agent(context);
			return {
				...(agent.model !== undefined ? { model: agent.model } : {}),
				thinkingLevel: agent.thinkingLevel,
				cwd: savedWorkspace(agent.cwd),
				extensions: agent.extensions.map((extension) => extension.name),
			};
		},
		async listSkills(id?: ConversationId) {
			const session = await sessionFor(id);
			const agent = await session.conversation.agent(context);
			const { skills } = await loadResources(savedWorkspace(agent.cwd));
			return skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				location: skill.filePath,
				level: skill.level,
			}));
		},
		async listSkillsByLevel(cwd: string) {
			const skills = await scanSkillsByLevel(normalizeWorkspace(cwd ?? defaultCwd), options.promptHome ?? homedir());
			return skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				location: skill.filePath,
				level: skill.level,
			}));
		},
		installExtension(extension) {
			registry.install(extension);
		},
		async close() {
			await cleanup();
			return harness.close(context);
		},
	};
}
