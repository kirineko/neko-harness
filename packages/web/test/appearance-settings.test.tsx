import { beforeEach, expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://localhost/" });
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
const { AppearancePanel } = await import("../src/client/components/appearance-panel.tsx");
const { SettingsShell } = await import("../src/client/components/settings-shell.tsx");
const { createAppearanceStore, APPEARANCE_KEY, DEFAULT_APPEARANCE } = await import("../src/client/lib/appearance.ts");

function newStore() {
	return createAppearanceStore({ storage: dom.window.localStorage, doc: dom.window.document, target: dom.window });
}

async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(element));
	return { host, unmount: () => act(async () => root.unmount()) };
}

const radio = (host: HTMLElement, name: string, value: string) =>
	host.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`)!;
const resetButton = (host: HTMLElement) =>
	[...host.querySelectorAll("button")].find((item) => item.textContent === "恢复默认")!;
const click = (el: HTMLElement) => act(async () => el.click());

beforeEach(() => {
	document.body.innerHTML = "";
	dom.window.localStorage.clear();
	for (const attribute of [...document.documentElement.attributes]) {
		if (attribute.name.startsWith("data-")) document.documentElement.removeAttribute(attribute.name);
	}
});

it("shows the defaults, with a disabled reset and no text inputs", async () => {
	const view = await mount(React.createElement(AppearancePanel, { store: newStore() }));
	expect(view.host.querySelector('input[type="text"], textarea')).toBeNull();
	expect(radio(view.host, "appearance-theme", "sakura").checked).toBe(true);
	expect(radio(view.host, "appearance-font", "sans").checked).toBe(true);
	expect(radio(view.host, "appearance-size", "14").checked).toBe(true);
	expect(radio(view.host, "appearance-weight", "regular").checked).toBe(true);
	expect(radio(view.host, "appearance-leading", "normal").checked).toBe(true);
	expect(resetButton(view.host).disabled).toBe(true);
	expect(view.host.textContent).toContain("取决于你的设备");
	await view.unmount();
});

it("saves and applies each choice immediately and updates the sample", async () => {
	const store = newStore();
	const view = await mount(React.createElement(AppearancePanel, { store }));
	await click(radio(view.host, "appearance-theme", "light"));
	await click(radio(view.host, "appearance-size", "16"));
	await click(radio(view.host, "appearance-font", "serif"));
	await click(radio(view.host, "appearance-weight", "semibold"));
	await click(radio(view.host, "appearance-leading", "relaxed"));
	const html = document.documentElement;
	expect(html.getAttribute("data-theme")).toBe("light");
	expect(html.getAttribute("data-chat-size")).toBe("16");
	expect(html.getAttribute("data-chat-font")).toBe("serif");
	expect(html.getAttribute("data-chat-weight")).toBe("semibold");
	expect(html.getAttribute("data-chat-leading")).toBe("relaxed");
	expect(JSON.parse(dom.window.localStorage.getItem(APPEARANCE_KEY) ?? "{}")).toMatchObject({
		theme: "light",
		size: "16",
		font: "serif",
	});
	expect(radio(view.host, "appearance-size", "16").checked).toBe(true);
	const sample = view.host.querySelector('[data-testid="appearance-sample"]')!;
	expect(sample.querySelector(".bubble-user")?.textContent).toContain("undefined");
	expect(sample.querySelector(".bubble-assistant .md pre")).not.toBeNull();
	expect(resetButton(view.host).disabled).toBe(false);
	await view.unmount();
});

it("restores the defaults and clears the saved preference", async () => {
	const store = newStore();
	const view = await mount(React.createElement(AppearancePanel, { store }));
	await click(radio(view.host, "appearance-theme", "dark"));
	await click(radio(view.host, "appearance-size", "18"));
	expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
	await click(resetButton(view.host));
	expect(store.get()).toEqual(DEFAULT_APPEARANCE);
	expect(dom.window.localStorage.getItem(APPEARANCE_KEY)).toBeNull();
	expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
	expect(radio(view.host, "appearance-theme", "sakura").checked).toBe(true);
	expect(resetButton(view.host).disabled).toBe(true);
	await view.unmount();
});

it("previews every theme with its own data-theme regardless of the active one", async () => {
	const view = await mount(React.createElement(AppearancePanel, { store: newStore() }));
	const previews = [...view.host.querySelectorAll("[data-theme]")].map((el) => el.getAttribute("data-theme"));
	expect(previews).toEqual(["sakura", "light", "dark"]);
	await view.unmount();
});

it("reflects a change made in another tab", async () => {
	const store = newStore();
	store.start();
	const view = await mount(React.createElement(AppearancePanel, { store }));
	dom.window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ v: 1, theme: "dark" }));
	await act(async () => {
		dom.window.dispatchEvent(new dom.window.StorageEvent("storage", { key: APPEARANCE_KEY }));
	});
	expect(radio(view.host, "appearance-theme", "dark").checked).toBe(true);
	store.stop();
	await view.unmount();
});

it("lists 外观 between 上下文 and 手机配对 and marks it current", async () => {
	const rootRoute = createRootRoute({
		component: () =>
			React.createElement(
				SettingsShell,
				{ active: "appearance" } as React.ComponentProps<typeof SettingsShell>,
				React.createElement("p", null, "body"),
			),
	});
	const page = createRoute({ getParentRoute: () => rootRoute, path: "/settings/appearance" });
	const router = createRouter({
		routeTree: rootRoute.addChildren([page]),
		history: createMemoryHistory({ initialEntries: ["/settings/appearance"] }),
	});
	const view = await mount(React.createElement(RouterProvider, { router }));
	const links = [...view.host.querySelectorAll("nav[aria-label='设置菜单'] a")];
	const labels = links.map((link) => link.textContent?.trim());
	expect(labels.indexOf("外观")).toBe(labels.indexOf("上下文") + 1);
	expect(labels.indexOf("手机配对")).toBe(labels.indexOf("外观") + 1);
	const current = links.find((link) => link.getAttribute("aria-current") === "page");
	expect(current?.textContent?.trim()).toBe("外观");
	expect(current?.getAttribute("href")).toBe("/settings/appearance");
	await view.unmount();
});
