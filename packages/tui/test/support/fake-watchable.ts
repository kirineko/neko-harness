import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Watchable, WatchCall, WatchEnd, WatchHandle } from "@earendil-works/chord/watch";

export type FakeWatchable<T> = {
	readonly watchable: Watchable<T>;
	readonly listeners: Set<(call: WatchCall<T>, context: Context) => Promise<void>>;
	setValue(value: T | undefined): void;
	publish(value: T): void;
};

export function createFakeWatchable<T>(initial: T | undefined): FakeWatchable<T> {
	let current = initial;
	const listeners = new Set<(call: WatchCall<T>, context: Context) => Promise<void>>();
	const watchable: Watchable<T> = {
		get value(): T {
			if (current === undefined) throw new Error("not_ready");
			return current;
		},
		async watch(context: Context): Promise<WatchHandle<T>> {
			let callback: ((call: WatchCall<T>, ctx: Context) => Promise<void>) | undefined;
			let ended: WatchEnd | undefined;
			let resolveClosed!: (end: WatchEnd) => void;
			const closed = new Promise<WatchEnd>((resolve) => {
				resolveClosed = resolve;
			});
			const forward = async (call: WatchCall<T>, ctx: Context) => {
				await callback?.(call, ctx);
			};
			const finish = (end: WatchEnd) => {
				if (ended !== undefined) return;
				ended = end;
				listeners.delete(forward);
				resolveClosed(end);
			};
			if (context.abortSignal?.aborted) {
				finish({ kind: "aborted" });
			} else {
				listeners.add(forward);
				context.abortSignal?.addEventListener("abort", () => finish({ kind: "aborted" }), { once: true });
			}
			const handle: WatchHandle<T> = {
				get value(): T {
					if (current === undefined) throw new Error("not_ready");
					return current;
				},
				start(listener) {
					if (ended !== undefined) return;
					callback = listener;
				},
				async stop(): Promise<WatchEnd> {
					finish({ kind: "stopped" });
					return ended!;
				},
				closed,
			};
			return handle;
		},
	};
	return {
		watchable,
		listeners,
		setValue(value: T | undefined) {
			current = value;
		},
		publish(value: T) {
			current = value;
			for (const listener of [...listeners]) {
				void listener({ kind: "value", value, ops: [], retired: false }, BACKGROUND_CONTEXT);
			}
		},
	};
}
