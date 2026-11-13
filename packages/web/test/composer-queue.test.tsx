import { JSDOM } from "jsdom";
import * as React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { WireSteerResult, WireWithdrawResult } from "../src/client/lib/contract.ts";

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

const submits: unknown[][] = [];
let withdrawResult: WireWithdrawResult = { result: "withdrawn", text: "full original text" };
let steerResult: WireSteerResult = { result: "steered", id: 99 };
const steers: unknown[][] = [];
vi.doMock("../src/client/lib/bootstrap", () => ({
	appActions: {
		submit: async (...args: unknown[]) => void submits.push(args),
		withdraw: async () => withdrawResult,
		steer: async (...args: unknown[]) => {
			steers.push(args);
			return steerResult;
		},
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

type Queued = NonNullable<import("@neko-harness/core").ChatView["queued"]>;
const view = (busy: boolean, queued?: Queued) =>
	({
		model: "faux/faux-1",
		agent: { model: null, thinkingLevel: null },
		cwd: "/w",
		busy,
		status: null,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		items: [],
		streaming: null,
		...(queued ? { queued } : {}),
	}) as unknown as import("@neko-harness/core").ChatView;

async function mount(busy: boolean, queued?: Queued) {
	storeActions.setPhase("ready");
	storeActions.setSession("s1");
	storeActions.setView(view(busy, queued));
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
const button = (host: HTMLElement, label: string) =>
	[...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;
const send = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".btn-primary")!;
const click = (el: Element) =>
	act(async () => void el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

beforeEach(() => {
	submits.length = 0;
	steers.length = 0;
	steerResult = { result: "steered", id: 99 };
	withdrawResult = { result: "withdrawn", text: "full original text" };
	document.body.innerHTML = "";
	// Each test uses a fresh session id so drafts do not leak between tests.
});

it("queues when busy without any delivery choice in the composer", async () => {
	const { host, root } = await mount(true, []);
	expect(host.querySelector('[aria-label="排队消息"]')).toBeNull();
	expect(button(host, "引导当前运行")).toBeUndefined();
	expect(host.querySelector("textarea")!.getAttribute("placeholder")).toContain("排队");
	await type(host, "hello later");
	expect(send(host).textContent).toBe("排队");
	expect(send(host).hasAttribute("disabled")).toBe(false);
	await click(send(host));
	expect(submits).toHaveLength(1);
	expect(submits[0]![0]).toBe("hello later");
	expect(submits[0]).toHaveLength(4);
	await act(async () => root.unmount());
});

it("steers a queued message from the queue bar and only offers it for queued ones", async () => {
	const queued: Queued = [
		{ id: 7, mode: "followUp", preview: "later one", images: 0 },
		{ id: 8, mode: "steer", preview: "already steer", images: 0 },
	];
	const { host, root } = await mount(true, queued);
	expect(button(host, "引导消息：already steer")).toBeUndefined();
	expect(button(host, "撤回引导消息：already steer")).toBeDefined();
	await type(host, "my draft");
	await click(button(host, "引导消息：later one"));
	expect(steers).toEqual([["s1", 7]]);
	expect(host.querySelector("textarea")!.value).toBe("my draft");

	steerResult = { result: "placed" };
	await click(button(host, "引导消息：later one"));
	expect(host.textContent).toContain("该消息已发送，无法引导");
	steerResult = { result: "withdrawn", text: "later one full" };
	await click(button(host, "引导消息：later one"));
	expect(host.querySelector("textarea")!.value).toBe("my draft\nlater one full");
	expect(host.textContent).toContain("无法改为引导");
	await act(async () => root.unmount());
});

it("shows no queue label when idle", async () => {
	const { host, root } = await mount(false, []);
	await type(host, "idle message");
	expect(send(host).textContent).toBe("发送");
	await click(send(host));
	expect(submits[0]).toHaveLength(4);
	await act(async () => root.unmount());
});

it("restores the full text on withdraw: replaces an empty draft, appends below a typed one", async () => {
	const queued: Queued = [{ id: 7, mode: "followUp", preview: "full orig…", images: 0 }];
	const { host, root } = await mount(true, queued);
	expect(host.querySelector('[aria-label="排队消息"]')?.textContent).toContain("full orig…");
	await click(button(host, "撤回排队消息：full orig…"));
	expect(host.querySelector("textarea")!.value).toBe("full original text");

	await type(host, "typed meanwhile");
	await click(button(host, "撤回排队消息：full orig…"));
	expect(host.querySelector("textarea")!.value).toBe("typed meanwhile\nfull original text");
	await act(async () => root.unmount());
});

it("keeps the draft and says so when the message was already sent or images cannot return", async () => {
	const queued: Queued = [{ id: 8, mode: "steer", preview: "photo", images: 1 }];
	const { host, root } = await mount(true, queued);
	await type(host, "my draft");
	withdrawResult = { result: "placed" };
	await click(button(host, "撤回引导消息：photo"));
	expect(host.querySelector("textarea")!.value).toBe("my draft");
	expect(host.textContent).toContain("该消息已发送，无法撤回");
	withdrawResult = { result: "withdrawn", text: "photo", images: 1 };
	await click(button(host, "撤回引导消息：photo"));
	expect(host.textContent).toContain("图片未恢复");
	await act(async () => root.unmount());
});
