import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_PROTOCOL, RUNNING_VERSION, stableVersion, type UpdateState } from "./application-version.ts";
import { renameWithRetry } from "./rename-with-retry.ts";

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let abort = () => {};
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				abort = () => reject(signal.reason);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export const INSTALL_MANIFEST = stableVersion(RUNNING_VERSION)
	? fileURLToPath(new URL("../package.json", import.meta.url))
	: undefined;
export async function installedVersion(manifest = INSTALL_MANIFEST): Promise<string | null> {
	if (!manifest) return null;
	try {
		const value = JSON.parse(await readFile(manifest, "utf8"));
		return value.name === "neko-harness" && stableVersion(value.version) ? value.version : null;
	} catch {
		return null;
	}
}
export type UpdateCheckerOptions = {
	runningVersion?: string;
	protocolVersion?: number;
	manifest?: string;
	cachePath?: string;
	fetch?: (url: string, options?: RequestInit) => Promise<Response>;
	now?: () => number;
	timeoutMs?: number;
};
/** Host only. Local install polling is independent of the daily registry cache. */
export class UpdateChecker {
	readonly #options: UpdateCheckerOptions;
	readonly #controller = new AbortController();
	#work?: Promise<UpdateState>;
	#loaded = false;
	#closed = false;
	#retryAt = 0;
	state: UpdateState;
	constructor(options: UpdateCheckerOptions = {}) {
		this.#options = options;
		const runningVersion = options.runningVersion ?? RUNNING_VERSION;
		this.state = {
			runningVersion,
			installedVersion: null,
			protocolVersion: options.protocolVersion ?? APPLICATION_PROTOCOL,
			latestVersion: null,
			checkedAt: null,
			checkState: stableVersion(runningVersion) ? "unknown" : "development",
		};
	}
	async local(): Promise<UpdateState> {
		this.state = { ...this.state, installedVersion: await installedVersion(this.#options.manifest) };
		return this.state;
	}
	async check(force = false): Promise<UpdateState> {
		if (this.#closed) return this.state;
		if (this.#work) return this.#work;
		this.#work = this.#check(force).finally(() => {
			this.#work = undefined;
		});
		return this.#work;
	}
	get #cachePath() {
		return this.#options.cachePath ?? join(homedir(), ".neko", "update-check.json");
	}
	async #check(force: boolean): Promise<UpdateState> {
		await this.local();
		if (!stableVersion(this.state.runningVersion)) return this.state;
		const now = (this.#options.now ?? Date.now)();
		if (!this.#loaded) {
			this.#loaded = true;
			try {
				const cache = JSON.parse(await readFile(this.#cachePath, "utf8"));
				if (
					stableVersion(cache.latestVersion) &&
					Number.isSafeInteger(cache.checkedAt) &&
					cache.checkedAt <= now &&
					cache.checkedAt >= 0
				) {
					this.state = {
						...this.state,
						latestVersion: cache.latestVersion,
						checkedAt: cache.checkedAt,
						checkState: "ok",
					};
				}
			} catch {}
		}
		if (
			!force &&
			((this.state.checkState === "ok" && this.state.checkedAt !== null && now - this.state.checkedAt < 86400000) ||
				now < this.#retryAt)
		)
			return this.state;
		this.state = { ...this.state, checkState: "checking" };
		const signal = AbortSignal.any([this.#controller.signal, AbortSignal.timeout(this.#options.timeoutMs ?? 5000)]);
		try {
			const response = await abortable(
				(this.#options.fetch ?? fetch)("https://registry.npmjs.org/neko-harness/latest", {
					signal,
					headers: { accept: "application/json" },
				}),
				signal,
			);
			if (!response.ok || !response.body) throw new Error("Registry unavailable");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const next = await abortable(reader.read(), signal);
					if (next.done) break;
					size += next.value.byteLength;
					if (size > 262144) throw new Error("Registry response too large");
					chunks.push(next.value);
				}
			} finally {
				void reader.cancel().catch(() => {});
			}
			signal.throwIfAborted();
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			const value = JSON.parse(new TextDecoder().decode(bytes));
			if (value.name !== "neko-harness" || !stableVersion(value.version)) throw new Error("Invalid stable version");
			this.state = { ...this.state, latestVersion: value.version, checkedAt: now, checkState: "ok" };
			this.#retryAt = 0;
			const temporary = `${this.#cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				await mkdir(dirname(this.#cachePath), { recursive: true });
				await writeFile(temporary, JSON.stringify({ latestVersion: value.version, checkedAt: now }), { mode: 0o600 });
				await renameWithRetry(temporary, this.#cachePath);
			} catch {
			} finally {
				await rm(temporary, { force: true }).catch(() => {});
			}
		} catch {
			this.#retryAt = now + 3600000;
			this.state = { ...this.state, checkState: "failed" };
		}
		return this.state;
	}
	close() {
		this.#closed = true;
		this.#controller.abort();
	}
}
