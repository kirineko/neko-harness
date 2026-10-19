import { rename } from "node:fs/promises";

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
const FIRST_DELAY_MS = 10;
const MAX_TOTAL_MS = 1000;

export type RenameWithRetryDeps = {
	rename?: (from: string, to: string) => Promise<void>;
	sleep?: (ms: number) => Promise<void>;
};

/**
 * Windows rejects replacing a file that another process (antivirus, indexer, a reader) briefly holds open.
 * Only those transient codes are retried, with growing delays up to about one second in total.
 */
export async function renameWithRetry(from: string, to: string, deps: RenameWithRetryDeps = {}): Promise<void> {
	const doRename = deps.rename ?? rename;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let delay = FIRST_DELAY_MS;
	let waited = 0;
	for (;;) {
		try {
			await doRename(from, to);
			return;
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (typeof code !== "string" || !TRANSIENT.has(code) || waited >= MAX_TOTAL_MS) throw error;
			const step = Math.min(delay, MAX_TOTAL_MS - waited);
			await sleep(step);
			waited += step;
			delay *= 2;
		}
	}
}
