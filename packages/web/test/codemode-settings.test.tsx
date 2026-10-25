import { expect, it } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import type { NekoCodemodeSettingsState } from "../src/client/lib/contract.ts";
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
const { CodemodeSettingsPanel } = await import("../src/client/components/codemode-settings-panel.tsx");

const state = (
	mode: NekoCodemodeSettingsState["effective"]["mode"] = "off",
	source: NekoCodemodeSettingsState["source"] = "default",
	revision = 1,
): NekoCodemodeSettingsState => ({ revision, effective: { mode }, source });

type Props = React.ComponentProps<typeof CodemodeSettingsPanel>;
const noop = async () => {};
async function mount(props: Props) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(CodemodeSettingsPanel, props)));
	return {
		host,
		rerender: (next: Props) => act(async () => root.render(React.createElement(CodemodeSettingsPanel, next))),
		unmount: () => act(async () => root.unmount()),
	};
}
const radio = (host: HTMLElement, mode: string) =>
	host.querySelector<HTMLInputElement>(`input[name="codemode-mode"][value="${mode}"]`)!;
const resetButton = (host: HTMLElement) =>
	[...host.querySelectorAll("button")].find((item) => item.textContent === "恢复默认")!;

it("shows the effective mode and source and disables reset until something is saved", async () => {
	const view = await mount({ settings: state(), ready: true, onSelect: noop, onReset: noop });
	expect(radio(view.host, "off").checked).toBe(true);
	expect(radio(view.host, "on").checked).toBe(false);
	expect(view.host.textContent).toContain("当前生效：关闭 · 默认");
	expect(view.host.textContent).toContain("只对之后新建的会话生效");
	expect(resetButton(view.host).disabled).toBe(true);

	await view.rerender({ settings: state("only", "config"), ready: true, onSelect: noop, onReset: noop });
	expect(radio(view.host, "only").checked).toBe(true);
	expect(view.host.textContent).toContain("来自配置文件");
	expect(resetButton(view.host).disabled).toBe(true);
	await view.unmount();
});

it("saves the picked mode once and resets a saved value", async () => {
	const picked: string[] = [];
	let resets = 0;
	const props: Props = {
		settings: state(),
		ready: true,
		onSelect: async (mode) => {
			picked.push(mode);
		},
		onReset: async () => {
			resets++;
		},
	};
	const view = await mount(props);
	await act(async () => radio(view.host, "on").click());
	expect(picked).toEqual(["on"]);
	expect(view.host.textContent).toContain("已保存");

	await view.rerender({ ...props, settings: state("on", "saved", 2) });
	await act(async () => radio(view.host, "on").click());
	expect(picked).toEqual(["on"]);
	expect(resetButton(view.host).disabled).toBe(false);
	await act(async () => resetButton(view.host).click());
	expect(resets).toBe(1);
	expect(view.host.textContent).toContain("已恢复默认");
	await view.unmount();
});

it("is disabled until the state arrives and reports a failed save", async () => {
	const view = await mount({ settings: null, ready: false, onSelect: noop, onReset: noop });
	expect(view.host.textContent).toContain("读取中");
	expect(view.host.querySelector("input")).toBeNull();
	await view.rerender({ settings: state(), ready: false, onSelect: noop, onReset: noop });
	expect(radio(view.host, "on").closest("fieldset")!.disabled).toBe(true);
	await view.rerender({
		settings: state(),
		ready: true,
		onSelect: async () => {
			throw new Error("offline");
		},
		onReset: noop,
	});
	await act(async () => radio(view.host, "only").click());
	expect(view.host.textContent).toContain("保存失败");
	expect(view.host.textContent).not.toContain("已保存");
	await view.unmount();
});

it("ignores stale codemode settings revisions in the store", () => {
	storeActions.setCodemodeSettings(state("on", "saved", 5));
	storeActions.setCodemodeSettings(state("off", "default", 4));
	expect(getState().codemodeSettings?.revision).toBe(5);
	storeActions.setCodemodeSettings(null);
	expect(getState().codemodeSettings).toBeNull();
});

it("syncs a change made elsewhere through the gateway connection (selection, reset)", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fauxProvider } = await import("../../../test/faux.ts");
	const { startGateway } = await import("../../gateway/src/gateway.ts");
	const { waitFor } = await import("../../gateway/test/helpers.ts");
	const { GatewayConnection } = await import("../src/client/lib/gateway.ts");
	const dir = await mkdtemp(join(tmpdir(), "neko-web-codemode-"));
	const faux = fauxProvider();
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "db.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		port: 0,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	let latest: NekoCodemodeSettingsState | null = null;
	const open = () =>
		new GatewayConnection({
			url: gateway.wsUrl!,
			serverId: gateway.serverId,
			workspaceRoot: dir,
			events: {
				onPhase: () => {},
				onCodemodeSettings: (value) => {
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
	const first = open();
	const second = open();
	const current = () => latest as NekoCodemodeSettingsState | null;
	try {
		await first.start();
		await second.start();
		await waitFor(() => current() !== null, "codemode settings delivered");
		expect(current()).toMatchObject({ effective: { mode: "off" }, source: "default" });
		await second.setCodemodeMode("on");
		await waitFor(() => current()?.effective.mode === "on", "change published");
		expect((await gateway.runtime.codemodeSettings()).effective.mode).toBe("on");
		await first.resetCodemodeMode();
		await waitFor(() => current()?.source === "default", "reset published");
	} finally {
		first.dispose();
		second.dispose();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
