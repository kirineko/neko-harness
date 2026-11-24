import type { RefState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { NativeWatchable, Watchable } from "@earendil-works/chord/watch";

/** Reads `watchable.value`, returning `undefined` before initial hydration or after release/failure. */
export function safeValue<T>(watchable: { readonly value: T }): T | undefined {
	try {
		return watchable.value;
	} catch {
		return undefined;
	}
}

/**
 * Subscribes to a Chord v2 JSON `Watchable<T>` with synchronous initial delivery when already hydrated,
 * deduplicated first frame when `watch()` resolves, and cleanup via `() => void`.
 */
export function subscribeState<T>(watchable: Watchable<T>, listener: (value: T) => void): () => void {
	let active = true;
	let emitted = false;
	let last: T | undefined;
	const deliver = (value: T) => {
		if (!active) return;
		if (emitted && value === last) return;
		emitted = true;
		last = value;
		listener(value);
	};
	try {
		deliver(watchable.value);
	} catch {
		// Not hydrated yet (`not_ready`); `watch(ctx)` waits for `firstValues` and delivers once live.
	}
	const abort = new AbortController();
	const ctx = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
	void watchable.watch(ctx).then(
		(handle) => {
			if (!active) {
				void handle.stop();
				return;
			}
			try {
				deliver(handle.value);
			} catch {
				// Ignore transient read errors; subsequent value frames will deliver.
			}
			handle.start(async (call) => {
				if (call.kind === "value") deliver(call.value);
			});
		},
		() => {},
	);
	return () => {
		active = false;
		abort.abort();
	};
}

/** Subscribes to a Chord v2 `NativeWatchable<T>` (such as `ref.state`) with immediate initial delivery. */
export function subscribeNative<T>(watchable: NativeWatchable<T>, listener: (value: T) => void): () => void {
	let active = true;
	let emitted = false;
	let last: T | undefined;
	const deliver = (value: T) => {
		if (!active) return;
		if (emitted && value === last) return;
		emitted = true;
		last = value;
		listener(value);
	};
	try {
		deliver(watchable.value);
	} catch {
		// Ignore if already released.
	}
	const abort = new AbortController();
	const ctx = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
	void watchable.watch(ctx).then(
		(handle) => {
			if (!active) {
				void handle.stop();
				return;
			}
			try {
				deliver(handle.value);
			} catch {}
			handle.start(async (call) => {
				if (call.kind === "value") deliver(call.value);
			});
		},
		() => {},
	);
	return () => {
		active = false;
		abort.abort();
	};
}

const DEFAULT_READY_TIMEOUT_MS = 5000;

/**
 * Waits for a `Held<C>` (or `Reference<C>`) to reach `{ kind: "live" }` (hydrated).
 * Permanent failures (`broken`, `denied`, `ended`) reject immediately; `loading`, `transient`, and `waiting`
 * wait up to `timeoutMs` or `signal` abort (rejecting with the latest failure error on timeout if failed).
 */
export function waitForLive(
	ref: { readonly state: NativeWatchable<RefState> },
	signal?: AbortSignal,
	timeoutMs = DEFAULT_READY_TIMEOUT_MS,
): Promise<void> {
	const checkImmediate = (state: RefState): Error | "live" | "wait" => {
		if (state.kind === "live") return "live";
		if (state.kind === "ended") return state.error;
		if (state.kind === "failed" && (state.cause.kind === "broken" || state.cause.kind === "denied")) {
			return state.cause.error;
		}
		return "wait";
	};
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Cancelled"));
	const initial = checkImmediate(ref.state.value);
	if (initial === "live") return Promise.resolve();
	if (initial !== "wait") return Promise.reject(initial);

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let stopWatch = () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => finish(false, signal?.reason ?? new Error("Cancelled"));
		const finish = (ok: boolean, error?: unknown) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			stopWatch();
			if (ok) resolve();
			else reject(error);
		};
		timer = setTimeout(() => {
			const latest = ref.state.value;
			if (latest.kind === "failed") finish(false, latest.cause.error);
			else finish(false, new Error("Gateway readiness timed out"));
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		stopWatch = subscribeNative(ref.state, (state) => {
			const verdict = checkImmediate(state);
			if (verdict === "live") finish(true);
			else if (verdict !== "wait") finish(false, verdict);
		});
	});
}
