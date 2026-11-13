import { JSDOM } from "jsdom";
import * as React from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { chatView } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { OpenWorkspaceMenu } = await import("../src/client/components/open-workspace-menu.tsx");
const { storeActions, getState } = await import("../src/client/lib/store.ts");

type Target = { id: string; label: string; available: boolean; reason?: string };
let targets: Target[];
let sessionStatus: number;
let openResult: { status: number; body: unknown };
let opens: Array<{ target: string; path: string; csrf: string }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
	document.body.innerHTML = "";
	localStorage.clear();
	targets = [
		{ id: "vscode", label: "VS Code", available: true },
		{ id: "file-manager", label: "Finder", available: true },
	];
	sessionStatus = 200;
	openResult = { status: 200, body: { opened: true } };
	opens = [];
	globalThis.fetch = (async (input: string, init?: RequestInit) => {
		if (input === "/api/local/session")
			return new Response(JSON.stringify({ csrf: "tok", targets }), { status: sessionStatus });
		if (input === "/api/open") {
			const body = JSON.parse(String(init?.body)) as { target: string; path: string };
			opens.push({ ...body, csrf: (init?.headers as Record<string, string>)["x-neko-csrf"]! });
			return new Response(JSON.stringify(openResult.body), { status: openResult.status });
		}
		throw new Error(`unexpected fetch ${input}`);
	}) as typeof fetch;
	storeActions.setPhase("ready");
	storeActions.setSession("s1");
	storeActions.setView(chatView({ busy: false }));
	storeActions.clearNotice();
});

const mounted: { unmount(): void }[] = [];
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount();
	});
	globalThis.fetch = realFetch;
	storeActions.setView(null);
	storeActions.setSession(null);
});

const flush = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
async function mount(ready = true) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () => root.render(React.createElement(OpenWorkspaceMenu, { ready })));
	await flush();
	return host;
}
const click = async (el: Element | null | undefined) => {
	await act(async () => void (el as HTMLElement).click());
	await flush();
};
const main = (host: ParentNode) => host.querySelector<HTMLButtonElement>(".open-main");
const more = (host: ParentNode) => host.querySelector<HTMLButtonElement>(".open-more");
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] .chrome-row')];

it("renders nothing when the server is not local", async () => {
	sessionStatus = 403;
	const host = await mount();
	expect(host.querySelector("[data-open-workspace]")).toBeNull();
});

it("opens the current workspace in VS Code by default", async () => {
	const host = await mount();
	expect(main(host)!.getAttribute("aria-label")).toBe("用 VS Code 打开");
	await click(main(host));
	expect(opens).toEqual([{ target: "vscode", path: "/w", csrf: "tok" }]);
	expect(host.querySelector("svg[aria-hidden]")).not.toBeNull();
});

it("switches target from the dropdown, opens it and remembers the choice", async () => {
	const host = await mount();
	await click(more(host));
	expect(menuItems().map((item) => item.textContent)).toEqual(["VS Code", "Finder"]);
	await click(menuItems()[1]);
	expect(opens).toEqual([{ target: "file-manager", path: "/w", csrf: "tok" }]);
	expect(localStorage.getItem("neko.openTarget")).toBe("file-manager");
	expect(main(host)!.getAttribute("aria-label")).toBe("用 Finder 打开");
});

it("greys out an unavailable target with its reason and falls back to the available one", async () => {
	targets[0] = { id: "vscode", label: "VS Code", available: false, reason: "未找到 VS Code" };
	const host = await mount();
	expect(main(host)!.getAttribute("aria-label")).toBe("用 Finder 打开");
	await click(more(host));
	const [code] = menuItems();
	expect(code!.disabled).toBe(true);
	expect(code!.textContent).toContain("未找到 VS Code");
});

it("closes the menu with Escape and returns focus to the trigger", async () => {
	const host = await mount();
	more(host)!.focus();
	await click(more(host));
	expect(menuItems()).toHaveLength(2);
	await act(async () => {
		document
			.querySelector('[role="dialog"]')!
			.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	});
	expect(menuItems()).toHaveLength(0);
	expect(document.activeElement).toBe(more(host));
});

it("shows an in-page error on failure without touching chat state", async () => {
	openResult = { status: 409, body: { code: "unavailable", message: "未找到 VS Code" } };
	const host = await mount();
	const before = getState().view;
	await click(main(host));
	expect(getState().notice?.text).toBe("打开失败：未找到 VS Code");
	expect(getState().view).toBe(before);
	expect(localStorage.getItem("neko.openTarget")).toBeNull();
});

it("is disabled without a session or while the connection is not ready", async () => {
	await act(async () => {
		storeActions.setSession(null);
		storeActions.setView(null);
	});
	let host = await mount();
	expect(main(host)!.disabled).toBe(true);
	expect(more(host)!.disabled).toBe(true);
	await act(async () => {
		storeActions.setSession("s1");
		storeActions.setView(chatView({ busy: false }));
	});
	document.body.innerHTML = "";
	host = await mount(false);
	expect(main(host)!.disabled).toBe(true);
	await click(main(host));
	expect(opens).toEqual([]);
});
