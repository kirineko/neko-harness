import type {
	ChatView,
	NekoConversationChange,
	NekoModelRef,
	NekoSelectableModel,
	NekoSkillInfo,
} from "@neko-harness/core";
import { ApplicationProtocolError, type UpdateState } from "@neko-harness/core/application-version";
import { downloadImage, type ImageFile, uploadImage } from "@neko-harness/core/image-transfer";
import type { SearchProviderId } from "@neko-harness/core/search-providers";
import { byMessage, byVisited } from "@neko-harness/core/session-display";
import {
	createGatewayConnection,
	jobsClient,
	type NekoGatewayConnection,
	planClient,
	questionsClient,
	queueClient,
	workspaceClient,
} from "@neko-harness/gateway/client-session";
import { boundedWebSocketLink } from "@neko-harness/gateway/link";
import type {
	NekoBrowseOptions,
	NekoChat,
	NekoContextSettings,
	NekoContextSettingsPatch,
	NekoContextSettingsState,
	NekoCredentialState,
	NekoCredentials,
	NekoDefaultModel,
	NekoDefaultModelState,
	NekoDirectoryPage,
	NekoDirectoryState,
	NekoMarketInstallResult,
	NekoMarketPreview,
	NekoMarketSkill,
	NekoModels,
	NekoSearchSettings,
	NekoSearchSettingsState,
	NekoSessionManagement,
	NekoSessionSummary,
	NekoShellStatus,
	NekoSkillMarket,
	NekoWorkspaceFiles,
	NekoWorkspaceState,
	NekoWorkspaces,
	WirePlanDecision,
	WirePlanRecord,
	WirePlanView,
	WireQuestionRecord,
	WireQuestionResponse,
	WireSteerResult,
	WireWithdrawResult,
} from "./contract.ts";
import { getT } from "./i18n/index.ts";

export type ConnPhase = "connecting" | "ready" | "reconnecting" | "error";
export type GatewayEvents = {
	onPhase(phase: ConnPhase): void;
	onUpdates?(state: UpdateState | null): void;
	onShell?(shell: NekoShellStatus | null): void;
	onCredentials?(state: NekoCredentialState | null): void;
	onSearchSettings?(state: NekoSearchSettingsState | null): void;
	onContextSettings?(state: NekoContextSettingsState | null): void;
	onDefaultModel?(state: NekoDefaultModelState | null): void;
	onError(text: string): void;
	onDirectory(state: NekoDirectoryState): void;
	onWorkspaces(state: NekoWorkspaceState): void;
	onWorkspace(path: string): void;
	onOperation(busy: boolean): void;
	onModels(models: readonly NekoSelectableModel[]): void;
	onSessionChange(sessionId: string | null): void;
	onView(view: ChatView | null): void;
};
export type GatewayConnectionOptions = {
	readonly url: string;
	readonly serverId: string;
	readonly workspaceRoot: string;
	readonly events: GatewayEvents;
	readonly discover?: () => Promise<{ gatewayWs: string; serverId: string }>;
	readonly preferredSession?: string;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
};
export function workspaceSessions(sessions: readonly NekoSessionSummary[], path: string): NekoSessionSummary[] {
	return sessions.filter((s) => s.workspaceRoot === path).sort(byMessage);
}

/** Single attachment, serialized navigation, and generation-guarded snapshots. */
export class GatewayConnection {
	subagent(taskId: number | string) {
		if (!this.ready || !this.#client) throw new Error(getT()("gw.sessionNotReady"));
		return this.#client.subagent(taskId);
	}
	readonly #options: GatewayConnectionOptions;
	#client: NekoGatewayConnection | undefined;
	#management: NekoSessionManagement | undefined;
	#workspaces: NekoWorkspaces | undefined;
	#workspaceFiles: NekoWorkspaceFiles | undefined;
	#models: NekoModels | undefined;
	#credentials: NekoCredentials | undefined;
	#searchSettings: NekoSearchSettings | undefined;
	#contextSettings: NekoContextSettings | undefined;
	#defaultModel: NekoDefaultModel | undefined;
	#skillMarket: NekoSkillMarket | undefined;
	#chat: NekoChat | undefined;
	#sessions: readonly NekoSessionSummary[] = [];
	#workspace: string;
	#currentSessionId: string | undefined;
	#unsub: (() => void)[] = [];
	#unsubView: (() => void) | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#attempt = 0;
	#epoch = 0;
	#viewEpoch = 0;
	#disposed = false;
	#connected = false;
	#incompatible = false;
	#operating = false;
	/** The current workspace was in the last workspace list seen; a later list without it means it was removed. */
	#workspaceListed = false;
	#workspaceGone = false;
	#initialized = false;
	constructor(options: GatewayConnectionOptions) {
		this.#options = options;
		this.#workspace = options.workspaceRoot;
		this.#currentSessionId = options.preferredSession;
	}
	get currentSessionId() {
		return this.#currentSessionId;
	}
	get workspaceRoot() {
		return this.#workspace;
	}
	get ready() {
		return this.#connected && !this.#operating && this.#chat !== undefined;
	}
	get managementReady() {
		return this.#connected && !this.#operating;
	}
	async saveCredential(provider: string, key: string): Promise<void> {
		if (!this.#connected || !this.#credentials) throw new Error(getT()("gw.notConnected"));
		await this.#credentials.save({ provider, key });
	}
	async removeCredential(provider: string): Promise<void> {
		if (!this.#connected || !this.#credentials) throw new Error(getT()("gw.notConnected"));
		await this.#credentials.remove({ provider });
	}
	async setProviderEnabled(provider: string, enabled: boolean): Promise<void> {
		if (!this.#connected || !this.#credentials) throw new Error(getT()("gw.notConnected"));
		await this.#credentials.setEnabled({ provider, enabled });
	}
	async setSearchProvider(provider: SearchProviderId): Promise<void> {
		if (!this.#connected || !this.#searchSettings) throw new Error(getT()("gw.notConnected"));
		await this.#searchSettings.set({ provider });
	}
	async setContextSettings(patch: NekoContextSettingsPatch): Promise<void> {
		if (!this.#connected || !this.#contextSettings) throw new Error(getT()("gw.notConnected"));
		await this.#contextSettings.set(patch);
	}
	async resetContextSettings(): Promise<void> {
		if (!this.#connected || !this.#contextSettings) throw new Error(getT()("gw.notConnected"));
		await this.#contextSettings.reset({});
	}
	async setDefaultModel(model: NekoModelRef): Promise<void> {
		if (!this.#connected || !this.#defaultModel) throw new Error(getT()("gw.notConnected"));
		await this.#defaultModel.set(model);
	}
	async clearDefaultModel(): Promise<void> {
		if (!this.#connected || !this.#defaultModel) throw new Error(getT()("gw.notConnected"));
		await this.#defaultModel.clear(null);
	}
	async start(): Promise<void> {
		this.#options.events.onPhase("connecting");
		this.#options.events.onWorkspace(this.#workspace);
		try {
			await this.#connect();
		} catch (error) {
			this.#error(error);
			if (error instanceof ApplicationProtocolError) {
				this.#incompatible = true;
				this.#options.events.onPhase("error");
				await this.#teardown();
			} else this.#scheduleReconnect();
		}
	}
	#error(error: unknown) {
		this.#options.events.onError(
			error instanceof ApplicationProtocolError
				? getT()("gw.incompatible")
				: error instanceof Error
					? error.message
					: String(error),
		);
	}
	#assert(epoch: number) {
		if (this.#disposed || epoch !== this.#epoch) throw new Error(getT()("gw.connectionChanged"));
	}
	async #operate(operation: (epoch: number) => Promise<void>): Promise<void> {
		if (!this.managementReady) throw new Error(getT()("gw.busy"));
		this.#operating = true;
		this.#options.events.onOperation(true);
		const epoch = this.#epoch;
		try {
			await operation(epoch);
		} finally {
			this.#operating = false;
			this.#options.events.onOperation(false);
			if (epoch === this.#epoch) this.#reconcile();
		}
	}
	async selectWorkspace(path: string): Promise<void> {
		await this.#operate(async (epoch) => {
			if (!this.#workspaces?.state.value.workspaces.some((w) => w.path === path))
				throw new Error(getT()("gw.workspaceMissing"));
			await this.#select(path, undefined, epoch);
		});
	}
	async addWorkspace(path: string): Promise<void> {
		await this.#operate(async (epoch) => {
			const item = await this.#workspaces!.add({ path });
			this.#assert(epoch);
			await this.#select(item.path, undefined, epoch);
		});
	}
	/** Removing the current workspace moves to the next one only after the server accepted; a rejection changes nothing. */
	async removeWorkspace(path: string): Promise<void> {
		await this.#operate(async (epoch) => {
			const next = this.#workspaces!.state.value.workspaces.find((w) => w.path !== path);
			await this.#workspaces!.remove({ path });
			this.#assert(epoch);
			if (path !== this.#workspace) return;
			this.#workspaceGone = false;
			if (next) await this.#select(next.path, undefined, epoch);
		});
	}
	async browse(options: NekoBrowseOptions): Promise<NekoDirectoryPage> {
		if (!this.#connected || !this.#workspaces) throw new Error(getT()("gw.notConnected"));
		return this.#workspaces.browse(options);
	}
	async attachTo(id: string): Promise<void> {
		await this.#operate(async (epoch) => {
			const entry = this.#sessions.find((s) => s.id === id && s.workspaceRoot === this.#workspace);
			if (!entry) throw new Error(getT()("gw.sessionNotInWorkspace"));
			await this.#attach(id, epoch);
		});
	}
	async createSession(): Promise<void> {
		await this.#operate(async (epoch) => {
			const created = await this.#management!.create({ cwd: this.#workspace });
			this.#assert(epoch);
			await this.#attach(created.id, epoch);
		});
	}
	async archiveSession(id: string): Promise<void> {
		await this.#operate(async (epoch) => {
			await this.#management!.archive(id);
			this.#assert(epoch);
			this.#sessions = this.#sessions.filter((s) => s.id !== id);
			if (this.#currentSessionId === id) await this.#select(this.#workspace, undefined, epoch);
		});
	}
	async #select(path: string, preferred: string | undefined, epoch: number): Promise<void> {
		const sessions = workspaceSessions(this.#sessions, path).sort(byVisited);
		const target = sessions.find((s) => s.id === preferred) ?? sessions[0];
		try {
			if (target) await this.#attach(target.id, epoch);
			else await this.#clear(epoch);
			this.#assert(epoch);
			this.#workspace = path;
			this.#workspaceListed = this.#workspaces?.state.value.workspaces.some((w) => w.path === path) === true;
			this.#options.events.onWorkspace(path);
		} catch (error) {
			// A failed attach cannot leave an old chat eligible for submissions.
			if (epoch === this.#epoch) {
				this.#dropView();
				this.#currentSessionId = undefined;
				this.#options.events.onSessionChange(null);
			}
			throw error;
		}
	}
	async #attach(id: string, epoch: number): Promise<void> {
		if (this.#currentSessionId === id && this.#chat) return;
		const client = this.#client!;
		this.#dropView();
		const generation = this.#viewEpoch;
		this.#currentSessionId = undefined;
		this.#options.events.onSessionChange(null);
		const chat = await client.attach(id);
		this.#assert(epoch);

		this.#chat = chat;
		this.#currentSessionId = id;
		this.#options.events.onSessionChange(id);
		const publish = (view: ChatView | undefined) => {
			if (!view) return;
			if (epoch === this.#epoch && generation === this.#viewEpoch) this.#options.events.onView(view);
		};
		if (chat.view.value) publish(chat.view.value);
		this.#unsubView = chat.view.subscribe(publish);
	}
	async #clear(epoch: number): Promise<void> {
		this.#dropView();
		this.#currentSessionId = undefined;
		this.#options.events.onSessionChange(null);
		await this.#client!.detach();
		this.#assert(epoch);
	}
	#reconcile(): void {
		if (!this.managementReady) return;
		if (this.#workspaceGone) {
			const listed = this.#workspaces?.state.value.workspaces ?? [];
			const next = listed[0];
			if (listed.some((w) => w.path === this.#workspace)) this.#workspaceGone = false;
			else if (next) {
				this.#workspaceGone = false;
				void this.#operate((epoch) => this.#select(next.path, undefined, epoch)).catch((e) => this.#error(e));
				return;
			}
		}
		if (!this.#currentSessionId || this.#sessions.some((s) => s.id === this.#currentSessionId)) return;
		void this.#operate((epoch) => this.#select(this.#workspace, undefined, epoch)).catch((e) => this.#error(e));
	}
	async configure(change: NekoConversationChange): Promise<void> {
		if (!this.ready) throw new Error(getT()("gw.sessionNotReady"));
		await this.#chat!.configure(change);
	}
	async submit(
		content: string,
		files: ImageFile[] = [],
		requestId: string = crypto.randomUUID(),
		sessionId?: string,
	): Promise<void> {
		if (sessionId !== undefined && sessionId !== this.#currentSessionId)
			throw new Error(getT()("gw.sessionChangedDraft"));
		if (!this.ready) throw new Error(getT()("gw.sessionNotReady"));
		const chat = this.#chat!;
		const ids: string[] = [];
		try {
			for (const file of files)
				ids.push(
					await uploadImage(file, {
						begin: (i) => chat.beginImage(i),
						append: (i) => chat.appendImage(i),
						finish: (id) => chat.finishImage(id),
						release: (id) => chat.releaseImage(id),
					}),
				);
			await chat.submit({ content, requestId, images: ids });
		} finally {
			for (const id of ids) await chat.releaseImage(id).catch(() => {});
		}
	}
	async searchFiles(query: string, workspaceRoot: string, signal: AbortSignal) {
		if (!this.managementReady || !this.#workspaceFiles || workspaceRoot !== this.#workspace)
			throw new Error(getT()("gw.workspaceNotReady"));
		return this.#client!.host.root((ctx) => this.#workspaceFiles!.search({ workspaceRoot, query }, ctx), { signal });
	}
	async workspaceImage(path: string, sessionId: string, signal: AbortSignal): Promise<ImageFile> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChangedDraft"));
		const chat = this.#chat!;
		return this.#client!.host.root(
			async (ctx) => {
				const image = await chat.importImage(path, ctx);
				try {
					const file = await downloadImage((offset) => chat.draftImage({ id: image.id, offset }, ctx));
					return { ...file, name: image.name };
				} finally {
					await chat.releaseImage(image.id).catch(() => {});
				}
			},
			{ signal },
		);
	}
	async compact(instructions: string, sessionId?: string): Promise<void> {
		if (sessionId !== undefined && sessionId !== this.#currentSessionId)
			throw new Error(getT()("gw.sessionChangedDraft"));
		if (!this.ready) throw new Error(getT()("gw.sessionNotReady"));
		await this.#chat!.compact({ instructions });
	}
	/** Background job calls are bound to the session the panel was opened for. */
	#jobs(sessionId: string) {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChanged"));
		return jobsClient(this.#chat!);
	}
	/** Queued-input calls are bound to the session the queue bar shows. */
	async steer(sessionId: string, id: number): Promise<WireSteerResult> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChanged"));
		return queueClient(this.#chat!).steer(id);
	}
	async withdraw(sessionId: string, id: number): Promise<WireWithdrawResult> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChanged"));
		return queueClient(this.#chat!).withdraw(id);
	}
	/** Question calls are bound to the session the card shows; answering is never a chat submit. */
	async questionGet(sessionId: string, id: number): Promise<WireQuestionRecord | null> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChangedOrNotReady"));
		return questionsClient(this.#chat!).get(id);
	}
	async questionRespond(
		sessionId: string,
		input: { id: number; version: string; response: WireQuestionResponse },
	): Promise<WireQuestionRecord> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChangedAnswerDraft"));
		return questionsClient(this.#chat!).respond(input);
	}
	/** Plan calls are bound to the session the card or composer shows; deciding is never a chat submit. */
	async planMode(sessionId: string, mode: "normal" | "plan"): Promise<WirePlanView> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChangedOrNotReady"));
		return planClient(this.#chat!).setMode(mode);
	}
	async planGet(sessionId: string, version: string): Promise<WirePlanRecord | null> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChangedOrNotReady"));
		return planClient(this.#chat!).get(version);
	}
	async planRespond(
		sessionId: string,
		input: { version: string; decision: WirePlanDecision },
	): Promise<WirePlanRecord> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChangedFeedbackDraft"));
		return planClient(this.#chat!).respond(input);
	}
	/** Workspace browsing is bound to the session the sidebar was opened for; the host makes signals cancel requests. */
	workspace(sessionId: string) {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionChangedOrNotReady"));
		return workspaceClient(this.#chat!, this.#client!.host);
	}
	async jobOutput(sessionId: string, jobId: string, since?: number) {
		return this.#jobs(sessionId).output(jobId, since);
	}
	async jobStop(sessionId: string, jobId: string) {
		return this.#jobs(sessionId).stop(jobId);
	}
	async image(entryId: number, contentIndex: number, sessionId?: string): Promise<ImageFile> {
		if (sessionId !== undefined && sessionId !== this.#currentSessionId)
			throw new Error(getT()("gw.sessionChangedDraft"));
		if (!this.ready) throw new Error(getT()("gw.sessionNotReady"));
		const chat = this.#chat!;
		return downloadImage((offset) => chat.getImage({ entryId, contentIndex, offset }));
	}
	abort(): void {
		if (this.ready) void this.#chat!.abort(null).catch((e: unknown) => this.#error(e));
	}
	async listSkills(sessionId: string, signal: AbortSignal): Promise<readonly NekoSkillInfo[]> {
		if (!this.ready || sessionId !== this.#currentSessionId) throw new Error(getT()("gw.sessionNotReady"));
		return this.#client!.host.root((ctx) => this.#chat!.skills(null, ctx), { signal });
	}
	async listModels(): Promise<readonly NekoSelectableModel[]> {
		return this.#models?.list(null) ?? [];
	}
	/** 技能市场：读操作直发；工作区缺省用当前工作区（项目级状态判定的依据）。 */
	marketList(query?: string): Promise<readonly NekoMarketSkill[]> {
		if (!this.#skillMarket) return Promise.reject(new Error(getT()("gw.notConnected")));
		return this.#skillMarket.list({ ...(query ? { query } : {}), workspaceRoot: this.#workspace });
	}
	marketDetail(name: string): Promise<NekoMarketSkill> {
		if (!this.#skillMarket) return Promise.reject(new Error(getT()("gw.notConnected")));
		return this.#skillMarket.detail({ name, workspaceRoot: this.#workspace });
	}
	marketPreview(name: string): Promise<NekoMarketPreview> {
		if (!this.#skillMarket) return Promise.reject(new Error(getT()("gw.notConnected")));
		return this.#skillMarket.preview({ name });
	}
	marketInstall(name: string, scope: "user" | "project", overwrite?: boolean): Promise<NekoMarketInstallResult> {
		if (!this.#skillMarket) return Promise.reject(new Error(getT()("gw.notConnected")));
		return this.#skillMarket.install({
			name,
			scope,
			workspaceRoot: this.#workspace,
			...(overwrite ? { overwrite } : {}),
		});
	}
	async marketUninstall(name: string, scope: "user" | "project"): Promise<void> {
		if (!this.#skillMarket) return Promise.reject(new Error(getT()("gw.notConnected")));
		await this.#skillMarket.uninstall({ name, scope, workspaceRoot: this.#workspace });
	}
	async #connect(): Promise<void> {
		const epoch = ++this.#epoch;
		const address = this.#options.discover
			? await this.#options.discover()
			: { gatewayWs: this.#options.url, serverId: this.#options.serverId };
		this.#assert(epoch);
		const client = createGatewayConnection(boundedWebSocketLink(new WebSocket(address.gatewayWs)), address.serverId);
		this.#client = client;
		client.link.onClose(() => {
			if (client === this.#client) this.#scheduleReconnect();
		});
		try {
			await client.ready();
		} catch (error) {
			if (error instanceof ApplicationProtocolError) {
				this.#incompatible = true;
				if (this.#timer) {
					clearTimeout(this.#timer);
					this.#timer = undefined;
				}
				this.#options.events.onPhase("error");
			}
			throw error;
		}
		this.#assert(epoch);
		this.#unsub.push(
			client.application.info.subscribe((value) => {
				if (epoch !== this.#epoch) return;
				this.#options.events.onUpdates?.(value);
				this.#options.events.onShell?.(value.shell ?? null);
			}),
		);
		this.#options.events.onUpdates?.(client.application.info.value);
		this.#options.events.onShell?.(client.application.info.value.shell ?? null);
		this.#management = client.management;
		this.#workspaces = client.workspaces;
		this.#workspaceFiles = client.workspaceFiles;
		this.#models = client.models;
		this.#credentials = client.credentials;
		this.#searchSettings = client.searchSettings;
		this.#contextSettings = client.contextSettings;
		this.#defaultModel = client.defaultModel;
		this.#skillMarket = client.skillMarket;

		let credentialRevision = this.#credentials.state.value?.revision;
		this.#unsub.push(
			this.#credentials.state.subscribe((value) => {
				if (epoch !== this.#epoch) return;
				this.#options.events.onCredentials?.(value);
				// Enablement and keys decide which models are selectable, so a changed state refetches the list.
				if (this.#connected && value.revision !== credentialRevision) this.#refreshModels(epoch);
				credentialRevision = value.revision;
			}),
		);
		this.#options.events.onCredentials?.(this.#credentials.state.value);
		this.#unsub.push(
			this.#searchSettings.state.subscribe((value) => {
				if (epoch === this.#epoch) this.#options.events.onSearchSettings?.(value);
			}),
		);
		this.#options.events.onSearchSettings?.(this.#searchSettings.state.value);
		const contextSettings = this.#contextSettings;
		this.#unsub.push(
			contextSettings.state.subscribe((value) => {
				if (epoch === this.#epoch) this.#options.events.onContextSettings?.(value);
			}),
		);
		this.#options.events.onContextSettings?.(contextSettings.state.value);
		const defaultModel = this.#defaultModel;
		this.#unsub.push(
			defaultModel.state.subscribe((value) => {
				if (epoch === this.#epoch) this.#options.events.onDefaultModel?.(value);
			}),
		);
		this.#options.events.onDefaultModel?.(defaultModel.state.value);
		const directory = client.directory;
		const publish = (value: NekoDirectoryState) => {
			if (epoch !== this.#epoch) return;
			this.#sessions = value.sessions;
			this.#options.events.onDirectory(value);
			this.#reconcile();
		};
		this.#unsub.push(directory.state.subscribe(publish));
		this.#unsub.push(
			this.#workspaces.state.subscribe((value) => {
				if (epoch !== this.#epoch) return;
				this.#options.events.onWorkspaces(value);
				const listed = value.workspaces.some((w) => w.path === this.#workspace);
				if (!listed && this.#workspaceListed) {
					this.#workspaceGone = true;
					this.#reconcile();
				}
				this.#workspaceListed = listed;
			}),
		);
		if (!this.#initialized) {
			await this.#workspaces.add({ path: this.#workspace });
			this.#assert(epoch);
			this.#initialized = true;
		}
		publish(directory.state.value);
		this.#options.events.onWorkspaces(this.#workspaces.state.value);
		await this.#select(this.#workspace, this.#currentSessionId, epoch);
		this.#assert(epoch);
		this.#connected = true;
		this.#attempt = 0;
		this.#options.events.onPhase("ready");
		this.#refreshModels(epoch);
	}
	#modelRequest = 0;
	#refreshModels(epoch: number): void {
		const request = ++this.#modelRequest;
		void this.#models
			?.list(null)
			.then((models) => {
				if (epoch === this.#epoch && request === this.#modelRequest) this.#options.events.onModels(models);
			})
			.catch(() => {});
	}
	async checkUpdates(): Promise<UpdateState> {
		if (!this.#client) throw new Error(getT()("gw.notConnected"));
		return this.#client.application.check(null);
	}
	#scheduleReconnect(): void {
		if (this.#disposed || this.#incompatible || this.#timer) return;
		++this.#epoch;
		this.#connected = false;
		this.#dropView();
		this.#options.events.onPhase("reconnecting");
		this.#options.events.onUpdates?.(null);
		this.#options.events.onShell?.(null);
		const delay = Math.min((this.#options.retryBaseMs ?? 800) * ++this.#attempt, this.#options.retryMaxMs ?? 8000);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#teardown()
				.then(() => {
					if (!this.#disposed) return this.#connect();
				})
				.catch((e) => {
					this.#error(e);
					if (e instanceof ApplicationProtocolError) {
						this.#options.events.onPhase("error");
						void this.#teardown();
					} else this.#scheduleReconnect();
				});
		}, delay);
	}
	#dropView(): void {
		++this.#viewEpoch;
		this.#unsubView?.();
		this.#unsubView = undefined;
		this.#chat?.release();
		this.#chat = undefined;
		this.#options.events.onView(null);
	}
	async #teardown(): Promise<void> {
		for (const unsubscribe of this.#unsub.splice(0)) unsubscribe();
		this.#dropView();
		this.#management = undefined;
		this.#workspaces = undefined;
		this.#workspaceFiles = undefined;
		this.#credentials = undefined;
		this.#options.events.onCredentials?.(null);
		this.#searchSettings = undefined;
		this.#options.events.onSearchSettings?.(null);
		this.#contextSettings = undefined;
		this.#options.events.onContextSettings?.(null);
		this.#defaultModel = undefined;
		this.#options.events.onDefaultModel?.(null);
		this.#models = undefined;

		const client = this.#client;
		this.#client = undefined;
		await client?.close().catch(() => {});
	}
	dispose(): void {
		this.#disposed = true;
		++this.#epoch;
		this.#connected = false;
		clearTimeout(this.#timer);
		void this.#teardown();
	}
}
export type { NekoDirectoryState, NekoSessionSummary };
