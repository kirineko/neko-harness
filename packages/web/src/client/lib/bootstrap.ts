import type { NekoConversationChange, NekoModelRef, NekoSkillInfo } from "@neko-harness/core";
import { ApplicationProtocolError } from "@neko-harness/core/application-version";
import type { ImageFile } from "@neko-harness/core/image-transfer";
import type { SearchProviderId } from "@neko-harness/core/search-providers";
import type {
	NekoBrowseOptions,
	NekoContextSettingsPatch,
	WirePlanDecision,
	WireQuestionResponse,
} from "./contract.ts";
import { GatewayConnection } from "./gateway.ts";
import { getT } from "./i18n/index.ts";
import { storeActions } from "./store.ts";
import { readUpgradeDraft } from "./upgrade-draft";

/**
 * 应用启动接线：从 /api/info 拿 gateway WebSocket 地址 + serverId，
 * 建 GatewayConnection 并把服务事件接到 store；组件经 appActions 触发操作。
 */

export type GatewayInfo = {
	gatewayWs: string;
	protocolCompatible?: boolean;
	webVersion: string;
	installedVersion: string | null;
	workspaceRoot: string;
	serverId: string;
	/** Unix socket 路径；Windows（无 Unix 传输）不存在。 */
	socketPath?: string;
	/** 本 Web 进程 spawn 的 gateway；接入既有 gateway 时为 false（生命周期随 Web 退出）。 */
	gatewaySpawned?: boolean;
};

let infoGeneration = 0;
export async function fetchGatewayInfo(): Promise<GatewayInfo> {
	const generation = ++infoGeneration;
	const response = await fetch("/api/info", { cache: "no-store", signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw new Error(getT()("gw.infoFailed", { status: response.status }));
	const info = (await response.json()) as GatewayInfo;
	if (info.protocolCompatible === false) throw new ApplicationProtocolError();
	if (
		typeof info.gatewayWs !== "string" ||
		typeof info.serverId !== "string" ||
		typeof info.webVersion !== "string" ||
		typeof info.workspaceRoot !== "string" ||
		(info.installedVersion !== null && typeof info.installedVersion !== "string")
	)
		throw new Error(getT()("gw.invalidInfo"));
	if (generation === infoGeneration)
		storeActions.setWebInfo({
			serverId: info.serverId,
			webVersion: info.webVersion,
			installedVersion: info.installedVersion,
			gatewaySpawned: info.gatewaySpawned === true,
		});
	return info;
}

let connection: GatewayConnection | undefined;

/** 启动连接；供 main.tsx 模块级调用一次。 */
export function startNekoApp(): void {
	void (async () => {
		let info: GatewayInfo;
		try {
			info = await fetchGatewayInfo();
		} catch (error) {
			storeActions.setPhase("error");
			storeActions.notice({
				level: "error",
				text:
					error instanceof ApplicationProtocolError
						? getT()("gw.incompatible")
						: getT()("gw.infoLoadFailed", { error: error instanceof Error ? error.message : String(error) }),
			});
			return;
		}
		const recovery = readUpgradeDraft();
		const restored = recovery?.serverId === info.serverId ? recovery : null;
		connection = new GatewayConnection({
			url: info.gatewayWs,
			serverId: info.serverId,
			workspaceRoot: restored?.workspace ?? info.workspaceRoot,
			preferredSession: restored?.session ?? undefined,
			discover: fetchGatewayInfo,
			events: {
				onPhase: storeActions.setPhase,
				onUpdates: storeActions.setUpdates,
				onShell: storeActions.setShell,
				onCredentials: storeActions.setCredentials,
				onSearchSettings: storeActions.setSearchSettings,
				onContextSettings: storeActions.setContextSettings,
				onDefaultModel: storeActions.setDefaultModel,
				onWorkspaces: (state) => storeActions.setWorkspaces(state.workspaces),
				onWorkspace: storeActions.setWorkspace,
				onOperation: storeActions.setOperation,
				onError: (text) => storeActions.notice({ level: "error", text }),
				onDirectory: (directory) => storeActions.setDirectory(directory.sessions),
				onModels: storeActions.setModels,
				onSessionChange: storeActions.setSession,
				onView: storeActions.setView,
			},
		});
		await connection.start();
		const refresh = () => {
			if (document.visibilityState === "visible") void fetchGatewayInfo().catch(() => {});
		};
		const timer = setInterval(refresh, 30000);
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener(
			"pagehide",
			() => {
				clearInterval(timer);
				document.removeEventListener("visibilitychange", refresh);
			},
			{ once: true },
		);
		if (restored?.text && connection.currentSessionId !== restored.session)
			storeActions.notice({ level: "info", text: getT()("gw.sessionGone") });
	})();
}

function notReady(): void {
	storeActions.notice({ level: "error", text: getT()("gw.notReady") });
}

export const appActions = {
	subagent(taskId: number | string) {
		return requireConnection().subagent(taskId);
	},
	jobOutput(sessionId: string, jobId: string, since?: number) {
		return requireConnection().jobOutput(sessionId, jobId, since);
	},
	jobStop(sessionId: string, jobId: string) {
		return requireConnection().jobStop(sessionId, jobId);
	},
	workspace(sessionId: string) {
		return requireConnection().workspace(sessionId);
	},
	checkUpdates() {
		return requireConnection().checkUpdates();
	},
	saveCredential(provider: string, key: string) {
		return requireConnection().saveCredential(provider, key);
	},
	removeCredential(provider: string) {
		return requireConnection().removeCredential(provider);
	},
	setProviderEnabled(provider: string, enabled: boolean) {
		return requireConnection().setProviderEnabled(provider, enabled);
	},
	setContextSettings(patch: NekoContextSettingsPatch) {
		return requireConnection().setContextSettings(patch);
	},
	resetContextSettings() {
		return requireConnection().resetContextSettings();
	},
	setDefaultModel(model: NekoModelRef) {
		return requireConnection().setDefaultModel(model);
	},
	clearDefaultModel() {
		return requireConnection().clearDefaultModel();
	},
	setSearchProvider(provider: SearchProviderId) {
		return requireConnection().setSearchProvider(provider);
	},
	configure(change: NekoConversationChange, sessionId: string) {
		const current = requireConnection();
		if (current.currentSessionId !== sessionId || !current.ready)
			return Promise.reject(new Error(getT()("gw.sessionChangedRetry")));
		return current.configure(change);
	},
	submit(content: string, files: ImageFile[] = [], requestId?: string, sessionId?: string): Promise<void> {
		return requireConnection().submit(content, files, requestId, sessionId);
	},
	steer(sessionId: string, id: number) {
		return requireConnection().steer(sessionId, id);
	},
	withdraw(sessionId: string, id: number) {
		return requireConnection().withdraw(sessionId, id);
	},
	questionGet(sessionId: string, id: number) {
		return requireConnection().questionGet(sessionId, id);
	},
	questionRespond(sessionId: string, input: { id: number; version: string; response: WireQuestionResponse }) {
		return requireConnection().questionRespond(sessionId, input);
	},
	planMode(sessionId: string, mode: "normal" | "plan") {
		return requireConnection().planMode(sessionId, mode);
	},
	planGet(sessionId: string, version: string) {
		return requireConnection().planGet(sessionId, version);
	},
	planRespond(sessionId: string, input: { version: string; decision: WirePlanDecision }) {
		return requireConnection().planRespond(sessionId, input);
	},
	searchFiles(query: string, workspaceRoot: string, signal: AbortSignal) {
		return requireConnection().searchFiles(query, workspaceRoot, signal);
	},
	workspaceImage(path: string, sessionId: string, signal: AbortSignal) {
		return requireConnection().workspaceImage(path, sessionId, signal);
	},
	compact(instructions: string, sessionId?: string): Promise<void> {
		return requireConnection().compact(instructions, sessionId);
	},
	listSkills(sessionId: string, signal: AbortSignal): Promise<readonly NekoSkillInfo[]> {
		return requireConnection().listSkills(sessionId, signal);
	},
	marketList(query?: string) {
		return requireConnection().marketList(query);
	},
	marketDetail(name: string) {
		return requireConnection().marketDetail(name);
	},
	marketPreview(name: string) {
		return requireConnection().marketPreview(name);
	},
	marketInstall(name: string, scope: "user" | "project", overwrite?: boolean) {
		return requireConnection().marketInstall(name, scope, overwrite);
	},
	marketUninstall(name: string, scope: "user" | "project") {
		return requireConnection().marketUninstall(name, scope);
	},
	image(entryId: number, contentIndex: number, sessionId?: string) {
		return requireConnection().image(entryId, contentIndex, sessionId);
	},
	abort(): void {
		if (connection?.ready !== true) {
			notReady();
			return;
		}
		connection.abort();
	},
	selectSession(sessionId: string): Promise<void> {
		return requireConnection().attachTo(sessionId);
	},
	selectWorkspace(path: string): Promise<void> {
		return requireConnection().selectWorkspace(path);
	},
	addWorkspace(path: string): Promise<void> {
		return requireConnection().addWorkspace(path);
	},
	browse(options: NekoBrowseOptions) {
		return requireConnection().browse(options);
	},
	createSession(): Promise<void> {
		return requireConnection().createSession();
	},
	/** 会话级切换模型；下一次请求生效，状态条随投影 agent.model 即时更新。 */
	configureModel(model: NekoModelRef): void {
		if (connection === undefined) {
			notReady();
			return;
		}
		connection.configure({ model }).catch((error: unknown) => {
			storeActions.notice({ level: "error", text: error instanceof Error ? error.message : String(error) });
		});
	},
	archiveSession(sessionId: string): Promise<void> {
		return requireConnection().archiveSession(sessionId);
	},
};
function requireConnection(): GatewayConnection {
	if (!connection) throw new Error(getT()("gw.notStarted"));
	return connection;
}
export function reportError(error: unknown): void {
	storeActions.notice({ level: "error", text: error instanceof Error ? error.message : String(error) });
}
