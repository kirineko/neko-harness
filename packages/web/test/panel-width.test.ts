import { expect, it } from "bun:test";
import { SIDE_PANEL_WIDTH } from "../src/client/lib/layout.ts";
import { createPanelWidthStore, PANEL_WIDTH_KEY, parsePanelWidth } from "../src/client/lib/panel-width.ts";

class MemoryStorage {
	readonly map = new Map<string, string>();
	getItem(key: string) {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.map.set(key, value);
	}
	removeItem(key: string) {
		this.map.delete(key);
	}
}

function fakeTarget() {
	const handlers = new Set<(event: Event) => void>();
	return {
		handlers,
		addEventListener: (_type: string, handler: EventListenerOrEventListenerObject) =>
			handlers.add(handler as (event: Event) => void),
		removeEventListener: (_type: string, handler: EventListenerOrEventListenerObject) =>
			handlers.delete(handler as (event: Event) => void),
		emit: (key: string | null) => {
			for (const handler of handlers) handler({ key } as unknown as Event);
		},
	};
}

it("falls back to the default for missing, empty or non-numeric values and clamps out-of-range ones", () => {
	const { initial, min, max } = SIDE_PANEL_WIDTH;
	expect(parsePanelWidth(null)).toBe(initial);
	expect(parsePanelWidth(undefined)).toBe(initial);
	expect(parsePanelWidth("")).toBe(initial);
	expect(parsePanelWidth("  ")).toBe(initial);
	expect(parsePanelWidth("wide")).toBe(initial);
	expect(parsePanelWidth("NaN")).toBe(initial);
	expect(parsePanelWidth("-5")).toBe(min);
	expect(parsePanelWidth("0")).toBe(min);
	expect(parsePanelWidth("99999")).toBe(max);
	expect(parsePanelWidth("Infinity")).toBe(initial);
	expect(parsePanelWidth("600.6")).toBe(601);
	expect(parsePanelWidth("640")).toBe(640);
});

it("keeps drag updates in memory and writes only on commit", () => {
	const storage = new MemoryStorage();
	const store = createPanelWidthStore({ storage, target: fakeTarget() });
	let notified = 0;
	store.subscribe(() => notified++);
	store.set(700);
	store.set(710);
	expect(store.get()).toBe(710);
	expect(notified).toBe(2);
	expect(storage.map.has(PANEL_WIDTH_KEY)).toBe(false);
	store.commit();
	expect(storage.getItem(PANEL_WIDTH_KEY)).toBe("710");
	store.set(710);
	expect(notified).toBe(2);
	store.set(1);
	expect(store.get()).toBe(SIDE_PANEL_WIDTH.min);
});

it("restores the stored width on creation and resets to the default", () => {
	const storage = new MemoryStorage();
	storage.setItem(PANEL_WIDTH_KEY, "800");
	const store = createPanelWidthStore({ storage, target: fakeTarget() });
	expect(store.get()).toBe(800);
	store.reset();
	expect(store.get()).toBe(SIDE_PANEL_WIDTH.initial);
	expect(storage.map.has(PANEL_WIDTH_KEY)).toBe(false);
});

it("syncs another tab's change through storage events and detaches when unused", () => {
	const storage = new MemoryStorage();
	const target = fakeTarget();
	const store = createPanelWidthStore({ storage, target });
	let notified = 0;
	const unsubscribe = store.subscribe(() => notified++);
	expect(target.handlers.size).toBe(1);
	storage.setItem(PANEL_WIDTH_KEY, "420");
	target.emit("neko.other");
	expect(store.get()).toBe(SIDE_PANEL_WIDTH.initial);
	target.emit(PANEL_WIDTH_KEY);
	expect(store.get()).toBe(420);
	storage.map.clear();
	target.emit(null);
	expect(store.get()).toBe(SIDE_PANEL_WIDTH.initial);
	expect(notified).toBe(2);
	unsubscribe();
	expect(target.handlers.size).toBe(0);
});

it("keeps working in memory when storage throws", () => {
	const broken = {
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("denied");
		},
		removeItem() {
			throw new Error("denied");
		},
	};
	const store = createPanelWidthStore({ storage: broken, target: fakeTarget() });
	expect(store.get()).toBe(SIDE_PANEL_WIDTH.initial);
	store.set(640);
	expect(() => store.commit()).not.toThrow();
	expect(store.get()).toBe(640);
	expect(() => store.reset()).not.toThrow();
	expect(store.get()).toBe(SIDE_PANEL_WIDTH.initial);
});
