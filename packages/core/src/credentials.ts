import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { type RenameWithRetryDeps, renameWithRetry } from "./rename-with-retry.ts";

const STALE_LOCK_MS = 30_000;

export {
	CREDENTIAL_PROVIDERS,
	type CredentialProviderId,
	type CredentialProviderSpec,
	credentialProvider,
	DEFAULT_ENABLED_PROVIDERS,
	isCredentialProvider,
	isModelProvider,
	LOCKED_PROVIDERS,
	MODEL_PROVIDERS,
	type ModelProviderId,
	normalizeEnabledProviders,
	SEARCH_CREDENTIAL_PROVIDERS,
} from "./credential-providers.ts";

export type CredentialStatus = {
	savedConfigured: boolean;
	environmentConfigured: boolean;
	source: "saved" | "environment" | "runtime" | "keyless" | "none";
};
export const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".neko", "credentials.json");

/** Atomic file replacement plus an exclusive lock shared by all processes. */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	readonly #renameDeps: RenameWithRetryDeps;
	constructor(path = DEFAULT_CREDENTIALS_PATH, renameDeps: RenameWithRetryDeps = {}) {
		this.path = path;
		this.#renameDeps = renameDeps;
	}
	async #read(): Promise<Record<string, Credential>> {
		try {
			const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
			for (const item of Object.values(data)) {
				if (!item || typeof item !== "object" || !["api_key", "oauth"].includes(item.type)) throw new Error();
			}
			await chmod(this.path, 0o600);
			return data as Record<string, Credential>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new Error("Cannot read credential storage.");
		}
	}
	async read(id: string) {
		const data = await this.#read();
		return Object.hasOwn(data, id) ? data[id] : undefined;
	}
	async list() {
		return Object.entries(await this.#read()).map(([providerId, value]) => ({ providerId, type: value.type }));
	}
	async #write<T>(operation: (data: Record<string, Credential>) => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const lockPath = `${this.path}.lock`;
		let lock: Awaited<ReturnType<typeof open>>;
		let reclaimed = false;
		for (let attempt = 0; ; attempt++) {
			try {
				lock = await open(lockPath, "wx", 0o600);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100)
					throw new Error("Credential storage is busy or unavailable.");
				// A holder that died mid-write leaves the lock behind; a live write finishes in milliseconds.
				if (!reclaimed) {
					const info = await stat(lockPath).catch(() => undefined);
					if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
						reclaimed = true;
						await unlink(lockPath).catch(() => {});
						continue;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
		let callbackFailed = false;
		try {
			const data = await this.#read();
			let result: T;
			try {
				result = await operation(data);
			} catch (error) {
				callbackFailed = true;
				throw error;
			}
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(JSON.stringify(data));
				await file.sync();
			} finally {
				await file.close();
			}
			await renameWithRetry(temporary, this.path, this.#renameDeps);
			return result;
		} catch (error) {
			if (callbackFailed) throw error;
			throw new Error("Cannot update credential storage.");
		} finally {
			await unlink(temporary).catch(() => {});
			await lock.close();
			await unlink(lockPath);
		}
	}
	modify(id: string, fn: (value: Credential | undefined) => Promise<Credential | undefined>) {
		return this.#write(async (data) => {
			const next = await fn(Object.hasOwn(data, id) ? data[id] : undefined);
			if (next !== undefined)
				Object.defineProperty(data, id, { value: next, enumerable: true, configurable: true, writable: true });
			return Object.hasOwn(data, id) ? data[id] : undefined;
		});
	}
	delete(id: string) {
		return this.#write(async (data) => {
			delete data[id];
		});
	}
}

export { InMemoryCredentialStore } from "@earendil-works/pi-ai";
