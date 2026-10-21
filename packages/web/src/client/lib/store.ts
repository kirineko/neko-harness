import type { ChatView, NekoSelectableModel } from "@neko-harness/core";
import type { UpdateState } from "@neko-harness/core/application-version";
import type { QuestionList, TodoList } from "@neko-harness/core/interactions";
import { useSyncExternalStore } from "react";
import type {
	NekoContextSettingsState,
	NekoCredentialState,
	NekoDefaultModelState,
	NekoSearchSettingsState,
	NekoShellStatus,
	NekoWorkspaceSummary,
} from "./contract.ts";
import type { NekoSessionSummary } from "./gateway.ts";
import { localizeCoreError } from "./i18n/core-text.ts";

export type ConnPhase = "connecting" | "ready" | "reconnecting" | "error";

export type NekoNotice = { level: "info" | "error"; text: string };

/**
 * The last todo list / pending questions a session's view carried. A dropped connection clears `view`, but the
 * todo panel and an open question keep showing what was last known (marked offline); `undefined` = the gateway
 * did not support the field.
 */
export type RetainedInteractions = {
	sessionId: string;
	todos: TodoList | undefined;
	questions: QuestionList | undefined;
};

export type NekoState = {
	/** 网关连接阶段；error = /api/info 获取失败（不会自动恢复，需刷新页面）。 */
	phase: ConnPhase;
	updates: UpdateState | null;
	/** Windows 命令 shell（Git Bash）状态；null = 未连接，或网关不报告（非 Windows / 旧网关）。 */
	shell: NekoShellStatus | null;
	webInfo: { webVersion: string; installedVersion: string | null; serverId: string; gatewaySpawned: boolean } | null;
	credentials: NekoCredentialState | null;
	searchSettings: NekoSearchSettingsState | null;
	contextSettings: NekoContextSettingsState | null;
	/** 新建会话的默认模型（neko.default-model 订阅，实时）；null = 未连接。 */
	defaultModel: NekoDefaultModelState | null;
	workspaceRoot: string;
	workspaces: readonly NekoWorkspaceSummary[];
	operating: boolean;
	/** 会话目录（neko.session-directory 订阅推送，实时）。 */
	sessions: readonly NekoSessionSummary[];
	/** 模型目录（neko.models.list 全局快照）；拉取失败为空数组。 */
	models: readonly NekoSelectableModel[];
	currentSessionId: string | null;
	/** 当前会话的 ChatView 快照（neko.chat.view 订阅）；切换/断线中可能为 null。 */
	view: ChatView | null;
	retained: RetainedInteractions | null;
	notice: NekoNotice | null;
};

let state: NekoState = {
	phase: "connecting",
	updates: null,
	shell: null,
	webInfo: null,
	credentials: null,
	searchSettings: null,
	contextSettings: null,
	defaultModel: null,
	workspaceRoot: "",
	workspaces: [],
	operating: false,
	sessions: [],
	models: [],
	currentSessionId: null,
	view: null,
	retained: null,
	notice: null,
};
const listeners = new Set<() => void>();

function emit(next: NekoState): void {
	state = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** 整个网关驱动 UI 的外部 store（D4：只存服务订阅的最新快照）。 */
export function useNekoState(): NekoState {
	return useSyncExternalStore(subscribe, () => state);
}

/** 组件外读取当前状态（storeActions 内部与操作回调用）。 */
export function getState(): NekoState {
	return state;
}

export const storeActions = {
	setUpdates(updates: UpdateState | null) {
		emit({ ...state, updates });
	},
	setShell(shell: NekoShellStatus | null) {
		emit({ ...state, shell });
	},
	setWebInfo(webInfo: NekoState["webInfo"]) {
		emit({ ...state, webInfo });
	},
	setCredentials(credentials: NekoCredentialState | null): void {
		if (credentials && state.credentials && credentials.revision < state.credentials.revision) return;
		emit({ ...state, credentials });
	},
	setSearchSettings(searchSettings: NekoSearchSettingsState | null): void {
		if (searchSettings && state.searchSettings && searchSettings.revision < state.searchSettings.revision) return;
		emit({ ...state, searchSettings });
	},
	setContextSettings(contextSettings: NekoContextSettingsState | null): void {
		if (contextSettings && state.contextSettings && contextSettings.revision < state.contextSettings.revision) return;
		emit({ ...state, contextSettings });
	},
	setDefaultModel(defaultModel: NekoDefaultModelState | null): void {
		emit({ ...state, defaultModel });
	},
	setWorkspace(workspaceRoot: string): void {
		emit({ ...state, workspaceRoot });
	},
	setWorkspaces(workspaces: readonly NekoWorkspaceSummary[]): void {
		emit({ ...state, workspaces });
	},
	setOperation(operating: boolean): void {
		emit({ ...state, operating });
	},
	setPhase(phase: ConnPhase): void {
		emit({ ...state, phase });
	},
	setDirectory(sessions: readonly NekoSessionSummary[]): void {
		emit({ ...state, sessions });
	},
	setModels(models: readonly NekoSelectableModel[]): void {
		emit({ ...state, models });
	},
	setSession(currentSessionId: string | null): void {
		emit({ ...state, currentSessionId });
	},
	setView(view: ChatView | null): void {
		const sessionId = state.currentSessionId;
		const retained =
			view !== null && sessionId !== null
				? { sessionId, todos: view.todos, questions: view.questions }
				: state.retained;
		emit({ ...state, view, retained });
	},
	notice(notice: NekoNotice): void {
		emit({ ...state, notice: { ...notice, text: localizeCoreError(notice.text) } });
	},
	clearNotice(): void {
		if (state.notice !== null) emit({ ...state, notice: null });
	},
};
