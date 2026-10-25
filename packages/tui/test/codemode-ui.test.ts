import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { NekoCodemodeSettingsState } from "@neko-harness/gateway";
import { codemodeItems, openCodemodePanel } from "../src/codemode-ui.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { commands } from "../src/labels.ts";
import { setActiveTheme } from "../src/theme/index.ts";

setActiveTheme("light");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (panel: PickerPanel) => panel.render(100).map(stripTerminalSequences).join("\n");
const DOWN = "\x1b[B";

const state = (
	mode: NekoCodemodeSettingsState["effective"]["mode"] = "off",
	source: NekoCodemodeSettingsState["source"] = "default",
	revision = 1,
): NekoCodemodeSettingsState => ({ revision, effective: { mode }, source });

function fakeClient(initial: NekoCodemodeSettingsState, failing = false) {
	const listeners = new Set<(value: NekoCodemodeSettingsState | undefined) => void>();
	const calls: unknown[] = [];
	const client = {
		codemodeSettings: {
			state: {
				value: initial as NekoCodemodeSettingsState | undefined,
				subscribe(listener: (value: NekoCodemodeSettingsState | undefined) => void) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
			set: async (input: { mode: string }) => {
				if (failing) throw new Error("offline");
				calls.push(input);
			},
			reset: async () => {
				calls.push("reset");
			},
		},
	};
	return {
		client: client as never,
		calls,
		setValue(value: NekoCodemodeSettingsState | undefined) {
			client.codemodeSettings.state.value = value;
		},
		publish(value: NekoCodemodeSettingsState) {
			client.codemodeSettings.state.value = value;
			for (const listener of listeners) listener(value);
		},
	};
}
const panelFor = () =>
	new PickerPanel(
		() => {},
		() => {},
	);

it("lists the three modes with the effective one and its source, plus a reset row", () => {
	const items = codemodeItems(state("only", "saved"));
	expect(items.map((item) => item.value)).toEqual(["off", "on", "only", "reset"]);
	expect(items.find((item) => item.value === "only")!.rightLabel).toContain("Saved");
	expect(items.find((item) => item.value === "off")!.rightLabel).toBeUndefined();
	expect(codemodeItems(undefined)).toEqual([]);
	expect(commands().map((command) => command.name)).toContain("codemode");
});

it("saves the chosen mode and notifies that it applies to new sessions", async () => {
	const fake = fakeClient(state());
	const panel = panelFor();
	const messages: string[] = [];
	openCodemodePanel(panel, fake.client, (message) => messages.push(message));
	await tick();
	expect(text(panel)).toContain("Codemode settings");
	panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	expect(fake.calls).toEqual([{ mode: "on" }]);
	expect(messages).toEqual(["Codemode set to On. Applies to sessions created afterwards."]);
});

it("resets the saved mode and follows state published by another client", async () => {
	const fake = fakeClient(state("on", "saved"));
	const panel = panelFor();
	const messages: string[] = [];
	const stop = openCodemodePanel(panel, fake.client, (message) => messages.push(message));
	await tick();
	fake.publish(state("only", "saved", 2));
	expect(text(panel)).toContain("Only codemode");
	for (let i = 0; i < 3; i++) panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	expect(fake.calls).toEqual(["reset"]);
	expect(messages).toEqual(["Codemode reset to default. Applies to sessions created afterwards."]);
	stop();
});

it("shows the empty text until the state arrives and keeps the panel open when saving fails", async () => {
	const missing = panelFor();
	const idle = fakeClient(state());
	idle.setValue(undefined);
	openCodemodePanel(missing, idle.client, () => {});
	await tick();
	expect(text(missing)).toContain("Codemode settings are unavailable.");

	const fake = fakeClient(state(), true);
	const panel = panelFor();
	const messages: string[] = [];
	openCodemodePanel(panel, fake.client, (message) => messages.push(message));
	await tick();
	panel.handleInput(DOWN);
	panel.handleInput("\r");
	await tick();
	expect(messages).toEqual([]);
	expect(panel.open).toBe(true);
});
