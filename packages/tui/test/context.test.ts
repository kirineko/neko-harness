import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { NekoContextSettingsPatch, NekoContextSettingsState } from "@neko-harness/gateway";
import { PickerPanel } from "../src/components/picker.ts";
import { contextItems, openContextPanel } from "../src/context-ui.ts";
import { commands } from "../src/labels.ts";
import { setActiveTheme } from "../src/theme/index.ts";

setActiveTheme("light");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (panel: PickerPanel) => panel.render(100).map(stripTerminalSequences).join("\n");
const DOWN = "\x1b[B";
const ESC = "\x1b";

function state(over: Partial<NekoContextSettingsState> = {}, revision = 1): NekoContextSettingsState {
	return {
		revision,
		effective: {
			compaction: { enabled: true, triggerPercent: null, keepRecentTokens: 20000 },
			pruning: { enabled: false, triggerPercent: 35, keepRecent: 10, minChars: 4000, minSavePercent: 5 },
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
		},
		...over,
	};
}

function fakeClient(initial: NekoContextSettingsState) {
	const listeners = new Set<(value: NekoContextSettingsState | undefined) => void>();
	const calls: unknown[] = [];
	const client = {
		contextSettings: {
			state: {
				value: initial as NekoContextSettingsState | undefined,
				subscribe(listener: (value: NekoContextSettingsState | undefined) => void) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			set: async (patch: NekoContextSettingsPatch) => {
				calls.push(patch);
			},
			reset: async () => {
				calls.push("reset");
			},
		},
	};
	return {
		client,
		calls,
		listeners,
		publish(value: NekoContextSettingsState) {
			client.contextSettings.state.value = value;
			for (const listener of listeners) listener(value);
		},
	};
}

const panelFor = () =>
	new PickerPanel(
		() => {},
		() => {},
	);

it("lists settings with values and sources, marking custom values", () => {
	const items = contextItems(
		state({
			effective: {
				compaction: { enabled: true, triggerPercent: 55, keepRecentTokens: 20000 },
				pruning: { enabled: true, triggerPercent: 35, keepRecent: 10, minChars: 4000, minSavePercent: 5 },
			},
			sources: {
				compaction: { enabled: "default", triggerPercent: "saved", keepRecentTokens: "default" },
				pruning: {
					enabled: "config",
					triggerPercent: "default",
					keepRecent: "default",
					minChars: "default",
					minSavePercent: "default",
				},
			},
		}),
	);
	const rows = items.filter((item) => !item.header);
	expect(rows.map((item) => item.label)).toContain("Reset to defaults");
	expect(items.filter((item) => item.header).map((item) => item.label)).toEqual(["Compaction", "Tool result pruning"]);
	expect(rows.find((item) => item.value === "compaction.triggerPercent")!.rightLabel).toBe("55%  Saved · Custom");
	expect(rows.find((item) => item.value === "pruning.enabled")!.rightLabel).toBe("On  Config");
	expect(rows.find((item) => item.value === "compaction.enabled")!.rightLabel).toBe("On  Default");
	expect(contextItems(undefined)).toEqual([]);
	expect(commands().map((command) => command.name)).toContain("context");
});

it("saves a preset, notifies, and returns to the list", async () => {
	const fake = fakeClient(state());
	const panel = panelFor();
	const messages: string[] = [];
	openContextPanel(panel, fake.client, (message) => messages.push(message));
	await tick();
	expect(text(panel)).toContain("Compact at");
	panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	expect(text(panel)).toContain("Compact when context reaches");
	panel.handleInput(DOWN);
	panel.handleInput(DOWN);
	panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	expect(fake.calls).toEqual([{ compaction: { triggerPercent: 50 } }]);
	expect(messages).toEqual(["Compact at set to 50%."]);
	expect(panel.open).toBe(true);
	expect(panel.detailOpen).toBe(false);
});

it("clears a saved value with Default and resets everything", async () => {
	const fake = fakeClient(
		state({
			effective: {
				compaction: { enabled: true, triggerPercent: 60, keepRecentTokens: 20000 },
				pruning: { enabled: false, triggerPercent: 35, keepRecent: 10, minChars: 4000, minSavePercent: 5 },
			},
			sources: {
				compaction: { enabled: "default", triggerPercent: "saved", keepRecentTokens: "default" },
				pruning: {
					enabled: "default",
					triggerPercent: "default",
					keepRecent: "default",
					minChars: "default",
					minSavePercent: "default",
				},
			},
		}),
	);
	const panel = panelFor();
	const messages: string[] = [];
	openContextPanel(panel, fake.client, (message) => messages.push(message));
	await tick();
	text(panel);
	panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	for (let i = 0; i < 10; i++) panel.handleInput("\x1b[A");
	panel.handleInput("\r");
	await tick();
	expect(fake.calls).toEqual([{ compaction: { triggerPercent: null } }]);

	for (let i = 0; i < 10; i++) panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	expect(fake.calls[1]).toBe("reset");
	expect(messages.at(-1)).toBe("Context settings reset to defaults.");
	expect(panel.open).toBe(false);
});

it("keeps the chooser open with an error when saving fails", async () => {
	const fake = fakeClient(state());
	fake.client.contextSettings.set = async () => {
		throw new Error("Cannot save context settings.");
	};
	const panel = panelFor();
	openContextPanel(panel, fake.client, () => {});
	await tick();
	text(panel);
	panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	expect(panel.detailOpen).toBe(true);
	expect(text(panel)).toContain("Cannot save context settings.");
	panel.handleInput(ESC);
	expect(panel.detailOpen).toBe(false);
});

it("refreshes while open when another client changes a setting and stops syncing on close", async () => {
	const fake = fakeClient(state());
	const panel = panelFor();
	const stop = openContextPanel(panel, fake.client, () => {});
	await tick();
	expect(text(panel)).not.toContain("Saved");
	fake.publish(
		state(
			{
				effective: {
					compaction: { enabled: false, triggerPercent: null, keepRecentTokens: 20000 },
					pruning: { enabled: false, triggerPercent: 35, keepRecent: 10, minChars: 4000, minSavePercent: 5 },
				},
				sources: {
					compaction: { enabled: "saved", triggerPercent: "default", keepRecentTokens: "default" },
					pruning: {
						enabled: "default",
						triggerPercent: "default",
						keepRecent: "default",
						minChars: "default",
						minSavePercent: "default",
					},
				},
			},
			2,
		),
	);
	expect(text(panel)).toContain("Off  Saved");
	stop();
	expect(fake.listeners.size).toBe(0);
});

it("documents /context in /help", async () => {
	const { helpLines } = await import("../src/help-ui.ts");
	expect(helpLines().map(stripTerminalSequences).join("\n")).toContain("/context");
});
