import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { NekoCredentialState, NekoSearchSettingsState } from "@neko-harness/gateway";
import { PickerPanel } from "../src/components/picker.ts";
import { commands } from "../src/labels.ts";
import { openSearchPanel, searchItems } from "../src/search-ui.ts";
import { setActiveTheme } from "../src/theme/index.ts";

setActiveTheme("light");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (panel: PickerPanel) => panel.render(100).map(stripTerminalSequences).join("\n");

const status = (source: NekoCredentialState["statuses"][string]["source"]) => ({
	savedConfigured: source === "saved",
	environmentConfigured: source === "environment",
	source,
});
const credentials = (
	deepseek: NekoCredentialState["statuses"][string]["source"],
	tavily: NekoCredentialState["statuses"][string]["source"] = "keyless",
): NekoCredentialState => ({ revision: 1, statuses: { deepseek: status(deepseek), tavily: status(tavily) } });
const settings = (selected: NekoSearchSettingsState["selected"], revision = 1): NekoSearchSettingsState => ({
	revision,
	selected,
});

function fakeClient(initialSettings: NekoSearchSettingsState, initialCredentials: NekoCredentialState) {
	const settingsListeners = new Set<(value: NekoSearchSettingsState) => void>();
	const credentialListeners = new Set<(value: NekoCredentialState) => void>();
	const sets: string[] = [];
	const client = {
		searchSettings: {
			state: {
				value: initialSettings as NekoSearchSettingsState | undefined,
				subscribe(listener: (value: NekoSearchSettingsState | undefined) => void) {
					settingsListeners.add(listener as never);
					return () => settingsListeners.delete(listener as never);
				},
			},
			set: async (input: { provider: string }) => {
				sets.push(input.provider);
			},
		},
		credentials: {
			state: {
				value: initialCredentials as NekoCredentialState | undefined,
				subscribe(listener: (value: NekoCredentialState | undefined) => void) {
					credentialListeners.add(listener as never);
					return () => credentialListeners.delete(listener as never);
				},
			},
		},
	};
	return {
		client,
		sets,
		listeners: { settings: settingsListeners, credentials: credentialListeners },
		publishSettings(value: NekoSearchSettingsState) {
			client.searchSettings.state.value = value;
			for (const listener of settingsListeners) listener(value);
		},
		publishCredentials(value: NekoCredentialState) {
			client.credentials.state.value = value;
			for (const listener of credentialListeners) listener(value);
		},
	};
}

it("marks the current provider and points to /login when DeepSeek has no key", () => {
	const items = searchItems(settings("tavily"), credentials("none"));
	expect(items.map((item) => item.value)).toEqual(["tavily", "deepseek"]);
	expect(items[0]!.label).toBe("Tavily (Current)");
	expect(items[0]!.description).toContain("keyless");
	expect(items[1]!.label).toBe("DeepSeek");
	expect(items[1]!.description).toContain("/login");

	const keyed = searchItems(settings("deepseek"), credentials("saved", "saved"));
	expect(keyed[0]!.label).toBe("Tavily");
	expect(keyed[1]!.label).toBe("DeepSeek (Current)");
	expect(keyed[1]!.description).not.toContain("/login");
	expect(searchItems(undefined, credentials("none"))).toEqual([]);
});

it("lists /search in the command completion", () => {
	expect(commands().map((command) => command.name)).toContain("search");
});

it("saves the chosen provider, notifies and closes the panel", async () => {
	const fake = fakeClient(settings("tavily"), credentials("saved"));
	let closed = 0;
	const panel = new PickerPanel(
		() => {},
		() => closed++,
	);
	const messages: string[] = [];
	const stop = openSearchPanel(panel, fake.client, (message) => messages.push(message));
	await tick();
	expect(text(panel)).toContain("Tavily (Current)");
	panel.handleInput("\x1b[B");
	panel.handleInput("\r");
	await tick();
	expect(fake.sets).toEqual(["deepseek"]);
	expect(messages).toEqual(["Web search provider set to DeepSeek."]);
	expect(panel.open).toBe(false);
	expect(closed).toBe(1);
	stop();
	expect(fake.listeners.settings.size + fake.listeners.credentials.size).toBe(0);
});

it("keeps the panel open with a retryable error when saving fails", async () => {
	const fake = fakeClient(settings("tavily"), credentials("saved"));
	fake.client.searchSettings.set = async () => {
		throw new Error("Cannot save search provider.");
	};
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	openSearchPanel(panel, fake.client, () => {});
	await tick();
	panel.handleInput("\x1b[B");
	panel.handleInput("\r");
	await tick();
	expect(panel.open).toBe(true);
	expect(text(panel)).toContain("Cannot save search provider.");
	expect(fake.client.searchSettings.state.value!.selected).toBe("tavily");
});

it("refreshes while open when another client changes the provider or the DeepSeek key", async () => {
	const fake = fakeClient(settings("tavily"), credentials("none"));
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	openSearchPanel(panel, fake.client, () => {});
	await tick();
	panel.handleInput("\x1b[B");
	expect(text(panel)).toContain("No DeepSeek key");
	fake.publishCredentials(credentials("saved"));
	expect(text(panel)).toContain("DeepSeek search and fetch with your DeepSeek API key (saved key)");
	expect(text(panel)).not.toContain("No DeepSeek key");
	fake.publishSettings(settings("deepseek", 2));
	expect(text(panel)).toContain("DeepSeek (Current)");
});

it("always shows the DeepSeek key status and the k hint when the key is missing", () => {
	const missing = searchItems(settings("tavily"), credentials("none"));
	expect(missing[1]!.description).toContain("Press k");
	const env = searchItems(settings("tavily"), credentials("environment"));
	expect(env[1]!.description).toContain("environment variable");
	expect(env[1]!.description).not.toContain("Press k");
});

it("opens the key input of the highlighted provider with k and closes the panel", async () => {
	const fake = fakeClient(settings("tavily"), credentials("none"));
	const opened: string[] = [];
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	openSearchPanel(
		panel,
		fake.client,
		() => {},
		(provider) => opened.push(provider),
	);
	await tick();
	expect(text(panel)).toContain("K Set key");
	panel.handleInput("\x1b[B");
	panel.handleInput("k");
	expect(opened).toEqual(["deepseek"]);
	expect(panel.open).toBe(false);
});

it("does not treat k as a shortcut while filtering", async () => {
	const fake = fakeClient(settings("tavily"), credentials("none"));
	const opened: string[] = [];
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	openSearchPanel(
		panel,
		fake.client,
		() => {},
		(provider) => opened.push(provider),
	);
	await tick();
	panel.handleInput("d");
	panel.handleInput("k");
	expect(opened).toEqual([]);
	expect(panel.open).toBe(true);
});
