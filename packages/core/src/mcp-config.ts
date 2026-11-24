import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	type McpHttpServerConfig,
	type McpOAuthConfig,
	type McpStdioServerConfig,
	mcpNamespace,
	validateMcpServerConfig,
} from "@earendil-works/pi-mcp";
import {
	isMcpExposure,
	isMcpServerName,
	MCP_LIMITS,
	type McpExposure,
	type McpHttpConfigInput,
	type McpOAuthSettingsInput,
	type McpServerConfigInput,
	type McpStdioConfigInput,
} from "./mcp-types.ts";
import { type RenameWithRetryDeps, renameWithRetry } from "./rename-with-retry.ts";

export const DEFAULT_MCP_CONFIG_PATH = join(homedir(), ".neko", "mcp.json");

const STALE_LOCK_MS = 30_000;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 25;

export type McpConfigLockOptions = {
	lockAttempts?: number;
	lockRetryMs?: number;
};

export type ParsedMcpServer =
	| {
			readonly name: string;
			readonly transport: "stdio";
			readonly enabled: boolean;
			readonly exposure: McpExposure;
			readonly rawConfig: McpStdioServerConfig;
			readonly input: McpStdioConfigInput;
	  }
	| {
			readonly name: string;
			readonly transport: "http";
			readonly enabled: boolean;
			readonly exposure: McpExposure;
			readonly rawConfig: McpHttpServerConfig;
			readonly input: McpHttpConfigInput;
	  };

export type ParsedMcpConfig = {
	readonly servers: readonly ParsedMcpServer[];
	readonly entryErrors: readonly string[];
};

export type McpConfigState = ParsedMcpConfig & {
	readonly configPath: string;
	readonly configError: string | null;
	readonly rawJson: string;
};

const ENV_TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Expand `${NAME}` references from `env`; throws naming the missing variable. */
export function expandEnvTemplate(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(ENV_TEMPLATE, (_match, name: string) => {
		const resolved = env[name];
		if (resolved === undefined) throw new Error(`Environment variable ${name} is not set`);
		return resolved;
	});
}

/** Expand `${NAME}` references across every value in a string map. */
export function expandRecordTemplates(
	record: Readonly<Record<string, string>> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		out[key] = expandEnvTemplate(value, env);
	}
	return out;
}

/** Expand leading `~/` and resolve relative paths against `baseDir`. */
export function resolveMcpCwd(cwd: string | undefined, baseDir: string, home: string = homedir()): string {
	if (!cwd || !cwd.trim()) return baseDir;
	const trimmed = cwd.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return resolve(home, trimmed.slice(2));
	}
	return isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed);
}

/** Expand leading `~/` in a stdio command or arg when present. */
export function expandHomePrefix(value: string, home: string = homedir()): string {
	if (value === "~") return home;
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(home, value.slice(2));
	return value;
}

function cleanOAuthSettings(oauth: McpOAuthConfig | undefined): McpOAuthSettingsInput | undefined {
	if (!oauth) return undefined;
	const out: {
		clientId?: string;
		clientSecret?: string;
		callbackPort?: number;
		callbackUrl?: string;
		scope?: string;
		clientName?: string;
		clientRegistration?: "auto" | "dcr";
		authServerMetadataUrl?: string;
	} = {};
	if (oauth.clientId !== undefined) out.clientId = oauth.clientId;
	if (oauth.clientSecret !== undefined) out.clientSecret = oauth.clientSecret;
	if (oauth.callbackPort !== undefined) out.callbackPort = oauth.callbackPort;
	if (oauth.callbackUrl !== undefined) out.callbackUrl = oauth.callbackUrl;
	if (oauth.scope !== undefined) out.scope = oauth.scope;
	if (oauth.clientName !== undefined) out.clientName = oauth.clientName;
	if (oauth.clientRegistration === "auto" || oauth.clientRegistration === "dcr") {
		out.clientRegistration = oauth.clientRegistration;
	}
	if (oauth.authServerMetadataUrl !== undefined) out.authServerMetadataUrl = oauth.authServerMetadataUrl;
	return Object.keys(out).length > 0 ? out : undefined;
}

function parseEntry(
	name: string,
	raw: unknown,
): { kind: "ok"; server: ParsedMcpServer } | { kind: "error"; error: string } {
	const result = validateMcpServerConfig(name, raw);
	if (result.kind === "invalid") return { kind: "error", error: result.error };
	const rawExposure = result.config.exposure;
	if (rawExposure !== undefined && !isMcpExposure(rawExposure)) {
		return { kind: "error", error: `server "${name}": exposure must be "auto" or "direct"` };
	}
	const exposure: McpExposure = rawExposure ?? "auto";
	const enabled = result.config.enabled !== false;
	const base = {
		...(result.config.enabled !== undefined ? { enabled: result.config.enabled } : {}),
		...(result.config.description !== undefined ? { description: result.config.description } : {}),
		...(result.config.timeout !== undefined ? { timeout: result.config.timeout } : {}),
		...(rawExposure !== undefined ? { exposure } : {}),
	};
	if (result.kind === "stdio") {
		const input: McpStdioConfigInput = {
			transport: "stdio",
			command: result.config.command,
			...(result.config.args !== undefined ? { args: [...result.config.args] } : {}),
			...(result.config.env !== undefined ? { env: { ...result.config.env } } : {}),
			...(result.config.cwd !== undefined ? { cwd: result.config.cwd } : {}),
			...base,
		};
		return {
			kind: "ok",
			server: { name, transport: "stdio", enabled, exposure, rawConfig: result.config, input },
		};
	}
	const oauth = cleanOAuthSettings(result.config.oauth);
	const input: McpHttpConfigInput = {
		transport: "http",
		url: result.config.url,
		...(result.config.headers !== undefined ? { headers: { ...result.config.headers } } : {}),
		...(oauth !== undefined ? { oauth } : {}),
		...base,
	};
	return {
		kind: "ok",
		server: { name, transport: "http", enabled, exposure, rawConfig: result.config, input },
	};
}

/**
 * Parse the top-level JSON object of `mcp.json`. Throws if JSON syntax is invalid or top-level / `mcpServers`
 * is not an object. Individual invalid entries are skipped and reported in `entryErrors`.
 */
export function parseMcpConfigText(text: string): {
	parsed: ParsedMcpConfig;
	root: Record<string, unknown>;
} {
	if (Buffer.byteLength(text, "utf8") > MCP_LIMITS.maxConfigBytes) {
		throw new Error(`mcp.json exceeds ${MCP_LIMITS.maxConfigBytes} bytes`);
	}
	const trimmed = stripBom(text).trim();
	if (trimmed === "") {
		return { parsed: { servers: [], entryErrors: [] }, root: { mcpServers: {} } };
	}
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(`Invalid mcp.json syntax: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) {
		throw new Error("mcp.json must contain a JSON object");
	}
	const rawServers = value.mcpServers ?? {};
	if (!isRecord(rawServers)) {
		throw new Error('mcp.json: "mcpServers" must be an object');
	}
	const servers: ParsedMcpServer[] = [];
	const entryErrors: string[] = [];
	const seenNamespaces = new Map<string, string>();
	for (const [name, raw] of Object.entries(rawServers)) {
		const entry = parseEntry(name, raw);
		if (entry.kind === "error") {
			entryErrors.push(entry.error);
			continue;
		}
		const ns = mcpNamespace(name);
		const existing = seenNamespaces.get(ns);
		if (existing !== undefined) {
			entryErrors.push(`server "${name}": namespace conflicts with "${existing}" (${ns})`);
			continue;
		}
		seenNamespaces.set(ns, name);
		servers.push(entry.server);
	}
	return { parsed: { servers, entryErrors }, root: value };
}

/** Serialize one `McpServerConfigInput` to a standard `mcpServers` JSON entry. */
export function serializeServerInput(name: string, input: McpServerConfigInput): Record<string, unknown> {
	if (!isMcpServerName(name)) {
		throw new Error(`invalid server name "${name}" (use letters, digits, "_" and "-")`);
	}
	const entry: Record<string, unknown> = {};
	if (input.transport === "stdio") {
		entry.command = input.command;
		if (input.args && input.args.length > 0) entry.args = [...input.args];
		if (input.env && Object.keys(input.env).length > 0) entry.env = { ...input.env };
		if (input.cwd !== undefined && input.cwd.trim() !== "") entry.cwd = input.cwd;
	} else {
		entry.url = input.url;
		if (input.headers && Object.keys(input.headers).length > 0) entry.headers = { ...input.headers };
		if (input.oauth) {
			const oauth = cleanOAuthSettings(input.oauth);
			if (oauth) entry.oauth = oauth;
		}
	}
	if (input.description !== undefined && input.description.trim() !== "") entry.description = input.description;
	if (input.enabled === false) entry.enabled = false;
	if (input.timeout !== undefined) entry.timeout = input.timeout;
	if (input.exposure !== undefined && input.exposure !== "auto") entry.exposure = input.exposure;
	const checked = parseEntry(name, entry);
	if (checked.kind === "error") throw new Error(checked.error);
	return entry;
}

/** Compute a stable hash of the connection-relevant fields of a server config. */
export function serverConfigHash(server: ParsedMcpServer): string {
	return createHash("sha256").update(JSON.stringify(server.input)).digest("hex").slice(0, 16);
}

function contentDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function defaultRawJson(): string {
	return `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
}

/**
 * Single source of truth for `~/.neko/mcp.json`: atomic locked writes, self-write suppression,
 * debounced directory watching, and last-valid fallback on malformed external edits.
 */
export class McpConfigStore {
	readonly path: string;
	readonly #renameDeps: RenameWithRetryDeps;
	readonly #lockAttempts: number;
	readonly #lockRetryMs: number;
	readonly #debounceMs: number;

	#state: McpConfigState;
	#lastAppliedDigest: string | null = null;
	#watcher: FSWatcher | null = null;
	#debounceTimer: ReturnType<typeof setTimeout> | null = null;
	#closed = false;
	readonly #listeners = new Set<(state: McpConfigState) => void>();

	constructor(
		path: string = DEFAULT_MCP_CONFIG_PATH,
		options: {
			renameDeps?: RenameWithRetryDeps;
			lock?: McpConfigLockOptions;
			debounceMs?: number;
		} = {},
	) {
		this.path = path;
		this.#renameDeps = options.renameDeps ?? {};
		this.#lockAttempts = options.lock?.lockAttempts ?? LOCK_ATTEMPTS;
		this.#lockRetryMs = options.lock?.lockRetryMs ?? LOCK_RETRY_MS;
		this.#debounceMs = options.debounceMs ?? MCP_LIMITS.watchDebounceMs;
		this.#state = {
			configPath: path,
			servers: [],
			entryErrors: [],
			configError: null,
			rawJson: defaultRawJson(),
		};
	}

	get state(): McpConfigState {
		return this.#state;
	}

	subscribe(listener: (state: McpConfigState) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Read and parse `mcp.json` from disk without creating it when absent. */
	async reload(): Promise<McpConfigState> {
		let text: string | null;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				text = null;
			} else {
				const message = `Cannot read mcp.json: ${error instanceof Error ? error.message : String(error)}`;
				this.#state = { ...this.#state, configError: message };
				this.#emit();
				return this.#state;
			}
		}
		if (text === null) {
			this.#lastAppliedDigest = null;
			this.#state = {
				configPath: this.path,
				servers: [],
				entryErrors: [],
				configError: null,
				rawJson: defaultRawJson(),
			};
			this.#emit();
			return this.#state;
		}
		this.#lastAppliedDigest = contentDigest(text);
		try {
			const { parsed } = parseMcpConfigText(text);
			this.#state = {
				configPath: this.path,
				servers: parsed.servers,
				entryErrors: parsed.entryErrors,
				configError: null,
				rawJson: text,
			};
		} catch (error) {
			// Keep the last valid server set so an accidental syntax error does not drop active connections.
			this.#state = {
				...this.#state,
				configError: error instanceof Error ? error.message : String(error),
				rawJson: text,
			};
		}
		this.#emit();
		return this.#state;
	}

	/** Start watching the directory containing `mcp.json` for external edits. */
	startWatching(): void {
		if (this.#closed || this.#watcher) return;
		this.#tryAttachWatcher();
	}

	#tryAttachWatcher(): void {
		if (this.#closed || this.#watcher) return;
		const dir = dirname(this.path);
		const targetName = basename(this.path);
		try {
			const watcher = watch(dir, (_eventType, filename) => {
				if (this.#closed) return;
				if (filename && filename.toString() !== targetName) return;
				this.#scheduleReload();
			});
			watcher.on("error", () => {
				watcher.close();
				if (this.#watcher === watcher) this.#watcher = null;
			});
			this.#watcher = watcher;
		} catch {
			// Directory may not exist yet (e.g. ~/.neko before first save); will attach after first write.
		}
	}

	#scheduleReload(): void {
		if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
		this.#debounceTimer = setTimeout(() => {
			this.#debounceTimer = null;
			void this.#handleExternalChange();
		}, this.#debounceMs);
	}

	async #handleExternalChange(): Promise<void> {
		if (this.#closed) return;
		let text: string | null = null;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				await this.reload();
				return;
			}
		}
		const digest = text === null ? null : contentDigest(text);
		if (digest === this.#lastAppliedDigest) return;
		await this.reload();
	}

	async upsertServer(name: string, input: McpServerConfigInput): Promise<McpConfigState> {
		const serialized = serializeServerInput(name, input);
		return this.#mutate((root, servers) => {
			const targetNs = mcpNamespace(name);
			for (const existingName of Object.keys(servers)) {
				if (existingName !== name && mcpNamespace(existingName) === targetNs) {
					throw new Error(`server "${name}": namespace conflicts with "${existingName}" (${targetNs})`);
				}
			}
			servers[name] = serialized;
			root.mcpServers = servers;
		});
	}

	async removeServer(name: string): Promise<McpConfigState> {
		return this.#mutate((root, servers) => {
			if (!Object.hasOwn(servers, name)) {
				throw new Error(`MCP server "${name}" not found`);
			}
			delete servers[name];
			root.mcpServers = servers;
		});
	}

	async setEnabled(name: string, enabled: boolean): Promise<McpConfigState> {
		return this.#mutate((root, servers) => {
			const existing = servers[name];
			if (!isRecord(existing)) {
				throw new Error(`MCP server "${name}" not found`);
			}
			const next = { ...existing };
			if (enabled) delete next.enabled;
			else next.enabled = false;
			const checked = parseEntry(name, next);
			if (checked.kind === "error") throw new Error(checked.error);
			servers[name] = next;
			root.mcpServers = servers;
		});
	}

	/** Validate and atomically replace `mcp.json` with raw JSON text (rejects any syntax or entry error). */
	async saveRawJson(rawText: string): Promise<McpConfigState> {
		const { parsed } = parseMcpConfigText(rawText);
		if (parsed.entryErrors.length > 0) {
			throw new Error(parsed.entryErrors.join("; "));
		}
		const normalized = rawText.endsWith("\n") ? rawText : `${rawText}\n`;
		await this.#writeAtomic(async () => normalized);
		this.#state = {
			configPath: this.path,
			servers: parsed.servers,
			entryErrors: [],
			configError: null,
			rawJson: normalized,
		};
		this.#tryAttachWatcher();
		this.#emit();
		return this.#state;
	}

	async #mutate(
		edit: (root: Record<string, unknown>, servers: Record<string, unknown>) => void,
	): Promise<McpConfigState> {
		let nextParsed: ParsedMcpConfig | undefined;
		const writtenText = await this.#writeAtomic(async (currentText) => {
			const { root } = parseMcpConfigText(currentText ?? "");
			const existingServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};
			const nextRoot = { ...root };
			edit(nextRoot, existingServers);
			const nextText = `${JSON.stringify(nextRoot, null, 2)}\n`;
			const checked = parseMcpConfigText(nextText);
			nextParsed = checked.parsed;
			return nextText;
		});
		if (nextParsed) {
			this.#state = {
				configPath: this.path,
				servers: nextParsed.servers,
				entryErrors: nextParsed.entryErrors,
				configError: null,
				rawJson: writtenText,
			};
			this.#tryAttachWatcher();
			this.#emit();
		}
		return this.#state;
	}

	async #writeAtomic(buildNext: (currentText: string | null) => Promise<string>): Promise<string> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const lockPath = `${this.path}.lock`;
		let lock: Awaited<ReturnType<typeof open>>;
		let reclaimed = false;
		for (let attempt = 0; ; attempt++) {
			try {
				lock = await open(lockPath, "wx", 0o600);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= this.#lockAttempts) {
					throw new Error("MCP config file is busy or unavailable.");
				}
				if (!reclaimed) {
					const info = await stat(lockPath).catch(() => undefined);
					if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
						reclaimed = true;
						await unlink(lockPath).catch(() => {});
						continue;
					}
				}
				await new Promise((r) => setTimeout(r, this.#lockRetryMs));
			}
		}
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			let currentText: string | null = null;
			try {
				currentText = await readFile(this.path, "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const nextText = await buildNext(currentText);
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(nextText, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			this.#lastAppliedDigest = contentDigest(nextText);
			await renameWithRetry(temporary, this.path, this.#renameDeps);
			return nextText;
		} finally {
			await unlink(temporary).catch(() => {});
			await lock.close();
			await unlink(lockPath).catch(() => {});
		}
	}

	#emit(): void {
		for (const listener of this.#listeners) listener(this.#state);
	}

	close(): void {
		this.#closed = true;
		if (this.#debounceTimer) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = null;
		}
		if (this.#watcher) {
			this.#watcher.close();
			this.#watcher = null;
		}
		this.#listeners.clear();
	}
}
