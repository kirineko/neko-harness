import { JSDOM } from "jsdom";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { NekoCredentialState, NekoSearchSettingsState } from "../src/client/lib/contract.ts";
import { searchOptions, searchWarning } from "../src/client/lib/search-settings.ts";
import { getState, storeActions } from "../src/client/lib/store.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { act } = React;
const { SearchServiceCard } = await import("../src/client/components/search-service-card.tsx");

const status = (source: NekoCredentialState["statuses"]["deepseek"]["source"]) => ({
	savedConfigured: source === "saved",
	environmentConfigured: source === "environment",
	source,
});
const credentials = (deepseek: NekoCredentialState["statuses"]["deepseek"]["source"]): NekoCredentialState => ({
	revision: 1,
	statuses: { deepseek: status(deepseek), tavily: status("keyless") },
});
const settings = (selected: NekoSearchSettingsState["selected"], revision = 1): NekoSearchSettingsState => ({
	revision,
	selected,
});

type Props = React.ComponentProps<typeof SearchServiceCard>;
async function mount(props: Props) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(SearchServiceCard, props)));
	return {
		host,
		rerender: (next: Props) => act(async () => root.render(React.createElement(SearchServiceCard, next))),
		unmount: () => act(async () => root.unmount()),
	};
}
const radio = (host: HTMLElement, value: string) => host.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;

it("derives option state and the missing-key warning", () => {
	const options = searchOptions(settings("tavily"), credentials("none"));
	expect(options.map((option) => [option.value, option.selected])).toEqual([
		["tavily", true],
		["deepseek", false],
	]);
	expect(searchWarning(settings("tavily"), credentials("none"))).toBeNull();
	expect(searchWarning(settings("deepseek"), credentials("none"))).toContain("DeepSeek");
	expect(searchWarning(settings("deepseek"), credentials("saved"))).toBeNull();
	expect(searchOptions(null, null).every((option) => !option.selected)).toBe(true);
});

it("renders only the two providers with the current one selected and no auto option", () => {
	const html = renderToStaticMarkup(
		React.createElement(SearchServiceCard, {
			settings: settings("tavily"),
			credentials: credentials("none"),
			ready: true,
			onSelect: async () => {},
		}),
	);
	expect(html).toContain("当前使用：Tavily");
	expect(html).toMatch(/value="tavily"[^>]*checked|checked[^>]*value="tavily"/);
	expect(html).toContain("keyless 限流");
	expect(html).not.toContain('value="auto"');
});

it("saves a changed selection once and reports success", async () => {
	const calls: string[] = [];
	const view = await mount({
		settings: settings("tavily"),
		credentials: credentials("saved"),
		ready: true,
		onSelect: async (provider) => {
			calls.push(provider);
		},
	});
	await act(async () => radio(view.host, "deepseek").click());
	expect(calls).toEqual(["deepseek"]);
	expect(view.host.textContent).toContain("已切换为DeepSeek");
	await act(async () => radio(view.host, "tavily").click());
	expect(calls).toEqual(["deepseek"]);
	await view.unmount();
});

it("blocks duplicate submissions while saving and shows a retryable error on failure", async () => {
	let release!: () => void;
	let attempts = 0;
	const view = await mount({
		settings: settings("tavily"),
		credentials: credentials("saved"),
		ready: true,
		onSelect: () => {
			attempts++;
			return new Promise<void>((_resolve, reject) => {
				release = () => reject(new Error("offline"));
			});
		},
	});
	await act(async () => radio(view.host, "deepseek").click());
	await act(async () => radio(view.host, "deepseek").click());
	expect(attempts).toBe(1);
	expect(view.host.querySelector("fieldset")!.disabled).toBe(true);
	await act(async () => release());
	expect(view.host.textContent).toContain("保存失败");
	expect(view.host.textContent).not.toContain("已切换");
	expect(radio(view.host, "tavily").checked).toBe(true);
	expect(view.host.querySelector("fieldset")!.disabled).toBe(false);
	await view.unmount();
});

it("follows server state and warns when DeepSeek is selected without a key", async () => {
	const props: Props = {
		settings: settings("tavily"),
		credentials: credentials("none"),
		ready: true,
		onSelect: async () => {},
	};
	const view = await mount(props);
	expect(view.host.textContent).not.toContain("尚未配置 DeepSeek 密钥");
	await view.rerender({ ...props, settings: settings("deepseek", 2) });
	expect(view.host.textContent).toContain("尚未配置 DeepSeek 密钥");
	expect(view.host.querySelector('a[href="/settings#credential-deepseek"]')).toBeNull();
	expect(view.host.textContent).toContain("下方 DeepSeek 卡片");
	await view.rerender({ ...props, settings: settings("deepseek", 2), credentials: credentials("saved") });
	expect(view.host.textContent).not.toContain("尚未配置 DeepSeek 密钥");
	await view.rerender({ ...props, settings: null, ready: false });
	expect(view.host.querySelector("fieldset")!.disabled).toBe(true);
	await view.unmount();
});

it("ignores stale search settings revisions in the store", () => {
	storeActions.setSearchSettings(settings("tavily", 5));
	storeActions.setSearchSettings(settings("deepseek", 4));
	expect(getState().searchSettings?.selected).toBe("tavily");
	storeActions.setSearchSettings(null);
	expect(getState().searchSettings).toBeNull();
});

it("delivers search settings through the gateway connection and saves a selection", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fauxProvider } = await import("../../../test/faux.ts");
	const { startGateway } = await import("../../gateway/src/gateway.ts");
	const { waitFor } = await import("../../gateway/test/helpers.ts");
	const { GatewayConnection } = await import("../src/client/lib/gateway.ts");
	const dir = await mkdtemp(join(tmpdir(), "neko-web-search-"));
	const faux = fauxProvider();
	const previous = process.env.DEEPSEEK_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "db.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		port: 0,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	let latest: NekoSearchSettingsState | null = null;
	const connection = new GatewayConnection({
		url: gateway.wsUrl!,
		serverId: gateway.serverId,
		workspaceRoot: dir,
		events: {
			onPhase: () => {},
			onSearchSettings: (value) => {
				latest = value;
			},
			onError: () => {},
			onDirectory: () => {},
			onWorkspaces: () => {},
			onWorkspace: () => {},
			onOperation: () => {},
			onModels: () => {},
			onSessionChange: () => {},
			onView: () => {},
		},
	});
	try {
		await connection.start();
		await waitFor(() => latest !== null, "search settings delivered");
		expect(latest).toMatchObject({ selected: "tavily" });
		await connection.setSearchProvider("deepseek");
		await waitFor(() => (latest as NekoSearchSettingsState | null)?.selected === "deepseek", "selection published");
		expect(await gateway.runtime.searchSettings()).toEqual({ selected: "deepseek" });
		await connection.setSearchProvider("tavily");
		await waitFor(() => (latest as NekoSearchSettingsState | null)?.selected === "tavily", "selection reverted");
	} finally {
		connection.dispose();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
		if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
	}
});
