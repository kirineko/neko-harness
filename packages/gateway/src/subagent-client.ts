import type { ChatView } from "@neko-harness/core";
import type { NekoSubagent } from "./contract.ts";
import { subscribeNative, subscribeState } from "./watch.ts";

export type SubagentClient = {
	readonly error: string | undefined;
	view: { readonly value: ChatView | undefined; subscribe(fn: (value: ChatView | undefined) => void): () => void };
	history(input: { before?: number }): Promise<{ items: ChatView["items"]; next: number | null }>;
	getImage: NekoSubagent["getImage"];
	stop: NekoSubagent["stop"];
	decideApproval: NekoSubagent["decideApproval"];
};
/** JSON travels in bounded Chord RPC chunks; renderers receive the ordinary shared ChatView. */
export function subagentClient(connect: () => NekoSubagent): SubagentClient {
	let value: ChatView | undefined;
	let remote: NekoSubagent | undefined;
	let error: string | undefined;
	let stopStatus: (() => void) | undefined;
	const acquire = () => {
		if (!remote) {
			remote = connect();
			stopStatus = subscribeNative(remote.state, (state) => {
				if (state.kind === "failed" && (state.cause.kind === "broken" || state.cause.kind === "denied")) {
					error = state.cause.error.message;
					for (const fn of listeners) fn(value);
				} else if (state.kind === "ended") {
					error = state.error.message;
					for (const fn of listeners) fn(value);
				}
			});
		}
		return remote;
	};
	const release = () => {
		stopStatus?.();
		stopStatus = undefined;
		remote?.release();
		remote = undefined;
	};
	const listeners = new Set<(value: ChatView | undefined) => void>();
	let unsubscribe: (() => void) | undefined;
	let epoch = 0,
		wanted = 0,
		loading = false;
	async function download<T>(kind: "view" | "history", before?: number, alive = () => true): Promise<T> {
		let token: number | undefined,
			offset = 0;
		const chunks: string[] = [];
		for (;;) {
			if (!alive()) throw new Error("Transcript subscription closed");
			const part = await acquire().chunk({ kind, before, token, offset });
			if (!alive()) throw new Error("Transcript subscription closed");
			chunks.push(part.data);
			token = part.token;
			if (part.next === null) return JSON.parse(chunks.join("")) as T;
			offset = part.next;
		}
	}
	const refresh = async () => {
		if (loading || !listeners.size || !wanted) return;
		loading = true;
		const generation = epoch;
		let attempted = 0;
		try {
			do {
				attempted = wanted;
				try {
					const next = await download<ChatView>("view", undefined, () => epoch === generation && listeners.size > 0);
					if (epoch !== generation) return;
					error = undefined;
					value = next;
					for (const fn of listeners) fn(value);
				} catch (reason) {
					// A moving revision may evict a chunk; consume the newest revision next.
					if (epoch !== generation) return;
					if (wanted === attempted) {
						error = String(reason);
						for (const fn of listeners) fn(value);
					}
				}
			} while (wanted !== attempted);
		} finally {
			loading = false;
			if (epoch !== generation && listeners.size) void refresh();
		}
	};
	return {
		get error() {
			return error;
		},
		view: {
			get value() {
				return value;
			},
			subscribe(fn) {
				listeners.add(fn);
				fn(value);
				if (!unsubscribe)
					unsubscribe = subscribeState(acquire().revision, (revision) => {
						wanted = revision ?? 0;
						void refresh();
					});
				return () => {
					listeners.delete(fn);
					if (!listeners.size) {
						epoch++;
						unsubscribe?.();
						unsubscribe = undefined;
						release();
					}
				};
			},
		},
		history: async (input) => {
			const generation = epoch;
			try {
				return await download("history", input.before, () => generation === epoch);
			} finally {
				if (!listeners.size) release();
			}
		},
		getImage: async (input, ctx) => {
			try {
				return await acquire().getImage(input, ctx);
			} finally {
				if (!listeners.size) release();
			}
		},
		decideApproval: async (input, ctx) => {
			try {
				return await acquire().decideApproval(input, ctx);
			} finally {
				if (!listeners.size) release();
			}
		},
		stop: async (input, ctx) => {
			try {
				return await acquire().stop(input, ctx);
			} finally {
				if (!listeners.size) release();
			}
		},
	};
}
