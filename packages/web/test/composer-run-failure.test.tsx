import { JSDOM } from "jsdom";
import * as React from "react";
import { beforeEach, expect, it, vi } from "vitest";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const continues: string[] = [];
let continueError: Error | undefined;
vi.doMock("../src/client/lib/bootstrap", () => ({
	appActions: {
		continueRun: async (sessionId: string) => {
			continues.push(sessionId);
			if (continueError) throw continueError;
		},
		submit: async () => {},
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
const { languageStore } = await import("../src/client/lib/language.ts");
const setLanguage = (language: "zh" | "en") => languageStore().set(language);

type ChatView = import("@neko-harness/core").ChatView;
const view = (busy: boolean, extra: Partial<ChatView> = {}) =>
	({
		model: "faux/faux-1",
		agent: { model: null, thinkingLevel: null },
		cwd: "/w",
		busy,
		status: null,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		items: [],
		streaming: null,
		...extra,
	}) as unknown as ChatView;

async function mount(busy: boolean, extra?: Partial<ChatView>) {
	storeActions.setPhase("ready");
	storeActions.setSession("s1");
	storeActions.setView(view(busy, extra));
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(Composer, { busy, status: null })));
	return { host, root };
}
const bar = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-run-failure]");
const continueButton = (host: HTMLElement) =>
	[...host.querySelectorAll("button")].find((b) => b.textContent === "继续" || b.textContent === "Continue");

beforeEach(() => {
	continues.length = 0;
	continueError = undefined;
	setLanguage("zh");
	document.body.innerHTML = "";
});

it("shows the localized failure with its detail and continues the run", async () => {
	const failure = { reason: "model_error", detail: "401 invalid key" };
	const { host, root } = await mount(false, { continuable: true, runFailure: failure });
	expect(bar(host)?.textContent).toContain("模型请求失败");
	expect(bar(host)?.textContent).toContain("401 invalid key");
	await act(async () => continueButton(host)!.click());
	expect(continues).toEqual(["s1"]);
	// A new run removes the failure from the view, and the bar with it.
	await act(async () => storeActions.setView(view(true, { continuable: true })));
	expect(bar(host)).toBeNull();
	await act(async () => root.unmount());
});

it("shows a localized error when continuing is refused", async () => {
	continueError = new Error("CONTINUE_BUSY: The session is running; wait for it to finish.");
	const { host, root } = await mount(false, { continuable: true, runFailure: { reason: "aborted" } });
	expect(bar(host)?.textContent).toContain("已停止");
	await act(async () => continueButton(host)!.click());
	expect(host.textContent).toContain("CONTINUE_BUSY: 会话正在运行，请等待它结束。");
	await act(async () => root.unmount());
});

it("shows an unknown reason as its code and offers no continue when nothing can be answered", async () => {
	setLanguage("en");
	const { host, root } = await mount(false, { continuable: true, runFailure: { reason: "nothing_to_answer" } });
	expect(bar(host)?.textContent).toContain("Nothing to answer");
	expect(continueButton(host)).toBeUndefined();
	await act(async () => storeActions.setView(view(false, { continuable: true, runFailure: { reason: "brand_new" } })));
	expect(bar(host)?.textContent).toContain("brand_new");
	await act(async () => root.unmount());
});

it("hides the bar while running and on a gateway without continue", async () => {
	const failure = { reason: "model_error" };
	const running = await mount(true, { continuable: true, runFailure: failure });
	expect(bar(running.host)).toBeNull();
	await act(async () => running.root.unmount());
	const old = await mount(false, { runFailure: failure });
	expect(bar(old.host)).toBeNull();
	await act(async () => old.root.unmount());
});
