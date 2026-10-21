import { afterEach, beforeEach, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";

const dom = new JSDOM("<!doctype html><html lang='zh-CN'><head></head><body></body></html>", {
	url: "http://localhost/",
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	HTMLElement: dom.window.HTMLElement,
	scrollTo: () => {},
	IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia ??= (() => ({
	matches: false,
	addEventListener() {},
	removeEventListener() {},
})) as unknown as typeof dom.window.matchMedia;

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } = await import(
	"@tanstack/react-router"
);
const { SettingsLanguagePage } = await import("../src/client/pages/settings-language-page.tsx");
const { translator } = await import("../src/client/lib/i18n/index.ts");
const { LANGUAGE_KEY, languageStore } = await import("../src/client/lib/language.ts");

const zh = translator("zh");
const en = translator("en");
const store = languageStore();
let unmount: (() => Promise<void>) | undefined;

async function mountPage() {
	const rootRoute = createRootRoute();
	const language = createRoute({
		getParentRoute: () => rootRoute,
		path: "/settings/language",
		component: SettingsLanguagePage,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([language]),
		history: createMemoryHistory({ initialEntries: ["/settings/language"] }),
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(RouterProvider, { router })));
	unmount = () => act(async () => root.unmount());
	return host;
}

const radio = (host: HTMLElement, value: string) =>
	host.querySelector<HTMLInputElement>(`input[type="radio"][name="ui-language"][value="${value}"]`)!;
const navLinks = (host: HTMLElement, label: string) => [...host.querySelectorAll(`nav[aria-label='${label}'] a`)];

beforeEach(() => {
	document.body.innerHTML = "";
	act(() => store.reset());
});

afterEach(async () => {
	await unmount?.();
	unmount = undefined;
	act(() => store.reset());
	dom.window.localStorage.clear();
});

it("shows the language page in Chinese by default with both options", async () => {
	const host = await mountPage();
	expect(host.querySelector("h1")?.textContent).toBe("语言 / Language");
	expect(radio(host, "zh").checked).toBe(true);
	expect(radio(host, "en").checked).toBe(false);
	const labels = [...host.querySelectorAll("fieldset label")].map((label) => label.textContent);
	expect(labels).toEqual(["中文", "English"]);
	expect(host.querySelector("fieldset legend")?.textContent).toBe(zh("language.legend"));
	expect(document.documentElement.getAttribute("lang")).toBe("zh-CN");
});

it("lists 语言 / Language between 外观 and 手机配对, marks it current and links to the page", async () => {
	const host = await mountPage();
	const links = navLinks(host, zh("settings.menuLabel"));
	const labels = links.map((link) => link.textContent?.trim());
	expect(labels.indexOf("语言 / Language")).toBe(labels.indexOf("外观") + 1);
	expect(labels.indexOf("手机配对")).toBe(labels.indexOf("语言 / Language") + 1);
	const current = links.find((link) => link.getAttribute("aria-current") === "page");
	expect(current?.textContent?.trim()).toBe("语言 / Language");
	expect(current?.getAttribute("href")).toBe("/settings/language");
});

it("switches the visible text immediately, persists the choice and keeps the menu entry bilingual", async () => {
	const host = await mountPage();
	await act(async () => radio(host, "en").click());

	expect(radio(host, "en").checked).toBe(true);
	expect(radio(host, "zh").checked).toBe(false);
	expect(document.documentElement.getAttribute("lang")).toBe("en");
	expect(dom.window.localStorage.getItem(LANGUAGE_KEY)).toBe("en");
	expect(host.querySelector("p.text-sm")?.textContent).toBe(en("language.intro"));
	expect(host.querySelector("fieldset legend")?.textContent).toBe(en("language.legend"));

	const links = navLinks(host, en("settings.menuLabel"));
	const labels = links.map((link) => link.textContent?.trim());
	expect(labels).toContain("Appearance");
	expect(labels).toContain("Mobile pairing");
	expect(labels.indexOf("语言 / Language")).toBe(labels.indexOf("Appearance") + 1);
	expect(links.find((link) => link.getAttribute("aria-current") === "page")?.textContent?.trim()).toBe(
		"语言 / Language",
	);
	expect([...host.querySelectorAll("fieldset label")].map((label) => label.textContent)).toEqual(["中文", "English"]);
});

it("switches back to Chinese and clears the saved value", async () => {
	const host = await mountPage();
	await act(async () => radio(host, "en").click());
	await act(async () => radio(host, "zh").click());
	expect(radio(host, "zh").checked).toBe(true);
	expect(document.documentElement.getAttribute("lang")).toBe("zh-CN");
	expect(dom.window.localStorage.getItem(LANGUAGE_KEY)).toBeNull();
	expect(host.querySelector("fieldset legend")?.textContent).toBe(zh("language.legend"));
});

it("follows a language change made in another tab", async () => {
	const host = await mountPage();
	store.start();
	dom.window.localStorage.setItem(LANGUAGE_KEY, "en");
	await act(async () => {
		dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: LANGUAGE_KEY }));
	});
	store.stop();
	expect(radio(host, "en").checked).toBe(true);
	expect(host.querySelector("fieldset legend")?.textContent).toBe(en("language.legend"));
});

it("keeps the menu entry reachable in the narrow layout (horizontal menu, same links)", async () => {
	const host = await mountPage();
	const nav = host.querySelector("nav")!;
	expect(nav.className).toContain("overflow-x-auto");
	expect(
		navLinks(host, zh("settings.menuLabel")).some((link) => link.getAttribute("href") === "/settings/language"),
	).toBe(true);
});
