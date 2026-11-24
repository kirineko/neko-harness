import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
	type CallToolResult,
	createMcpToolName,
	McpAuthRequiredError,
	McpClient,
	type McpTransport,
	mcpServerSummary,
	StdioTransport,
	StreamableHttpTransport,
	type Tool,
} from "@earendil-works/pi-mcp";
import {
	completeMcpSignIn,
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	type McpAuthProvider,
	type McpLoopbackCallback,
	McpOAuthAuthorizationRequiredError,
	type McpOAuthSettings,
	type McpSignInRedirect,
	type OAuthChallenge,
	responseFromRedirectUrl,
	startMcpSignIn,
} from "@earendil-works/pi-mcp/oauth";
import { RUNNING_VERSION } from "./application-version.ts";
import { DEFAULT_MCP_AUTH_PATH, McpAuthStore } from "./mcp-auth.ts";
import {
	DEFAULT_MCP_CONFIG_PATH,
	expandEnvTemplate,
	expandHomePrefix,
	expandRecordTemplates,
	McpConfigStore,
	type ParsedMcpServer,
	resolveMcpCwd,
	serverConfigHash,
} from "./mcp-config.ts";
import {
	MCP_LIMITS,
	type McpBeginSignInResult,
	type McpExposure,
	type McpServerConfigInput,
	type McpServerSnapshot,
	type McpServerStatus,
	type McpSignInSnapshot,
	type McpSnapshot,
	type McpToolInfo,
} from "./mcp-types.ts";

export type OfferedMcpTool = {
	readonly server: string;
	readonly tool: Tool;
	readonly registeredName: string;
	readonly readOnly: boolean;
};

export type OfferedMcpServer = {
	readonly name: string;
	readonly exposure: McpExposure;
	readonly status: McpServerStatus;
	readonly oauthSupported: boolean;
	readonly summary: string;
	readonly instructions?: string;
	readonly tools: readonly OfferedMcpTool[];
};

export type McpTransportFactory = (
	server: ParsedMcpServer,
	context: {
		readonly env: NodeJS.ProcessEnv;
		readonly baseCwd: string;
		readonly home: string;
		readonly authProvider?: McpAuthProvider;
		readonly onStderr: (chunk: string) => void;
	},
) => McpTransport;

export type McpManagerOptions = {
	readonly configPath?: string;
	readonly authPath?: string;
	readonly baseCwd?: string;
	readonly home?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly clientName?: string;
	readonly watchDebounceMs?: number;
	readonly reconnectBaseMs?: number;
	readonly reconnectMaxMs?: number;
	readonly connectWaitMs?: number;
	readonly signInTtlMs?: number;
	readonly transportFactory?: McpTransportFactory;
	/** Skip filesystem watching (useful for deterministic unit tests). */
	readonly disableWatch?: boolean;
};

type ServerRuntime = {
	server: ParsedMcpServer;
	configHash: string;
	status: McpServerStatus;
	error: string | null;
	stderrTail: string;
	tools: Tool[];
	instructions: string | undefined;
	client: McpClient | null;
	authProvider: McpAuthProvider | null;
	oauthSupported: boolean;
	signedIn: boolean;
	challenge: OAuthChallenge | undefined;
	reconnectAttempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	connectPromise: Promise<void> | null;
	generation: number;
};

type ActiveSignIn = {
	readonly id: string;
	readonly server: string;
	readonly serverUrl: string;
	readonly redirectUrl: string;
	readonly authorization: McpSignInRedirect;
	readonly callback: McpLoopbackCallback;
	readonly controller: AbortController;
	readonly timer: ReturnType<typeof setTimeout>;
	status: "waiting" | "failed";
	error: string | null;
	settled: boolean;
};

function clipTailBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let start = buf.length - maxBytes;
	while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
	return buf.subarray(start).toString("utf8");
}

function clipSummary(description: string | undefined, instructions: string | undefined): string {
	const raw = mcpServerSummary(description, instructions);
	const chars = [...raw];
	if (chars.length <= MCP_LIMITS.maxSummaryChars) return raw;
	return `${chars
		.slice(0, MCP_LIMITS.maxSummaryChars - 1)
		.join("")
		.trimEnd()}…`;
}

function hasAuthorizationHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
	if (!headers) return false;
	return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

function isOAuthSupported(server: ParsedMcpServer): boolean {
	return server.transport === "http" && !hasAuthorizationHeader(server.input.headers);
}

function isAuthError(error: unknown): boolean {
	return error instanceof McpAuthRequiredError || error instanceof McpOAuthAuthorizationRequiredError;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveOAuthSettings(server: ParsedMcpServer, env: NodeJS.ProcessEnv): McpOAuthSettings {
	if (server.transport !== "http" || !server.input.oauth) return {};
	const raw = server.input.oauth;
	return {
		...(raw.clientId !== undefined ? { clientId: raw.clientId } : {}),
		...(raw.clientSecret !== undefined ? { clientSecret: expandEnvTemplate(raw.clientSecret, env) } : {}),
		...(raw.callbackPort !== undefined ? { callbackPort: raw.callbackPort } : {}),
		...(raw.callbackUrl !== undefined ? { callbackUrl: raw.callbackUrl } : {}),
		...(raw.scope !== undefined ? { scope: raw.scope } : {}),
		...(raw.clientName !== undefined ? { clientName: raw.clientName } : {}),
		...(raw.clientRegistration !== undefined ? { clientRegistration: raw.clientRegistration } : {}),
		...(raw.authServerMetadataUrl !== undefined ? { authServerMetadataUrl: new URL(raw.authServerMetadataUrl) } : {}),
	};
}

function defaultTransportFactory(
	server: ParsedMcpServer,
	ctx: {
		readonly env: NodeJS.ProcessEnv;
		readonly baseCwd: string;
		readonly home: string;
		readonly authProvider?: McpAuthProvider;
		readonly onStderr: (chunk: string) => void;
	},
): McpTransport {
	if (server.transport === "stdio") {
		const command = expandHomePrefix(server.input.command, ctx.home);
		const args = server.input.args?.map((arg) => expandHomePrefix(arg, ctx.home));
		const env = expandRecordTemplates(server.input.env, ctx.env);
		const cwd = resolveMcpCwd(server.input.cwd, ctx.baseCwd, ctx.home);
		return new StdioTransport({
			command,
			...(args ? { args } : {}),
			cwd,
			...(env ? { env } : {}),
			onStderr: ctx.onStderr,
		});
	}
	const headers = expandRecordTemplates(server.input.headers, ctx.env);
	return new StreamableHttpTransport({
		url: server.input.url,
		...(headers ? { headers } : {}),
		...(ctx.authProvider ? { authProvider: ctx.authProvider } : {}),
	});
}

/**
 * Process-wide MCP connection pool, config coordinator, and OAuth 2.1 sign-in manager.
 * One shared connection per enabled global server; tokens remain strictly on the host.
 */
export class McpManager {
	readonly configStore: McpConfigStore;
	readonly authStore: McpAuthStore;
	readonly #baseCwd: string;
	readonly #home: string;
	readonly #env: NodeJS.ProcessEnv;
	readonly #clientName: string;
	readonly #reconnectBaseMs: number;
	readonly #reconnectMaxMs: number;
	readonly #connectWaitMs: number;
	readonly #signInTtlMs: number;
	readonly #transportFactory: McpTransportFactory;
	readonly #disableWatch: boolean;

	readonly #runtimes = new Map<string, ServerRuntime>();
	readonly #signIns = new Map<string, ActiveSignIn>();
	readonly #listeners = new Set<(snapshot: McpSnapshot) => void>();
	readonly #toolListeners = new Set<() => void>();

	#revision = 1;
	#lastToolKey = "";
	#registeredReadOnly = new Map<string, boolean>();
	#registeredNameByTool = new Map<string, string>();
	#closed = false;
	#unsubConfig: (() => void) | null = null;
	#syncChain: Promise<void> = Promise.resolve();

	constructor(options: McpManagerOptions = {}) {
		this.configStore = new McpConfigStore(options.configPath ?? DEFAULT_MCP_CONFIG_PATH, {
			...(options.watchDebounceMs !== undefined ? { debounceMs: options.watchDebounceMs } : {}),
		});
		this.authStore = new McpAuthStore(options.authPath ?? DEFAULT_MCP_AUTH_PATH);
		this.#baseCwd = options.baseCwd ?? process.cwd();
		this.#home = options.home ?? homedir();
		this.#env = options.env ?? process.env;
		this.#clientName = options.clientName ?? "neko-harness";
		this.#reconnectBaseMs = options.reconnectBaseMs ?? MCP_LIMITS.reconnectBaseMs;
		this.#reconnectMaxMs = options.reconnectMaxMs ?? MCP_LIMITS.reconnectMaxMs;
		this.#connectWaitMs = options.connectWaitMs ?? MCP_LIMITS.connectWaitMs;
		this.#signInTtlMs = options.signInTtlMs ?? MCP_LIMITS.signInTtlMs;
		this.#transportFactory = options.transportFactory ?? defaultTransportFactory;
		this.#disableWatch = options.disableWatch === true;
	}

	async start(): Promise<void> {
		if (this.#closed) return;
		this.#unsubConfig = this.configStore.subscribe(() => {
			void this.#syncWithConfig();
		});
		await this.configStore.reload();
		await this.#syncWithConfig();
		if (!this.#disableWatch) this.configStore.startWatching();
	}

	subscribe(listener: (snapshot: McpSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Fires only when the set of offered servers, namespaces, or tools changes. */
	onToolsChange(listener: () => void): () => void {
		this.#toolListeners.add(listener);
		return () => this.#toolListeners.delete(listener);
	}

	hasEnabledServers(): boolean {
		for (const runtime of this.#runtimes.values()) {
			if (runtime.server.enabled) return true;
		}
		return false;
	}

	isToolReadOnly(registeredName: string): boolean {
		return this.#registeredReadOnly.get(registeredName) === true;
	}

	offeredServers(): OfferedMcpServer[] {
		const enabled = [...this.#runtimes.values()]
			.filter((rt) => rt.server.enabled)
			.sort((a, b) => a.server.name.localeCompare(b.server.name));
		const names = this.#computeRegisteredNames(enabled);
		return enabled.map((rt) => {
			const tools: OfferedMcpTool[] = rt.tools.map((tool) => {
				const key = `${rt.server.name}\0${tool.name}`;
				const registeredName = names.get(key) ?? createMcpToolName(rt.server.name, tool.name);
				return {
					server: rt.server.name,
					tool,
					registeredName,
					readOnly: tool.annotations?.readOnlyHint === true,
				};
			});
			return {
				name: rt.server.name,
				exposure: rt.server.exposure,
				status: rt.status,
				oauthSupported: rt.oauthSupported,
				summary: clipSummary(rt.server.input.description, rt.instructions),
				...(rt.instructions !== undefined ? { instructions: rt.instructions } : {}),
				tools,
			};
		});
	}

	snapshot(): McpSnapshot {
		const cfg = this.configStore.state;
		const enabled = [...this.#runtimes.values()].filter((rt) => rt.server.enabled);
		const names = this.#computeRegisteredNames(enabled);
		const servers: McpServerSnapshot[] = cfg.servers.map((server) => {
			const rt = this.#runtimes.get(server.name);
			const tools: McpToolInfo[] = (rt?.tools ?? []).map((tool) => ({
				name: tool.name,
				registeredName: names.get(`${server.name}\0${tool.name}`) ?? createMcpToolName(server.name, tool.name),
				...((tool.title ?? tool.annotations?.title) ? { title: tool.title ?? tool.annotations?.title } : {}),
				description: tool.description?.trim() || tool.title || tool.name,
				readOnly: tool.annotations?.readOnlyHint === true,
			}));
			return {
				name: server.name,
				transport: server.transport,
				enabled: server.enabled,
				exposure: server.exposure,
				config: server.input,
				status: rt?.status ?? (server.enabled ? "disconnected" : "disabled"),
				error: rt?.error ?? null,
				stderrTail: rt?.stderrTail ?? "",
				tools,
				oauth: {
					supported: rt?.oauthSupported ?? isOAuthSupported(server),
					signedIn: rt?.signedIn ?? false,
				},
			};
		});
		const signIns: McpSignInSnapshot[] = [...this.#signIns.values()].map((flow) => ({
			id: flow.id,
			server: flow.server,
			status: flow.status,
			authorizationUrl: flow.authorization.authorizationUrl,
			error: flow.error,
		}));
		return {
			revision: this.#revision,
			configPath: cfg.configPath,
			configError: cfg.configError,
			entryErrors: [...cfg.entryErrors],
			rawJson: cfg.rawJson,
			servers,
			signIns,
		};
	}

	async upsertServer(name: string, input: McpServerConfigInput): Promise<McpSnapshot> {
		await this.configStore.upsertServer(name, input);
		await this.#syncWithConfig();
		return this.snapshot();
	}

	async removeServer(name: string): Promise<McpSnapshot> {
		await this.configStore.removeServer(name);
		await this.#syncWithConfig();
		return this.snapshot();
	}

	async setEnabled(name: string, enabled: boolean): Promise<McpSnapshot> {
		await this.configStore.setEnabled(name, enabled);
		await this.#syncWithConfig();
		return this.snapshot();
	}

	async saveRawJson(rawText: string): Promise<McpSnapshot> {
		await this.configStore.saveRawJson(rawText);
		await this.#syncWithConfig();
		return this.snapshot();
	}

	async reconnect(name: string): Promise<McpSnapshot> {
		const rt = this.#runtimes.get(name);
		if (!rt) throw new Error(`MCP server "${name}" not found`);
		if (!rt.server.enabled) throw new Error(`MCP server "${name}" is disabled`);
		rt.reconnectAttempt = 0;
		this.#clearReconnectTimer(rt);
		await this.#disconnectRuntime(rt);
		this.#startConnect(rt);
		return this.snapshot();
	}

	/** Wait until all currently connecting servers have settled their current connection attempt. */
	async waitForReady(timeoutMs = 10_000): Promise<void> {
		const pending = [...this.#runtimes.values()]
			.map((rt) => rt.connectPromise)
			.filter((promise): promise is Promise<void> => promise !== null);
		if (pending.length === 0) return;
		await Promise.race([Promise.allSettled(pending), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
	}

	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
		options: { signal?: AbortSignal } = {},
	): Promise<CallToolResult> {
		const rt = this.#runtimes.get(serverName);
		if (!rt || !rt.server.enabled) {
			throw new Error(`MCP server "${serverName}" is not enabled.`);
		}
		if (rt.status === "connecting" && rt.connectPromise) {
			await this.#waitForConnect(rt, options.signal);
		}
		if (rt.status === "auth_required") {
			throw new Error(
				`MCP server "${serverName}" requires OAuth sign-in. Ask the user to sign in from Web /settings/mcp or TUI /mcp.`,
			);
		}
		if (!rt.client || rt.status !== "connected") {
			const detail = rt.error ? `: ${rt.error}` : "";
			throw new Error(`MCP server "${serverName}" is ${rt.status}${detail}`);
		}
		const timeoutMs = (rt.server.input.timeout ?? MCP_LIMITS.defaultTimeoutSec) * 1000;
		try {
			return await rt.client.callTool(toolName, args, {
				...(options.signal ? { signal: options.signal } : {}),
				timeoutMs,
			});
		} catch (error) {
			if (rt.oauthSupported && isAuthError(error)) {
				rt.status = "auth_required";
				rt.error = errorMessage(error);
				rt.signedIn = false;
				this.#clearReconnectTimer(rt);
				this.#notifyChange();
				throw new Error(
					`MCP server "${serverName}" requires OAuth sign-in. Ask the user to sign in from Web /settings/mcp or TUI /mcp.`,
				);
			}
			throw error;
		}
	}

	async beginSignIn(serverName: string): Promise<McpBeginSignInResult> {
		const rt = this.#runtimes.get(serverName);
		if (!rt) throw new Error(`MCP server "${serverName}" not found`);
		if (rt.server.transport !== "http" || !rt.oauthSupported) {
			throw new Error(`MCP server "${serverName}" does not use OAuth`);
		}
		// Replace any existing flow for this server.
		await this.#dropSignInsForServer(serverName);

		const serverUrl = rt.server.input.url;
		const store = this.authStore.forServer(serverName, serverUrl);
		const settings = resolveOAuthSettings(rt.server, this.#env);
		const callback = await listenForLoopbackSignIn({ serverUrl, store, settings });
		const controller = new AbortController();

		try {
			const started = await startMcpSignIn({
				serverUrl,
				store,
				settings,
				redirectUrl: callback.redirectUrl,
				clientName: settings.clientName ?? this.#clientName,
				...(rt.challenge ? { challenge: rt.challenge } : {}),
				signal: controller.signal,
			});
			if (started.kind === "authorized") {
				await callback.callback.close().catch(() => {});
				rt.signedIn = true;
				rt.challenge = undefined;
				rt.reconnectAttempt = 0;
				await this.#disconnectRuntime(rt);
				this.#startConnect(rt);
				this.#notifyChange();
				return { status: "authorized" };
			}
			const id = randomUUID();
			const timer = setTimeout(() => {
				void this.#expireSignIn(id);
			}, this.#signInTtlMs);
			const flow: ActiveSignIn = {
				id,
				server: serverName,
				serverUrl,
				redirectUrl: callback.redirectUrl,
				authorization: started,
				callback,
				controller,
				timer,
				status: "waiting",
				error: null,
				settled: false,
			};
			this.#signIns.set(id, flow);
			this.#notifyChange();

			// Wait for browser loopback redirect in the background; manual paste can settle it earlier.
			void callback.callback
				.waitForCallback(started.state, new URL(started.redirectUrl).pathname)
				.then(async (response) => {
					if (flow.settled) return;
					await this.#finishSignIn(flow, response);
				})
				.catch((error) => {
					if (flow.settled || this.#closed) return;
					flow.status = "failed";
					flow.error = errorMessage(error);
					clearTimeout(flow.timer);
					void flow.callback.callback.close().catch(() => {});
					this.#notifyChange();
				});

			return { status: "redirect", id, authorizationUrl: started.authorizationUrl };
		} catch (error) {
			await callback.callback.close().catch(() => {});
			throw error;
		}
	}

	async pasteSignIn(id: string, redirectUrl: string): Promise<McpSnapshot> {
		const flow = this.#signIns.get(id);
		if (!flow || flow.settled) {
			throw new Error("Sign-in flow not found or already completed");
		}
		const response = responseFromRedirectUrl(redirectUrl, flow.authorization);
		await this.#finishSignIn(flow, response);
		return this.snapshot();
	}

	async cancelSignIn(id: string): Promise<McpSnapshot> {
		const flow = this.#signIns.get(id);
		if (flow) {
			await this.#closeSignInFlow(flow);
			this.#signIns.delete(id);
			this.#notifyChange();
		}
		return this.snapshot();
	}

	async signOut(serverName: string): Promise<McpSnapshot> {
		const rt = this.#runtimes.get(serverName);
		if (!rt) throw new Error(`MCP server "${serverName}" not found`);
		if (rt.server.transport !== "http") {
			throw new Error(`MCP server "${serverName}" does not use OAuth`);
		}
		await this.#dropSignInsForServer(serverName);
		await this.authStore.remove(serverName, rt.server.input.url);
		rt.signedIn = false;
		rt.challenge = undefined;
		rt.tools = [];
		this.#clearReconnectTimer(rt);
		await this.#disconnectRuntime(rt);
		if (rt.server.enabled) {
			this.#startConnect(rt);
		} else {
			rt.status = "disabled";
			rt.error = null;
			this.#notifyChange();
		}
		return this.snapshot();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubConfig?.();
		this.#unsubConfig = null;
		this.configStore.close();

		const flows = [...this.#signIns.values()];
		this.#signIns.clear();
		await Promise.allSettled(flows.map((flow) => this.#closeSignInFlow(flow)));

		const runtimes = [...this.#runtimes.values()];
		this.#runtimes.clear();
		await Promise.allSettled(
			runtimes.map(async (rt) => {
				this.#clearReconnectTimer(rt);
				await this.#disconnectRuntime(rt);
			}),
		);
		await this.authStore.close();
		this.#listeners.clear();
		this.#toolListeners.clear();
	}

	async #finishSignIn(flow: ActiveSignIn, response: { code: string; state: string; iss?: string }): Promise<void> {
		if (flow.settled) return;
		flow.settled = true;
		clearTimeout(flow.timer);
		const rt = this.#runtimes.get(flow.server);
		try {
			const settings = rt ? resolveOAuthSettings(rt.server, this.#env) : {};
			const store = this.authStore.forServer(flow.server, flow.serverUrl);
			await completeMcpSignIn({
				serverUrl: flow.serverUrl,
				store,
				settings,
				redirectUrl: flow.redirectUrl,
				clientName: settings.clientName ?? this.#clientName,
				...(rt?.challenge ? { challenge: rt.challenge } : {}),
				authorization: flow.authorization,
				response,
				signal: flow.controller.signal,
			});
			this.#signIns.delete(flow.id);
			await flow.callback.callback.close().catch(() => {});
			if (rt && rt.server.enabled && !this.#closed) {
				rt.signedIn = true;
				rt.challenge = undefined;
				rt.reconnectAttempt = 0;
				await this.#disconnectRuntime(rt);
				this.#startConnect(rt);
			}
			this.#notifyChange();
		} catch (error) {
			flow.settled = false;
			flow.status = "failed";
			flow.error = errorMessage(error);
			await flow.callback.callback.close().catch(() => {});
			this.#notifyChange();
			throw error;
		}
	}

	async #expireSignIn(id: string): Promise<void> {
		const flow = this.#signIns.get(id);
		if (!flow || flow.settled) return;
		flow.status = "failed";
		flow.error = "Sign-in timed out";
		await this.#closeSignInFlow(flow);
		this.#notifyChange();
	}

	async #closeSignInFlow(flow: ActiveSignIn): Promise<void> {
		flow.settled = true;
		clearTimeout(flow.timer);
		flow.controller.abort();
		await flow.callback.callback.close().catch(() => {});
	}

	async #dropSignInsForServer(serverName: string): Promise<void> {
		for (const [id, flow] of [...this.#signIns.entries()]) {
			if (flow.server !== serverName) continue;
			await this.#closeSignInFlow(flow);
			this.#signIns.delete(id);
		}
	}

	#syncWithConfig(): Promise<void> {
		const next = this.#syncChain.catch(() => {}).then(() => this.#syncWithConfigSerial());
		this.#syncChain = next;
		return next;
	}

	async #syncWithConfigSerial(): Promise<void> {
		if (this.#closed) return;
		const desired = new Map(this.configStore.state.servers.map((server) => [server.name, server]));

		// Remove deleted servers.
		for (const [name, rt] of [...this.#runtimes.entries()]) {
			if (!desired.has(name)) {
				this.#runtimes.delete(name);
				this.#clearReconnectTimer(rt);
				await this.#dropSignInsForServer(name);
				await this.#disconnectRuntime(rt);
			}
		}

		// Add or update servers by config hash.
		for (const server of this.configStore.state.servers) {
			const hash = serverConfigHash(server);
			const oauthSupported = isOAuthSupported(server);
			const signedIn =
				oauthSupported && server.transport === "http"
					? await this.authStore.hasTokens(server.name, server.input.url)
					: false;
			const existing = this.#runtimes.get(server.name);
			if (!existing) {
				const rt: ServerRuntime = {
					server,
					configHash: hash,
					status: server.enabled ? "connecting" : "disabled",
					error: null,
					stderrTail: "",
					tools: [],
					instructions: undefined,
					client: null,
					authProvider: null,
					oauthSupported,
					signedIn,
					challenge: undefined,
					reconnectAttempt: 0,
					reconnectTimer: null,
					connectPromise: null,
					generation: 0,
				};
				this.#runtimes.set(server.name, rt);
				if (server.enabled) this.#startConnect(rt);
				continue;
			}
			existing.oauthSupported = oauthSupported;
			existing.signedIn = signedIn;
			if (existing.configHash === hash) {
				existing.server = server;
				continue;
			}
			existing.server = server;
			existing.configHash = hash;
			existing.reconnectAttempt = 0;
			this.#clearReconnectTimer(existing);
			await this.#disconnectRuntime(existing);
			existing.tools = [];
			existing.instructions = undefined;
			existing.stderrTail = "";
			existing.error = null;
			if (server.enabled) {
				this.#startConnect(existing);
			} else {
				existing.status = "disabled";
			}
		}

		this.#notifyChange();
	}

	#startConnect(rt: ServerRuntime): void {
		if (this.#closed || !rt.server.enabled) return;
		this.#clearReconnectTimer(rt);
		rt.generation += 1;
		const gen = rt.generation;
		rt.status = "connecting";
		rt.error = null;
		this.#notifyChange();

		const run = this.#connectOnce(rt, gen).finally(() => {
			if (rt.connectPromise === run) rt.connectPromise = null;
		});
		rt.connectPromise = run;
	}

	async #connectOnce(rt: ServerRuntime, gen: number): Promise<void> {
		const isCurrent = () => !this.#closed && this.#runtimes.get(rt.server.name) === rt && rt.generation === gen;
		let client: McpClient | null = null;
		let authProvider: McpAuthProvider | null = null;

		try {
			if (rt.server.transport === "http" && rt.oauthSupported) {
				const serverName = rt.server.name;
				const serverUrl = rt.server.input.url;
				const store = this.authStore.forServer(serverName, serverUrl);
				authProvider = createMcpAuthProvider({
					serverUrl,
					store,
					settings: () => resolveOAuthSettings(rt.server, this.#env),
					clientName: rt.server.input.oauth?.clientName ?? this.#clientName,
					onChallenge: (challenge) => {
						if (isCurrent()) rt.challenge = challenge;
					},
				});
			}

			const transport = this.#transportFactory(rt.server, {
				env: this.#env,
				baseCwd: this.#baseCwd,
				home: this.#home,
				...(authProvider ? { authProvider } : {}),
				onStderr: (chunk) => {
					if (!isCurrent()) return;
					rt.stderrTail = clipTailBytes(rt.stderrTail + chunk, MCP_LIMITS.maxStderrTailBytes);
					this.#notifyChange();
				},
			});

			client = new McpClient({
				name: this.#clientName,
				version: RUNNING_VERSION,
				requestTimeoutMs: (rt.server.input.timeout ?? MCP_LIMITS.defaultTimeoutSec) * 1000,
			});

			client.onError((error) => {
				if (!isCurrent()) return;
				if (rt.status === "connected") {
					rt.error = error.message;
					this.#notifyChange();
				}
			});

			client.onNotification("notifications/tools/list_changed", () => {
				if (!isCurrent() || !client) return;
				void this.#refreshTools(rt, client, gen);
			});

			client.onClose(() => {
				if (!isCurrent()) return;
				if (rt.client === client) {
					rt.client = null;
					if (rt.status === "connected") {
						rt.status = "disconnected";
						this.#scheduleReconnect(rt, gen);
						this.#notifyChange();
					}
				}
			});

			rt.client = client;
			rt.authProvider = authProvider;

			const init = await client.connect(transport);
			if (!isCurrent()) {
				await client.close().catch(() => {});
				return;
			}
			const tools = await client.listTools();
			if (!isCurrent()) {
				await client.close().catch(() => {});
				return;
			}
			rt.instructions = init.instructions;
			rt.tools = tools;
			rt.status = "connected";
			rt.error = null;
			rt.reconnectAttempt = 0;
			if (rt.oauthSupported && rt.server.transport === "http") {
				rt.signedIn = await this.authStore.hasTokens(rt.server.name, rt.server.input.url);
			}
			this.#notifyChange();
		} catch (error) {
			if (client) await client.close().catch(() => {});
			if (authProvider) await authProvider.settled().catch(() => {});
			if (!isCurrent()) return;
			if (rt.client === client) rt.client = null;
			if (rt.authProvider === authProvider) rt.authProvider = null;

			if (rt.oauthSupported && isAuthError(error)) {
				rt.status = "auth_required";
				rt.error = errorMessage(error);
				rt.signedIn = false;
				this.#notifyChange();
				return;
			}
			rt.status = "error";
			rt.error = errorMessage(error);
			this.#scheduleReconnect(rt, gen);
			this.#notifyChange();
		}
	}

	async #refreshTools(rt: ServerRuntime, client: McpClient, gen: number): Promise<void> {
		try {
			const tools = await client.listTools();
			if (this.#closed || rt.generation !== gen || rt.client !== client) return;
			rt.tools = tools;
			this.#notifyChange();
		} catch (error) {
			if (this.#closed || rt.generation !== gen) return;
			rt.error = errorMessage(error);
			this.#notifyChange();
		}
	}

	#scheduleReconnect(rt: ServerRuntime, gen: number): void {
		if (this.#closed || !rt.server.enabled || rt.generation !== gen) return;
		this.#clearReconnectTimer(rt);
		const delay = Math.min(this.#reconnectBaseMs * 2 ** rt.reconnectAttempt, this.#reconnectMaxMs);
		rt.reconnectAttempt += 1;
		rt.reconnectTimer = setTimeout(() => {
			rt.reconnectTimer = null;
			if (this.#closed || !rt.server.enabled || this.#runtimes.get(rt.server.name) !== rt) return;
			this.#startConnect(rt);
		}, delay);
	}

	#clearReconnectTimer(rt: ServerRuntime): void {
		if (rt.reconnectTimer) {
			clearTimeout(rt.reconnectTimer);
			rt.reconnectTimer = null;
		}
	}

	async #disconnectRuntime(rt: ServerRuntime): Promise<void> {
		rt.generation += 1;
		const client = rt.client;
		const authProvider = rt.authProvider;
		rt.client = null;
		rt.authProvider = null;
		if (client) await client.close().catch(() => {});
		if (authProvider) await authProvider.settled().catch(() => {});
	}

	async #waitForConnect(rt: ServerRuntime, signal?: AbortSignal): Promise<void> {
		const promise = rt.connectPromise;
		if (!promise) return;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (err?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (err !== undefined) reject(err);
				else resolve();
			};
			const onAbort = () => finish(signal?.reason ?? new Error("Aborted"));
			const timer = setTimeout(() => finish(), this.#connectWaitMs);
			signal?.addEventListener("abort", onAbort, { once: true });
			void promise.then(
				() => finish(),
				() => finish(),
			);
		});
	}

	/**
	 * Compute deterministic registered tool names across all enabled servers.
	 * Any tool whose sanitized plain name collides with another tool gets Pi's 8-char hash suffix.
	 */
	#computeRegisteredNames(enabled: readonly ServerRuntime[]): Map<string, string> {
		const groups = new Map<string, Array<{ server: string; tool: string }>>();
		for (const rt of enabled) {
			for (const tool of rt.tools) {
				const plain = createMcpToolName(rt.server.name, tool.name);
				const list = groups.get(plain) ?? [];
				list.push({ server: rt.server.name, tool: tool.name });
				groups.set(plain, list);
			}
		}
		const out = new Map<string, string>();
		for (const [plain, entries] of groups) {
			const clash = entries.length > 1;
			for (const entry of entries) {
				const registered = clash ? createMcpToolName(entry.server, entry.tool, () => true) : plain;
				out.set(`${entry.server}\0${entry.tool}`, registered);
			}
		}
		return out;
	}

	#rebuildToolIndex(): boolean {
		const offered = this.offeredServers();
		const nextReadOnly = new Map<string, boolean>();
		const nextNames = new Map<string, string>();
		const signature = offered.map((srv) => ({
			name: srv.name,
			exposure: srv.exposure,
			oauthSupported: srv.oauthSupported,
			summary: srv.summary,
			instructions: srv.instructions ?? null,
			tools: srv.tools.map((t) => {
				nextReadOnly.set(t.registeredName, t.readOnly);
				nextNames.set(`${srv.name}\0${t.tool.name}`, t.registeredName);
				return {
					name: t.registeredName,
					description: t.tool.description ?? null,
					title: t.tool.title ?? t.tool.annotations?.title ?? null,
					readOnly: t.readOnly,
					inputSchema: t.tool.inputSchema,
					outputSchema: t.tool.outputSchema ?? null,
				};
			}),
		}));
		this.#registeredReadOnly = nextReadOnly;
		this.#registeredNameByTool = nextNames;
		const key = JSON.stringify(signature);
		if (key === this.#lastToolKey) return false;
		this.#lastToolKey = key;
		return true;
	}

	/** Exposed for tests inspecting computed tool registration names. */
	registeredNameOf(server: string, toolName: string): string | undefined {
		return this.#registeredNameByTool.get(`${server}\0${toolName}`);
	}

	#notifyChange(): void {
		const toolsChanged = this.#rebuildToolIndex();
		this.#revision += 1;
		const snap = this.snapshot();
		for (const listener of this.#listeners) listener(snap);
		if (toolsChanged) {
			for (const listener of this.#toolListeners) listener();
		}
	}
}
