import { rmSync, symlinkSync } from "node:fs";
import { rm as remove } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);
const ATTEMPTS = 20;
// Dropping unreferenced SQLite handles is what frees the path on Windows; `gc` exists because vitest.config.ts passes --expose-gc.
const collectGarbage = () => (globalThis as { gc?: () => void }).gc?.();
const isRetryable = (error: unknown) => RETRYABLE.has((error as { code?: string }).code ?? "");

/** Drop-in `rm` for test cleanup. On Windows, SQLite handles and exiting children keep a path busy briefly. */
export async function rm(path: string, options?: Parameters<typeof remove>[1]): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await remove(path, options);
		} catch (error) {
			if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
			collectGarbage();
			await sleep(50);
		}
	}
}

export const removeDir = (path: string) => rm(path, { recursive: true, force: true });

/** Synchronous variant for `afterEach`. */
export function removeDirSync(path: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
			collectGarbage();
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
}

/** Windows without developer mode cannot create symlinks (EPERM); returns false there so callers can skip the link checks. */
export function trySymlink(target: string, path: string): boolean {
	try {
		symlinkSync(target, path);
		return true;
	} catch (error) {
		if (process.platform === "win32" && (error as { code?: string }).code === "EPERM") return false;
		throw error;
	}
}
