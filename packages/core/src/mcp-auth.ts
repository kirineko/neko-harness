import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mcpNamespace } from "@earendil-works/pi-mcp";
import type { McpOAuthServerStore, McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import { type RenameWithRetryDeps, renameWithRetry } from "./rename-with-retry.ts";

export const DEFAULT_MCP_AUTH_PATH = join(homedir(), ".neko", "mcp-auth.json");

const STALE_LOCK_MS = 30_000;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 25;

type States = Record<string, McpOAuthState>;

export type McpAuthLockOptions = {
	lockAttempts?: number;
	lockRetryMs?: number;
};

/** Keyed by sanitized server namespace and normalized URL, matching Pi's account isolation. */
export function mcpAuthKey(name: string, url: string): string {
	return `${mcpNamespace(name)}|${new URL(url).href}`;
}

function parseStates(text: string | null): States {
	if (!text) return {};
	const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	if (!clean.trim()) return {};
	try {
		const value: unknown = JSON.parse(clean);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as States) : {};
	} catch {
		return {};
	}
}

/**
 * Private (0600) durable store for MCP OAuth 2.1 client registrations, tokens and pending PKCE state.
 * Tokens stay strictly on the gateway host and are never exposed in client snapshots.
 */
export class McpAuthStore {
	readonly path: string;
	readonly #renameDeps: RenameWithRetryDeps;
	readonly #lockAttempts: number;
	readonly #lockRetryMs: number;
	readonly #refreshing = new Map<string, Promise<unknown>>();
	#pendingWrite: Promise<unknown> = Promise.resolve();

	constructor(
		path: string = DEFAULT_MCP_AUTH_PATH,
		options: { renameDeps?: RenameWithRetryDeps; lock?: McpAuthLockOptions } = {},
	) {
		this.path = path;
		this.#renameDeps = options.renameDeps ?? {};
		this.#lockAttempts = options.lock?.lockAttempts ?? LOCK_ATTEMPTS;
		this.#lockRetryMs = options.lock?.lockRetryMs ?? LOCK_RETRY_MS;
	}

	forServer(name: string, url: string): McpOAuthServerStore {
		const key = mcpAuthKey(name, url);
		return {
			load: async () => {
				const states = await this.#readAll();
				return states[key];
			},
			save: async (state) => {
				await this.#enqueueWrite(async (states) => {
					states[key] = state;
					return true;
				});
			},
			withRefreshLock: (fn) => this.#withRefreshLock(key, fn),
		};
	}

	async hasTokens(name: string, url: string): Promise<boolean> {
		const states = await this.#readAll();
		return states[mcpAuthKey(name, url)]?.tokens !== undefined;
	}

	async remove(name: string, url: string): Promise<void> {
		const key = mcpAuthKey(name, url);
		await this.#enqueueWrite(async (states) => {
			if (!Object.hasOwn(states, key)) return false;
			delete states[key];
			return true;
		});
	}

	async close(): Promise<void> {
		await this.#pendingWrite.catch(() => {});
		await Promise.allSettled([...this.#refreshing.values()]);
	}

	async #withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.#refreshing.get(key) ?? Promise.resolve();
		const run = previous.catch(() => {}).then(fn);
		this.#refreshing.set(key, run);
		try {
			return await run;
		} finally {
			if (this.#refreshing.get(key) === run) this.#refreshing.delete(key);
		}
	}

	async #readAll(): Promise<States> {
		await this.#pendingWrite.catch(() => {});
		try {
			const text = await readFile(this.path, "utf8");
			await chmod(this.path, 0o600).catch(() => {});
			return parseStates(text);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error("Cannot read MCP OAuth credential storage.");
		}
	}

	#enqueueWrite(mutate: (states: States) => Promise<boolean>): Promise<void> {
		const next = this.#pendingWrite.catch(() => {}).then(() => this.#writeLocked(mutate));
		this.#pendingWrite = next;
		return next;
	}

	async #writeLocked(mutate: (states: States) => Promise<boolean>): Promise<void> {
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
					throw new Error("MCP OAuth credential storage is busy or unavailable.");
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
			const states = parseStates(currentText);
			const changed = await mutate(states);
			if (!changed) return;
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(`${JSON.stringify(states, null, 2)}\n`, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			await renameWithRetry(temporary, this.path, this.#renameDeps);
			await chmod(this.path, 0o600).catch(() => {});
		} finally {
			await unlink(temporary).catch(() => {});
			await lock.close();
			await unlink(lockPath).catch(() => {});
		}
	}
}
