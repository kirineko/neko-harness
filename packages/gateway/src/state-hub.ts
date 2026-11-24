import type { Self } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Watchable } from "@earendil-works/chord/watch";
import type { NekoAttachment } from "./contract.ts";
import { type GatewayPrincipal, gatewayPrincipalKey } from "./principal.ts";

export type StateHub<T> = {
	readonly value: T;
	set(next: T): void;
	subscribe(fn: (value: T) => void): () => void;
	clear(): void;
};

export function createStateHub<T>(initial: T): StateHub<T> {
	let current = initial;
	const listeners = new Set<(value: T) => void>();
	return {
		get value() {
			return current;
		},
		set(next: T) {
			current = next;
			for (const fn of listeners) fn(next);
		},
		subscribe(fn: (value: T) => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		clear() {
			listeners.clear();
		},
	};
}

/** Exposes a shared `StateHub<T>` as a Chord JSON `Watchable<T>` on an object attempt via `self.writable` + `self.derive`. */
export function watchHub<T extends JsonValue>(self: Self<GatewayPrincipal>, hub: StateHub<T>): Watchable<T> {
	const writable = self.writable<T>(hub.value);
	self.open(
		async () => {
			writable.set(hub.value);
			return hub.subscribe((next) => {
				try {
					writable.set(next);
				} catch {
					// Ignore if attempt is mid-seal before close runs.
				}
			});
		},
		(unsubscribe) => {
			unsubscribe();
		},
	);
	return self.derive([writable], ([value]) => value);
}

/** Per-principal active attachment state, ref-counted by the principal's live session/management/subagent objects. */
export type PrincipalAttachments = {
	retain(principal: GatewayPrincipal): () => void;
	get(principal: GatewayPrincipal): NekoAttachment | null;
	set(principal: GatewayPrincipal, attachment: NekoAttachment | null): void;
};

export function createPrincipalAttachments(): PrincipalAttachments {
	const entries = new Map<string, { refs: number; active: NekoAttachment | null }>();
	const ensure = (key: string) => {
		let entry = entries.get(key);
		if (!entry) {
			entry = { refs: 0, active: null };
			entries.set(key, entry);
		}
		return entry;
	};
	return {
		retain(principal) {
			const key = gatewayPrincipalKey(principal);
			const entry = ensure(key);
			entry.refs += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				entry.refs -= 1;
				if (entry.refs <= 0) entries.delete(key);
			};
		},
		get(principal) {
			return entries.get(gatewayPrincipalKey(principal))?.active ?? null;
		},
		set(principal, attachment) {
			const key = gatewayPrincipalKey(principal);
			const entry = entries.get(key);
			if (!entry) {
				if (attachment !== null) entries.set(key, { refs: 0, active: attachment });
				return;
			}
			entry.active = attachment;
		},
	};
}
