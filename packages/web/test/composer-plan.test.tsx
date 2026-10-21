import { beforeEach, expect, it, mock } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { chatView } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Element: dom.window.Element,
	Node: dom.window.Node,
	ShadowRoot: dom.window.ShadowRoot,
	getComputedStyle: dom.window.getComputedStyle,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const submits: unknown[][] = [];
const modes: unknown[][] = [];
let modeImpl: (sessionId: string, mode: string) => Promise<unknown> = async () => ({});
mock.module("../src/client/lib/bootstrap", () => ({
	appActions: {
		submit: async (...args: unknown[]) => void submits.push(args),
		planMode: (...args: [string, string]) => {
			modes.push(args);
			return modeImpl(...args);
		},
		withdraw: async () => ({ result: "unknown" }),
		steer: async () => ({ result: "unknown" }),
		abort: () => {},
		compact: async () => {},
		searchFiles: async () => ({ items: [] }),
		listSkills: async () => [],
		createSession: async () => {},
		configure: async () => {},
	},
}));

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { Composer } = await import("../src/client/components/composer.tsx");
const { storeActions } = await import("../src/client/lib/store.ts");

let sessions = 0;
async function mount(init: Parameters<typeof chatView>[0], busy = false) {
	storeActions.setPhase("ready");
	storeActions.setSession(`plan-composer-${++sessions}`);
	storeActions.setView(chatView({ busy, ...init }));
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(Composer, { busy, status: null })));
	return { host, root };
}
const type = async (host: HTMLElement, text: string) => {
	const area = host.querySelector("textarea")!;
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
		setter.call(area, text);
		area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	return area;
};
const enter = (area: HTMLTextAreaElement) =>
	act(async () => void area.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
const send = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".btn-primary")!;
const click = (el: Element) =>
	act(async () => void el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
const pill = (host: HTMLElement) => host.querySelector("[data-plan-mode]");

beforeEach(() => {
	submits.length = 0;
	modes.length = 0;
	modeImpl = async () => ({});
	document.body.innerHTML = "";
});

it("toggles into plan mode with /plan, clears the draft and sends nothing to the model", async () => {
	const { host, root } = await mount({ plan: {} });
	expect(pill(host)).toBeNull();
	await type(host, "/plan");
	expect(send(host).hasAttribute("disabled")).toBe(false);
	await click(send(host));
	expect(modes).toEqual([[expect.stringContaining("plan-composer-"), "plan"]]);
	expect(submits).toEqual([]);
	expect(host.querySelector("textarea")!.value).toBe("");
	await act(async () => root.unmount());
});

it("toggles out of plan mode and shows the accessible mode indicator while in it", async () => {
	const { host, root } = await mount({ plan: { mode: "plan" } });
	const indicator = pill(host)!;
	expect(indicator.textContent).toBe("规划模式（只读）");
	expect(indicator.closest("output")).not.toBeNull();
	const area = await type(host, "/plan");
	// The first Enter accepts the highlighted menu entry, the second submits the command.
	await enter(area);
	expect(modes).toEqual([]);
	await enter(area);
	expect(modes.map((m) => m[1])).toEqual(["normal"]);
	expect(submits).toEqual([]);
	await act(async () => root.unmount());
});

it("keeps the draft and says so when a run is active", async () => {
	const { host, root } = await mount({ plan: {} }, true);
	await type(host, "/plan");
	await click(send(host));
	expect(modes).toEqual([]);
	expect(submits).toEqual([]);
	expect(host.querySelector("textarea")!.value).toBe("/plan");
	expect(host.textContent).toContain("会话运行中");
	await act(async () => root.unmount());
});

it("keeps the draft and shows a hint when the server reports PLAN_BUSY", async () => {
	modeImpl = async () => {
		throw new Error("PLAN_BUSY: Wait for the current run to finish or stop it first.");
	};
	const { host, root } = await mount({ plan: {} });
	await type(host, "/plan");
	await click(send(host));
	expect(modes).toHaveLength(1);
	expect(host.querySelector("textarea")!.value).toBe("/plan");
	expect(host.textContent).toContain("会话运行中");
	await act(async () => root.unmount());
});

it("rejects stray arguments instead of sending the command as a message", async () => {
	const { host, root } = await mount({ plan: {} });
	await type(host, "/plan refactor everything");
	await click(send(host));
	expect(modes).toEqual([]);
	expect(submits).toEqual([]);
	expect(host.querySelector("textarea")!.value).toBe("/plan refactor everything");
	expect(host.textContent).toContain("不接受参数");
	await act(async () => root.unmount());
});

it("hides the menu item and the indicator on an old gateway, and refuses a typed /plan", async () => {
	const { host, root } = await mount({});
	expect(pill(host)).toBeNull();
	const area = await type(host, "/");
	expect(document.body.textContent).not.toContain("/plan");
	expect(host.querySelector("textarea")!.value).toBe("/");
	await type(host, "/plan");
	await enter(area);
	expect(modes).toEqual([]);
	expect(submits).toEqual([]);
	expect(host.textContent).toContain("不支持规划模式");
	await act(async () => root.unmount());
});

it("offers /plan in the command menu when supported", async () => {
	const { host, root } = await mount({ plan: {} });
	await type(host, "/");
	expect(document.body.textContent).toContain("/plan");
	await act(async () => root.unmount());
});
