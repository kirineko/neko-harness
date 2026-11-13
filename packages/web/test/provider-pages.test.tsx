import type { NekoSelectableModel } from "@neko-harness/core";
import { JSDOM } from "jsdom";
import * as React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NekoCredentialState } from "../src/client/lib/contract.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	HTMLElement: dom.window.HTMLElement,
	HTMLDialogElement: dom.window.HTMLDialogElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const dialog = dom.window.HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
dialog.showModal ??= function (this: HTMLDialogElement) {
	this.setAttribute("open", "");
};
dialog.close ??= function (this: HTMLDialogElement) {
	this.removeAttribute("open");
};

const configured: unknown[][] = [];
const savedCredentials: unknown[][] = [];
const enabledCalls: unknown[][] = [];
const defaultCalls: { set: unknown[]; clear: number } = { set: [], clear: 0 };
vi.doMock("../src/client/lib/bootstrap", () => ({
	appActions: {
		configure: async (...args: unknown[]) => void configured.push(args),
		setProviderEnabled: async (...args: unknown[]) => void enabledCalls.push(args),
		setDefaultModel: async (model: unknown) => void defaultCalls.set.push(model),
		clearDefaultModel: async () => void defaultCalls.clear++,
		saveCredential: async (...args: unknown[]) => void savedCredentials.push(args),
		removeCredential: async () => {},
		setSearchProvider: async () => {},
	},
}));
vi.doMock("@tanstack/react-router", () => ({
	Link: ({
		to,
		hash,
		children,
		...rest
	}: { to: string; hash?: string; children?: React.ReactNode } & Record<string, unknown>) =>
		React.createElement("a", { href: `${to}${hash ? `#${hash}` : ""}`, ...rest }, children),
}));

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { storeActions } = await import("../src/client/lib/store.ts");
const { ModelPicker } = await import("../src/client/components/model-picker.tsx");
const { SettingsPage } = await import("../src/client/pages/settings-page.tsx");
const { SettingsSearchPage } = await import("../src/client/pages/settings-search-page.tsx");

const model = (provider: string, modelId: string, name: string, available: boolean): NekoSelectableModel => ({
	provider,
	modelId,
	name,
	available,
	contextWindow: 128_000,
	input: ["text"],
	reasoning: true,
	supportedThinkingLevels: ["off", "high", "max"],
	thinkingLevelAdjustments: {
		off: "off",
		minimal: "off",
		low: "high",
		medium: "high",
		high: "high",
		xhigh: "max",
		max: "max",
	},
});
const status = (source: "saved" | "none" | "keyless", enabled?: boolean) => ({
	savedConfigured: source === "saved",
	environmentConfigured: false,
	source,
	...(enabled === undefined ? {} : { enabled }),
});
const credentials = (): NekoCredentialState => ({
	revision: 1,
	statuses: {
		deepseek: status("saved", true),
		openrouter: status("none", true),
		openai: status("saved", false),
		tavily: status("keyless"),
	},
});
const view = (provider: string, modelId: string) =>
	({
		model: `${provider}/${modelId}`,
		agent: { model: { provider, modelId }, thinkingLevel: "high" },
		cwd: "/w",
		busy: false,
		status: null,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		items: [],
		streaming: null,
	}) as unknown as import("@neko-harness/core").ChatView;

async function mount(element: React.ReactElement) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(element));
	return { host, unmount: () => act(async () => root.unmount()) };
}
const click = (element: Element | null) => act(async () => (element as HTMLElement).click());
const combobox = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
async function chooseProvider(name: string) {
	await click(combobox());
	const option = [...document.body.querySelectorAll('[role="option"]')].find((item) =>
		item.textContent?.includes(name),
	);
	await click(option ?? null);
}

beforeEach(() => {
	configured.length = 0;
	savedCredentials.length = 0;
	enabledCalls.length = 0;
	defaultCalls.set.length = 0;
	defaultCalls.clear = 0;
	document.body.innerHTML = "";
	storeActions.setPhase("ready");
	storeActions.setSession("s1");
	storeActions.setDefaultModel(null);
	storeActions.setCredentials(null);
	storeActions.setCredentials({ ...credentials(), revision: 100 });
	storeActions.setModels([
		model("deepseek", "deepseek-flash", "DeepSeek Flash", true),
		model("deepseek", "deepseek-v4-pro", "DeepSeek Pro", true),
		model("openrouter", "anthropic/claude-haiku-4.5", "Claude Haiku", false),
		model("openrouter", "openai/gpt-x", "GPT X", false),
	]);
});

it("shows one provider's models, blocks keyless ones and applies a choice", async () => {
	storeActions.setView(view("deepseek", "deepseek-flash"));
	const picker = await mount(
		React.createElement(ModelPicker, {
			current: { provider: "deepseek", modelId: "deepseek-flash" },
			fallbackLabel: "x",
		}),
	);
	await click(picker.host.querySelector("button"));
	const body = document.body;
	expect(combobox().value).toBe("DeepSeek");
	expect(body.querySelector("button[aria-expanded]")).toBeNull();
	expect(body.textContent).toContain("DeepSeek Pro");
	expect(body.textContent).not.toContain("Claude Haiku");
	expect(body.querySelector('a[href="/settings#credential-openrouter"]')).toBeNull();

	await chooseProvider("OpenRouter");
	expect(combobox().value).toBe("OpenRouter");
	expect(body.textContent).not.toContain("DeepSeek Pro");
	expect(body.textContent).toContain("未配置 Key");
	expect(body.querySelector('a[href="/settings#credential-openrouter"]')).not.toBeNull();
	const blocked = [...body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) =>
		b.textContent?.includes("Claude Haiku"),
	)!;
	expect(blocked.disabled).toBe(true);

	await chooseProvider("DeepSeek");
	const pro = [...body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) =>
		b.textContent?.includes("DeepSeek Pro"),
	)!;
	await click(pro);
	const apply = [...body.querySelectorAll("button")].find((b) => b.textContent === "应用")!;
	await click(apply);
	expect(configured).toEqual([
		[{ model: { provider: "deepseek", modelId: "deepseek-v4-pro" }, thinkingLevel: "high" }, "s1"],
	]);
	await picker.unmount();
});

it("searches across providers, labelling matches, restores the dropdown view and reports an empty result", async () => {
	storeActions.setView(view("deepseek", "deepseek-flash"));
	const picker = await mount(
		React.createElement(ModelPicker, {
			current: { provider: "deepseek", modelId: "deepseek-flash" },
			fallbackLabel: "x",
		}),
	);
	await click(picker.host.querySelector("button"));
	const search = document.body.querySelector<HTMLInputElement>("#model-search")!;
	const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
	const type = (value: string) =>
		act(async () => {
			setValue.call(search, value);
			search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
		});
	await type("claude");
	expect(document.body.querySelector("dialog")!.textContent).toContain("Claude Haiku");
	expect(document.body.querySelector("dialog")!.textContent).toContain("OpenRouter");
	expect(document.body.querySelector("dialog")!.textContent).not.toContain("DeepSeek Flash");
	await type("zzz");
	expect(document.body.querySelector("dialog")!.textContent).toContain("没有匹配的模型");
	await type("");
	expect(document.body.querySelector("dialog")!.textContent).toContain("DeepSeek Flash");
	expect(document.body.querySelector("dialog")!.textContent).not.toContain("Claude Haiku");
	await picker.unmount();
});

it("keeps hundreds of models in one scrollable list and Escape only closes the dropdown", async () => {
	storeActions.setModels([
		model("deepseek", "deepseek-flash", "DeepSeek Flash", true),
		...Array.from({ length: 400 }, (_, index) => model("openrouter", `vendor/m-${index}`, `Model ${index}`, true)),
	]);
	storeActions.setView(view("deepseek", "deepseek-flash"));
	const picker = await mount(
		React.createElement(ModelPicker, {
			current: { provider: "deepseek", modelId: "deepseek-flash" },
			fallbackLabel: "x",
		}),
	);
	await click(picker.host.querySelector("button"));
	await chooseProvider("OpenRouter");
	const list = document.body.querySelector("fieldset[aria-label='模型']")!;
	expect(list.className).toContain("overflow-y-auto");
	expect(list.querySelectorAll("button[aria-pressed]").length).toBe(800);

	await click(combobox());
	expect(document.body.textContent).toContain("400 个模型");
	const esc = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	await act(async () => void combobox().dispatchEvent(esc));
	expect(esc.defaultPrevented).toBe(true);
	expect(combobox().getAttribute("aria-expanded")).toBe("false");
	await picker.unmount();
});

it("still opens for a session whose provider was disabled and explains why", async () => {
	storeActions.setView(view("openai", "gpt-x"));
	const picker = await mount(
		React.createElement(ModelPicker, {
			current: { provider: "openai", modelId: "gpt-x" },
			fallbackLabel: "openai/gpt-x",
		}),
	);
	const trigger = picker.host.querySelector("button")!;
	expect(trigger.disabled).toBe(false);
	await click(trigger);
	expect(combobox().value).toBe("DeepSeek");
	expect(document.body.textContent).toContain("已取消启用");
	expect(document.body.querySelector('a[href="/settings#credential-openai"]')).not.toBeNull();
	const apply = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "应用")!;
	expect(apply.disabled).toBe(true);
	await picker.unmount();
});

it("selects a provider from the dropdown, locks DeepSeek and toggles enablement through the gateway", async () => {
	const page = await mount(React.createElement(SettingsPage));
	const body = page.host;
	expect(body.querySelector("h1")?.textContent).toBe("模型服务");
	expect(body.textContent).not.toContain("Tavily");
	expect(body.querySelector("details")).toBeNull();
	expect(combobox().value).toBe("DeepSeek");
	const deepseek = body.querySelector<HTMLInputElement>('input[aria-label="启用 DeepSeek"]')!;
	expect(deepseek.checked).toBe(true);
	expect(deepseek.disabled).toBe(true);
	expect(body.querySelector('input[aria-label="启用 OpenRouter"]')).toBeNull();

	await chooseProvider("OpenRouter");
	expect(body.querySelector('input[aria-label="启用 DeepSeek"]')).toBeNull();
	expect(body.querySelector<HTMLInputElement>('input[aria-label="启用 OpenRouter"]')!.checked).toBe(true);

	await chooseProvider("OpenAI");
	const openai = body.querySelector<HTMLInputElement>('input[aria-label="启用 OpenAI"]')!;
	expect(openai.checked).toBe(false);
	await click(openai);
	expect(enabledCalls).toEqual([["openai", true]]);
	await page.unmount();
});

it("filters the provider dropdown by name, id and environment variable", async () => {
	const page = await mount(React.createElement(SettingsPage));
	const input = combobox();
	await click(input);
	const options = () => [...document.body.querySelectorAll('[role="option"]')].map((item) => item.textContent ?? "");
	expect(options().length).toBeGreaterThan(20);
	const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
	await act(async () => {
		setValue.call(input, "OPENROUTER_API");
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	expect(options()).toHaveLength(1);
	expect(options()[0]).toContain("OpenRouter");
	expect(options()[0]).toContain("未配置 Key");
	await page.unmount();
});

it("opens the provider named by the credential deep link and clears typed keys on switch", async () => {
	dom.window.history.replaceState(null, "", "/settings#credential-openrouter");
	const page = await mount(React.createElement(SettingsPage));
	expect(combobox().value).toBe("OpenRouter");
	expect(page.host.querySelector("#credential-openrouter")).not.toBeNull();
	const key = page.host.querySelector<HTMLInputElement>("#openrouter-key")!;
	const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
	await act(async () => {
		setValue.call(key, "sk-secret");
		key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	expect(key.value).toBe("sk-secret");
	await chooseProvider("DeepSeek");
	await chooseProvider("OpenRouter");
	expect(page.host.querySelector<HTMLInputElement>("#openrouter-key")!.value).toBe("");
	dom.window.history.replaceState(null, "", "/");
	await page.unmount();
});

it("keeps web search and the Tavily key on their own page", async () => {
	storeActions.setSearchSettings({ revision: 1, selected: "tavily" });
	const page = await mount(React.createElement(SettingsSearchPage));
	const text = page.host.textContent ?? "";
	expect(page.host.querySelector("h1")?.textContent).toBe("联网搜索");
	expect(text).toContain("搜索服务");
	expect(page.host.querySelector("#credential-tavily")).not.toBeNull();
	expect(page.host.querySelector("#credential-deepseek")).not.toBeNull();
	expect(page.host.querySelector("#credential-deepseek")?.textContent).toContain(
		"环境变量：未配置（DEEPSEEK_API_KEY） · 与「模型服务」共用同一个 DeepSeek Key，在任一页面保存或移除都会同步。",
	);
	expect(page.host.querySelector('input[aria-label^="启用"]')).toBeNull();
	expect(page.host.querySelector('a[href="/settings/search"][aria-current="page"]')).not.toBeNull();
	expect(page.host.querySelector('a[href="/settings"]')).not.toBeNull();
	await page.unmount();
});

it("saves the DeepSeek key from the search page without changing the selected search service", async () => {
	storeActions.setSearchSettings({ revision: 1, selected: "tavily" });
	const page = await mount(React.createElement(SettingsSearchPage));
	const key = page.host.querySelector<HTMLInputElement>("#deepseek-key")!;
	const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
	await act(async () => {
		setValue.call(key, "sk-deepseek");
		key.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	await click(page.host.querySelector("#credential-deepseek button[type='submit']"));
	expect(savedCredentials).toEqual([["deepseek", "sk-deepseek"]]);
	expect(page.host.textContent).toContain("当前使用：Tavily");
	await page.unmount();
});

const star = (name: string, action: "设为默认" | "取消默认") =>
	document.body.querySelector<HTMLButtonElement>(`button[aria-label="${action} ${name}"]`);

it("marks the default model, toggles it from an available row and follows state updates", async () => {
	storeActions.setView(view("deepseek", "deepseek-flash"));
	storeActions.setDefaultModel({
		effective: { provider: "deepseek", modelId: "deepseek-flash" },
		source: "saved",
	});
	const picker = await mount(
		React.createElement(ModelPicker, {
			current: { provider: "deepseek", modelId: "deepseek-flash" },
			fallbackLabel: "x",
		}),
	);
	const trigger = picker.host.querySelector("button")!;
	expect(trigger.textContent).toContain("★");
	await click(trigger);
	// 当前默认模型行带星标，非默认行只提供「设为默认」。
	expect(star("DeepSeek Flash", "取消默认")).not.toBeNull();
	expect(star("DeepSeek Flash", "设为默认")).toBeNull();
	expect(star("DeepSeek Pro", "设为默认")).not.toBeNull();

	await click(star("DeepSeek Pro", "设为默认"));
	expect(defaultCalls.set).toEqual([{ provider: "deepseek", modelId: "deepseek-v4-pro" }]);
	expect(defaultCalls.clear).toBe(0);
	// 设为默认不改变当前会话模型：选中的仍是 Flash。
	expect(document.body.textContent).toContain("DeepSeek Flash ✓");

	// 另一端的修改经订阅同步后无需重开面板即可反映。
	await act(async () =>
		storeActions.setDefaultModel({
			effective: { provider: "deepseek", modelId: "deepseek-v4-pro" },
			source: "saved",
		}),
	);
	expect(star("DeepSeek Pro", "取消默认")).not.toBeNull();
	expect(star("DeepSeek Flash", "设为默认")).not.toBeNull();
	expect(trigger.textContent).not.toContain("★");

	await click(star("DeepSeek Pro", "取消默认"));
	expect(defaultCalls.clear).toBe(1);
	expect(defaultCalls.set).toEqual([{ provider: "deepseek", modelId: "deepseek-v4-pro" }]);
	await picker.unmount();
});

it("offers no default toggle on models that cannot be picked for lack of a key", async () => {
	storeActions.setView(view("deepseek", "deepseek-flash"));
	storeActions.setDefaultModel({
		effective: { provider: "deepseek", modelId: "deepseek-flash" },
		source: "saved",
	});
	const picker = await mount(
		React.createElement(ModelPicker, {
			current: { provider: "deepseek", modelId: "deepseek-flash" },
			fallbackLabel: "x",
		}),
	);
	await click(picker.host.querySelector("button"));
	await chooseProvider("OpenRouter");
	expect(document.body.textContent).toContain("Claude Haiku");
	expect(star("Claude Haiku", "设为默认")).toBeNull();
	expect(star("Claude Haiku", "取消默认")).toBeNull();
	// 未配置 Key 的整组都不带默认键（否则行内会出现 ☆/★ 切换按钮）。
	const panel = document.body.querySelector("#models-openrouter")!;
	expect(panel.textContent).toContain("Claude Haiku");
	expect(panel.querySelectorAll("button[aria-label]")).toHaveLength(0);
	await picker.unmount();
});

it("marks a cli-sourced default and keeps the toggle driven by the subscribed state", async () => {
	// 会话模型是 Pro，而 --model 指定的默认是 Flash：触发器不带星标。
	storeActions.setView(view("deepseek", "deepseek-v4-pro"));
	storeActions.setDefaultModel({
		effective: { provider: "deepseek", modelId: "deepseek-flash" },
		source: "cli",
	});
	const picker = await mount(
		React.createElement(ModelPicker, {
			current: { provider: "deepseek", modelId: "deepseek-v4-pro" },
			fallbackLabel: "x",
		}),
	);
	const trigger = picker.host.querySelector("button")!;
	expect(trigger.textContent).not.toContain("★");
	await click(trigger);
	// cli 来源同样按 effective 匹配打标识，且给出覆盖说明。
	expect(document.body.textContent).toContain("--model 启动参数指定");
	expect(star("DeepSeek Flash", "取消默认")).not.toBeNull();
	expect(star("DeepSeek Pro", "设为默认")).not.toBeNull();

	// 保存另一模型：调用 set，但订阅回的状态仍是 cli 的 effective（保存值被 --model 压过），标识不动。
	await click(star("DeepSeek Pro", "设为默认"));
	expect(defaultCalls.set).toEqual([{ provider: "deepseek", modelId: "deepseek-v4-pro" }]);
	await act(async () =>
		storeActions.setDefaultModel({
			effective: { provider: "deepseek", modelId: "deepseek-flash" },
			source: "cli",
		}),
	);
	expect(star("DeepSeek Flash", "取消默认")).not.toBeNull();
	expect(star("DeepSeek Pro", "设为默认")).not.toBeNull();
	await picker.unmount();
});
