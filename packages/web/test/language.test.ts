import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { translator } from "../src/client/lib/i18n/index.ts";
import {
	applyLanguage,
	createLanguageStore,
	DEFAULT_LANGUAGE,
	HTML_LANG,
	LANGUAGE_KEY,
	LANGUAGES,
	parseLanguage,
	readStoredLanguage,
	writeStoredLanguage,
} from "../src/client/lib/language.ts";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function page(storedLanguage?: string, runScripts?: "outside-only") {
	const dom = new JSDOM(html, { url: "http://localhost/", runScripts });
	if (storedLanguage !== undefined) dom.window.localStorage.setItem(LANGUAGE_KEY, storedLanguage);
	return dom;
}

function newStore(dom = page()) {
	const store = createLanguageStore({ storage: dom.window.localStorage, doc: dom.window.document, target: dom.window });
	return { dom, store };
}

it("defaults to Chinese for missing, broken or unknown values", () => {
	expect(DEFAULT_LANGUAGE).toBe("zh");
	expect(parseLanguage(null)).toBe("zh");
	expect(parseLanguage(undefined)).toBe("zh");
	expect(parseLanguage("")).toBe("zh");
	expect(parseLanguage("fr")).toBe("zh");
	expect(parseLanguage("EN")).toBe("zh");
	expect(parseLanguage("zh-CN")).toBe("zh");
	expect(parseLanguage("en")).toBe("en");
	expect(parseLanguage("zh")).toBe("zh");
	expect(LANGUAGES).toEqual(["zh", "en"]);
});

it("reads the stored value and falls back when storage is missing or throws", () => {
	const dom = page("en");
	expect(readStoredLanguage(dom.window.localStorage)).toBe("en");
	expect(readStoredLanguage(undefined)).toBe("zh");
	expect(
		readStoredLanguage({
			getItem() {
				throw new Error("denied");
			},
		}),
	).toBe("zh");
});

it("stores English, removes the item for the default and survives unavailable storage", () => {
	const dom = page();
	writeStoredLanguage("en", dom.window.localStorage);
	expect(dom.window.localStorage.getItem(LANGUAGE_KEY)).toBe("en");
	writeStoredLanguage("zh", dom.window.localStorage);
	expect(dom.window.localStorage.getItem(LANGUAGE_KEY)).toBeNull();
	const broken = {
		setItem() {
			throw new Error("quota");
		},
		removeItem() {
			throw new Error("denied");
		},
	};
	expect(() => writeStoredLanguage("en", broken)).not.toThrow();
	expect(() => writeStoredLanguage("zh", broken)).not.toThrow();
});

it("keeps working in memory when storage is unavailable", () => {
	const dom = page();
	const throwing = {
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("denied");
		},
		removeItem() {
			throw new Error("denied");
		},
	} as unknown as Storage;
	const store = createLanguageStore({ storage: throwing, doc: dom.window.document, target: dom.window });
	expect(store.get()).toBe("zh");
	store.set("en");
	expect(store.get()).toBe("en");
	expect(dom.window.document.documentElement.getAttribute("lang")).toBe("en");
});

it("maps the language to the html lang attribute", () => {
	expect(HTML_LANG).toEqual({ zh: "zh-CN", en: "en" });
	const doc = page().window.document;
	applyLanguage("en", doc);
	expect(doc.documentElement.getAttribute("lang")).toBe("en");
	applyLanguage("zh", doc);
	expect(doc.documentElement.getAttribute("lang")).toBe("zh-CN");
});

it("switches instantly, persists the choice and notifies subscribers once per change", () => {
	const { dom, store } = newStore();
	let calls = 0;
	const unsubscribe = store.subscribe(() => calls++);
	store.set("en");
	expect(store.get()).toBe("en");
	expect(dom.window.localStorage.getItem(LANGUAGE_KEY)).toBe("en");
	expect(dom.window.document.documentElement.getAttribute("lang")).toBe("en");
	store.set("en");
	expect(calls).toBe(1);
	store.set("zh");
	expect(dom.window.localStorage.getItem(LANGUAGE_KEY)).toBeNull();
	expect(dom.window.document.documentElement.getAttribute("lang")).toBe("zh-CN");
	expect(calls).toBe(2);
	unsubscribe();
	store.set("en");
	expect(calls).toBe(2);
	store.reset();
	expect(store.get()).toBe("zh");
});

it("restores the saved language on start and syncs other tabs through storage events", () => {
	const dom = page("en");
	const { store } = newStore(dom);
	store.start();
	expect(store.get()).toBe("en");
	expect(dom.window.document.documentElement.getAttribute("lang")).toBe("en");

	let calls = 0;
	store.subscribe(() => calls++);
	dom.window.localStorage.removeItem(LANGUAGE_KEY);
	dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: LANGUAGE_KEY }));
	expect(store.get()).toBe("zh");
	expect(dom.window.document.documentElement.getAttribute("lang")).toBe("zh-CN");

	dom.window.localStorage.setItem(LANGUAGE_KEY, "en");
	dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: "unrelated" }));
	expect(store.get()).toBe("zh");
	dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: null }));
	expect(store.get()).toBe("en");
	expect(calls).toBe(2);

	store.stop();
	dom.window.localStorage.removeItem(LANGUAGE_KEY);
	dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: LANGUAGE_KEY }));
	expect(store.get()).toBe("en");
});

it("translates through the dictionary of the chosen language", () => {
	expect(translator("zh")("settings.menu.appearance")).toBe("外观");
	expect(translator("en")("settings.menu.appearance")).toBe("Appearance");
});

function run(dom: JSDOM) {
	const scripts = [...dom.window.document.querySelectorAll("script:not([src])")];
	const script = scripts.find((node) => node.textContent?.includes(LANGUAGE_KEY));
	expect(script).toBeDefined();
	dom.window.eval(script?.textContent ?? "");
}

it("first-paint script sets html lang from the same storage key", () => {
	const english = page("en", "outside-only");
	run(english);
	expect(english.window.document.documentElement.getAttribute("lang")).toBe(HTML_LANG.en);

	const chinese = page("zh", "outside-only");
	run(chinese);
	expect(chinese.window.document.documentElement.getAttribute("lang")).toBe(HTML_LANG.zh);
});

it("first-paint script falls back to Chinese for missing and invalid values", () => {
	for (const stored of [undefined, "", "fr", "EN", "{}"]) {
		const dom = page(stored, "outside-only");
		dom.window.document.documentElement.setAttribute("lang", "en");
		run(dom);
		expect(dom.window.document.documentElement.getAttribute("lang")).toBe(HTML_LANG.zh);
	}
});

it("first-paint script does not throw when storage is unavailable", () => {
	const dom = page(undefined, "outside-only");
	Object.defineProperty(dom.window, "localStorage", {
		get() {
			throw new Error("denied");
		},
	});
	expect(() => run(dom)).not.toThrow();
	expect(dom.window.document.documentElement.getAttribute("lang")).toBe("zh-CN");
});

it("ships html lang zh-CN so a missing script still matches the default", () => {
	expect(html).toMatch(/<html lang="zh-CN">/);
});
