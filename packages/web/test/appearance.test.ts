import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import {
	APPEARANCE_KEY,
	type Appearance,
	ATTRIBUTES,
	applyAppearance,
	createAppearanceStore,
	DEFAULT_APPEARANCE,
	isDefaultAppearance,
	parseAppearance,
	serializeAppearance,
} from "../src/client/lib/appearance.ts";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function page() {
	return new JSDOM(html, { url: "http://localhost/" });
}

it("falls back to defaults for missing, broken or unknown values, item by item", () => {
	expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
	expect(parseAppearance("{not json")).toEqual(DEFAULT_APPEARANCE);
	expect(parseAppearance("[]")).toEqual(DEFAULT_APPEARANCE);
	expect(parseAppearance(JSON.stringify({ theme: "neon", size: "99", font: "serif", weight: "medium" }))).toEqual({
		...DEFAULT_APPEARANCE,
		font: "serif",
		weight: "medium",
	});
});

it("round-trips a valid appearance", () => {
	const value: Appearance = { theme: "dark", font: "mono", size: "18", weight: "semibold", leading: "relaxed" };
	expect(parseAppearance(serializeAppearance(value))).toEqual(value);
	expect(isDefaultAppearance(value)).toBe(false);
	expect(isDefaultAppearance(DEFAULT_APPEARANCE)).toBe(true);
});

it("writes data attributes only for non-default values and updates meta color-scheme", () => {
	const dom = page();
	const doc = dom.window.document;
	applyAppearance({ ...DEFAULT_APPEARANCE, theme: "dark", size: "16" }, doc);
	expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
	expect(doc.documentElement.getAttribute("data-chat-size")).toBe("16");
	expect(doc.documentElement.hasAttribute("data-chat-font")).toBe(false);
	expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("dark");
	applyAppearance(DEFAULT_APPEARANCE, doc);
	expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);
	expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("light");
});

it("persists changes, removes the item on reset and notifies subscribers", () => {
	const dom = page();
	const store = createAppearanceStore({
		storage: dom.window.localStorage,
		doc: dom.window.document,
		target: dom.window,
	});
	let calls = 0;
	store.subscribe(() => calls++);
	store.set({ theme: "light" });
	expect(store.get().theme).toBe("light");
	expect(JSON.parse(dom.window.localStorage.getItem(APPEARANCE_KEY) ?? "{}").theme).toBe("light");
	store.set({ theme: "light" });
	expect(calls).toBe(1);
	store.reset();
	expect(dom.window.localStorage.getItem(APPEARANCE_KEY)).toBeNull();
	expect(store.get()).toEqual(DEFAULT_APPEARANCE);
	expect(calls).toBe(2);
});

it("syncs from storage events of other tabs", () => {
	const dom = page();
	const store = createAppearanceStore({
		storage: dom.window.localStorage,
		doc: dom.window.document,
		target: dom.window,
	});
	store.start();
	dom.window.localStorage.setItem(APPEARANCE_KEY, serializeAppearance({ ...DEFAULT_APPEARANCE, theme: "dark" }));
	dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: APPEARANCE_KEY }));
	expect(store.get().theme).toBe("dark");
	expect(dom.window.document.documentElement.getAttribute("data-theme")).toBe("dark");
	dom.window.localStorage.clear();
	dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: null }));
	expect(store.get()).toEqual(DEFAULT_APPEARANCE);
	store.stop();
});

it("keeps working when storage is unavailable", () => {
	const dom = page();
	const broken = {
		getItem: () => {
			throw new Error("denied");
		},
		setItem: () => {
			throw new Error("denied");
		},
		removeItem: () => {
			throw new Error("denied");
		},
	} as unknown as Storage;
	const store = createAppearanceStore({ storage: broken, doc: dom.window.document, target: dom.window });
	expect(store.get()).toEqual(DEFAULT_APPEARANCE);
	expect(() => store.set({ theme: "dark" })).not.toThrow();
	expect(store.get().theme).toBe("dark");
	expect(dom.window.document.documentElement.getAttribute("data-theme")).toBe("dark");
});

// 首屏脚本与 lib 的键名、属性名对拍，并实际执行验证。
it("keeps the first-paint script in sync with the lib", () => {
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
	expect(script).toContain(`"${APPEARANCE_KEY}"`);
	for (const attribute of Object.values(ATTRIBUTES)) expect(script).toContain(`"${attribute}"`);
});

function runFirstPaint(stored: string | null) {
	const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ""), {
		url: "http://localhost/",
		runScripts: "outside-only",
	});
	if (stored !== null) dom.window.localStorage.setItem(APPEARANCE_KEY, stored);
	dom.window.eval(html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "");
	return dom.window.document;
}

it("applies stored appearance before the app renders and ignores unsafe values", () => {
	const doc = runFirstPaint(JSON.stringify({ v: 1, theme: "dark", size: "16", font: '"><x', weight: 3 }));
	expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
	expect(doc.documentElement.getAttribute("data-chat-size")).toBe("16");
	expect(doc.documentElement.hasAttribute("data-chat-font")).toBe(false);
	expect(doc.documentElement.hasAttribute("data-chat-weight")).toBe(false);
	expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("dark");
});

it("leaves the page untouched without a stored appearance or with broken JSON", () => {
	for (const stored of [null, "{oops"]) {
		const doc = runFirstPaint(stored);
		expect(doc.documentElement.hasAttribute("data-theme")).toBe(false);
		expect(doc.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("light");
	}
});
