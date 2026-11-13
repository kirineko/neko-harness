import { JSDOM } from "jsdom";
import * as React from "react";
import { expect, it } from "vitest";
import { CONTEXT_ROWS, chipsFor, markers, readSetting } from "../src/client/lib/context-settings.ts";
import type { NekoContextSettingsPatch, NekoContextSettingsState } from "../src/client/lib/contract.ts";
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
const { ContextSettingsPanel } = await import("../src/client/components/context-settings-panel.tsx");

function state(
	patch: {
		effective?: Partial<NekoContextSettingsState["effective"]>;
		sources?: Partial<NekoContextSettingsState["sources"]>;
	} = {},
	revision = 1,
): NekoContextSettingsState {
	return {
		revision,
		effective: {
			compaction: { enabled: true, triggerPercent: null, keepRecentTokens: 20000 },
			pruning: { enabled: false, triggerPercent: 35, keepRecent: 10, minChars: 4000, minSavePercent: 5 },
			...patch.effective,
		},
		sources: {
			compaction: { enabled: "default", triggerPercent: "default", keepRecentTokens: "default" },
			pruning: {
				enabled: "default",
				triggerPercent: "default",
				keepRecent: "default",
				minChars: "default",
				minSavePercent: "default",
			},
			...patch.sources,
		},
	};
}

type Props = React.ComponentProps<typeof ContextSettingsPanel>;
async function mount(props: Props) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(React.createElement(ContextSettingsPanel, props)));
	return {
		host,
		rerender: (next: Props) => act(async () => root.render(React.createElement(ContextSettingsPanel, next))),
		unmount: () => act(async () => root.unmount()),
	};
}
const chip = (host: HTMLElement, row: string, id: string) =>
	host.querySelector<HTMLButtonElement>(`[data-row="${row}"][data-chip="${id}"]`)!;
const toggle = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const resetButton = (host: HTMLElement) =>
	[...host.querySelectorAll("button")].find((item) => item.textContent === "全部恢复默认")!;
const noop = async () => {};

it("derives chips, current values and threshold markers", () => {
	const row = CONTEXT_ROWS.find((item) => item.key === "compaction.triggerPercent")!;
	const fresh = chipsFor(row, state());
	expect(fresh.map((item) => item.label)).toEqual(["默认", "30%", "40%", "50%", "60%", "70%", "80%"]);
	expect(fresh.filter((item) => item.selected).map((item) => item.id)).toEqual(["default"]);
	expect(readSetting(state(), row)).toEqual({ value: null, source: "default" });

	const custom = state({
		effective: { compaction: { enabled: true, triggerPercent: 55, keepRecentTokens: 20000 } },
		sources: { compaction: { enabled: "default", triggerPercent: "saved", keepRecentTokens: "default" } },
	});
	const chips = chipsFor(row, custom);
	expect(chips.at(-1)).toMatchObject({ label: "55% · 自定义", selected: true });
	expect(chips[0]!.selected).toBe(false);

	expect(markers(state())).toEqual([{ id: "compaction", label: "压缩", percent: 98, native: true }]);
	const both = markers(
		state({
			effective: { pruning: { enabled: true, triggerPercent: 20, keepRecent: 10, minChars: 4000, minSavePercent: 5 } },
		}),
	);
	expect(both.map((item) => [item.id, item.percent])).toEqual([
		["pruning", 20],
		["compaction", 98],
	]);
});

it("renders defaults with no text inputs and a disabled reset", async () => {
	const view = await mount({ settings: state(), ready: true, onChange: noop, onReset: noop });
	expect(view.host.querySelector("input")).toBeNull();
	expect(toggle(view.host, "自动压缩").getAttribute("aria-checked")).toBe("true");
	expect(toggle(view.host, "裁剪工具结果").getAttribute("aria-checked")).toBe("false");
	expect(chip(view.host, "compaction.triggerPercent", "default").getAttribute("aria-pressed")).toBe("true");
	expect(view.host.textContent).toContain("当前生效 接近窗口上限 · 默认");
	expect(resetButton(view.host).disabled).toBe(true);
	await view.rerender({ settings: null, ready: false, onChange: noop, onReset: noop });
	expect(view.host.textContent).toContain("读取中");
	await view.unmount();
});

it("saves a chip with one click, clears with 默认, and toggles switches", async () => {
	const patches: NekoContextSettingsPatch[] = [];
	const props: Props = {
		settings: state(),
		ready: true,
		onChange: async (patch) => {
			patches.push(patch);
		},
		onReset: noop,
	};
	const view = await mount(props);
	await act(async () => chip(view.host, "compaction.triggerPercent", "50").click());
	expect(patches).toEqual([{ compaction: { triggerPercent: 50 } }]);
	expect(view.host.textContent).toContain("已保存");

	await act(async () => toggle(view.host, "裁剪工具结果").click());
	expect(patches[1]).toEqual({ pruning: { enabled: true } });

	await view.rerender({
		...props,
		settings: state(
			{
				effective: { compaction: { enabled: true, triggerPercent: 50, keepRecentTokens: 20000 } },
				sources: { compaction: { enabled: "default", triggerPercent: "saved", keepRecentTokens: "default" } },
			},
			2,
		),
	});
	expect(chip(view.host, "compaction.triggerPercent", "50").getAttribute("aria-pressed")).toBe("true");
	await act(async () => chip(view.host, "compaction.triggerPercent", "default").click());
	expect(patches[2]).toEqual({ compaction: { triggerPercent: null } });
	expect(view.host.textContent).toContain("已恢复默认");
	await view.unmount();
});

it("resets everything once something is saved", async () => {
	let resets = 0;
	const view = await mount({
		settings: state({
			sources: {
				pruning: {
					enabled: "saved",
					triggerPercent: "default",
					keepRecent: "default",
					minChars: "default",
					minSavePercent: "default",
				},
			},
		}),
		ready: true,
		onChange: noop,
		onReset: async () => {
			resets++;
		},
	});
	expect(resetButton(view.host).disabled).toBe(false);
	await act(async () => resetButton(view.host).click());
	expect(resets).toBe(1);
	expect(view.host.textContent).toContain("已全部恢复默认");
	await view.unmount();
});

it("sends rapid clicks in order and reports a failure without claiming success", async () => {
	const patches: NekoContextSettingsPatch[] = [];
	const fails: (() => void)[] = [];
	const view = await mount({
		settings: state(),
		ready: true,
		onChange: (patch) => {
			patches.push(patch);
			return new Promise<void>((_resolve, reject) => fails.push(() => reject(new Error("offline"))));
		},
		onReset: noop,
	});
	await act(async () => chip(view.host, "pruning.keepRecent", "20").click());
	await act(async () => chip(view.host, "pruning.keepRecent", "40").click());
	expect(patches).toEqual([{ pruning: { keepRecent: 20 } }, { pruning: { keepRecent: 40 } }]);
	expect(view.host.textContent).toContain("保存中");
	await act(async () => {
		for (const fail of fails) fail();
	});
	expect(view.host.textContent).toContain("保存失败");
	expect(view.host.textContent).not.toContain("已保存");
	await view.unmount();
});

it("ignores stale context settings revisions in the store", () => {
	storeActions.setContextSettings(state({}, 5));
	storeActions.setContextSettings(state({}, 4));
	expect(getState().contextSettings?.revision).toBe(5);
	storeActions.setContextSettings(null);
	expect(getState().contextSettings).toBeNull();
});

it("delivers context settings through the gateway connection and saves changes", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fauxProvider } = await import("../../../test/faux.ts");
	const { startGateway } = await import("../../gateway/src/gateway.ts");
	const { waitFor } = await import("../../gateway/test/helpers.ts");
	const { GatewayConnection } = await import("../src/client/lib/gateway.ts");
	const dir = await mkdtemp(join(tmpdir(), "neko-web-context-"));
	const faux = fauxProvider();
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "db.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		port: 0,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	let latest: NekoContextSettingsState | null = null;
	const connection = new GatewayConnection({
		url: gateway.wsUrl!,
		serverId: gateway.serverId,
		workspaceRoot: dir,
		events: {
			onPhase: () => {},
			onContextSettings: (value) => {
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
	const current = () => latest as NekoContextSettingsState | null;
	try {
		await connection.start();
		await waitFor(() => latest !== null, "context settings delivered");
		expect(current()!.sources.pruning.enabled).toBe("default");
		await connection.setContextSettings({ pruning: { enabled: true }, compaction: { triggerPercent: 60 } });
		await waitFor(() => current()?.effective.pruning.enabled === true, "change published");
		expect((await gateway.runtime.contextSettings()).effective.compaction.triggerPercent).toBe(60);
		await connection.resetContextSettings();
		await waitFor(() => current()?.sources.pruning.enabled === "default", "reset published");
	} finally {
		connection.dispose();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
