import { AsyncLocalStorage } from "node:async_hooks";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineDoc, type Extension, wrapTool } from "@earendil-works/pi-durable";
import { createCodemodeExtension, createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { CODEMODE_LIMITS, type CodemodeMode } from "./codemode-mode.ts";
import { nestedChangeWraps } from "./nested-changes.ts";

/** Saved global mode (root conversation). `null` = nothing saved, fall back to the configuration file. */
export const CodemodeSettingsDoc = defineDoc<{ mode: CodemodeMode | null }>({
	kind: "app.neko.codemode-settings",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ mode: null }),
});

/**
 * The mode a session was created with. Authoritative for the session's tool set; the agent configuration is a
 * projection of it. A missing document means `off`. Rewindable so a fork keeps the mode of its fork point.
 */
export const CodemodeDoc = defineDoc<{ mode: CodemodeMode }>({
	kind: "app.neko.codemode",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ mode: "off" }),
});

export const SANDBOX_BUSY = "Codemode sandbox is busy: too many scripts are running. Try again shortly.";

/**
 * Caps the scripts running at the same time in the process. A call first waits for a free slot (FIFO, abortable,
 * bounded); the slot then becomes a reservation that the sandbox's `acquireWorker` turns into a running worker, which
 * stays counted until the worker really exits (on Bun a worker can outlive its result).
 */
export class WorkerLimiter {
	readonly #max: number;
	readonly #waitMs: number;
	readonly #tickets = new AsyncLocalStorage<{ claimed: boolean }>();
	readonly #waiters: Array<() => void> = [];
	#running = 0;
	#reserved = 0;

	constructor(limits: { maxWorkers: number; waitMs: number } = CODEMODE_LIMITS) {
		this.#max = limits.maxWorkers;
		this.#waitMs = limits.waitMs;
	}

	get running(): number {
		return this.#running;
	}

	get waiting(): number {
		return this.#waiters.length;
	}

	#free(): boolean {
		return this.#running + this.#reserved < this.#max;
	}

	#wake(): void {
		while (this.#waiters.length > 0 && this.#free()) {
			this.#reserved += 1;
			this.#waiters.shift()?.();
		}
	}

	/** Passed to `CodemodeSandbox`: called synchronously before a worker is created. */
	readonly acquireWorker = (): (() => void) => {
		const ticket = this.#tickets.getStore();
		if (ticket && !ticket.claimed) {
			ticket.claimed = true;
			this.#reserved -= 1;
		} else if (!this.#free()) throw new Error(SANDBOX_BUSY);
		this.#running += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#running -= 1;
			this.#wake();
		};
	};

	async #admit(signal: AbortSignal | undefined): Promise<void> {
		signal?.throwIfAborted();
		if (this.#waiters.length === 0 && this.#free()) {
			this.#reserved += 1;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const leave = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const grant = () => {
				leave();
				resolve();
			};
			const drop = (error: Error) => {
				const index = this.#waiters.indexOf(grant);
				if (index === -1) return;
				this.#waiters.splice(index, 1);
				leave();
				reject(error);
			};
			const onAbort = () => drop(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
			this.#waiters.push(grant);
			timer = setTimeout(() => drop(new Error(SANDBOX_BUSY)), this.#waitMs);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Runs `work` once a slot is free; the slot is released when `work` ends unless a worker took it over. */
	async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
		await this.#admit(signal);
		const ticket = { claimed: false };
		try {
			return await this.#tickets.run(ticket, work);
		} finally {
			if (!ticket.claimed) {
				this.#reserved -= 1;
				this.#wake();
			}
		}
	}
}

export type CodemodeRuntime = {
	readonly extension: Extension;
	readonly limiter: WorkerLimiter;
	close(): Promise<void>;
};

/**
 * The durable codemode extension on a sandbox shared by the whole runtime. `models: false`: scripts get no model
 * catalog, classifiers or image generation, which would bypass the provider enablement and key checks.
 */
export function createCodemodeRuntime(
	limits: { maxWorkers: number; waitMs: number } = CODEMODE_LIMITS,
): CodemodeRuntime {
	const limiter = new WorkerLimiter(limits);
	const sandbox = new CodemodeSandbox({
		memoryLimitBytes: CODEMODE_LIMITS.memoryLimitBytes,
		acquireWorker: limiter.acquireWorker,
	});
	const options = { sandbox, models: false } as const;
	const base = createCodemodeExtension(options);
	const reference = createCodemodeTool(options);
	const extension: Extension = {
		...base,
		wraps: [
			...(base.wraps ?? []),
			...nestedChangeWraps(),
			wrapTool(reference, (tool) => ({
				...tool,
				execute: (args, api, context) => limiter.run(context.abortSignal, () => tool.execute(args, api, context)),
			})),
		],
	};
	return { extension, limiter, close: () => sandbox.close() };
}
