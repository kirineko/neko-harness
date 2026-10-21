import { SEARCH_PROVIDERS, type SearchProviderId } from "@neko-harness/core/search-providers";
import type { NekoCredentialState, NekoSearchSettingsState } from "@neko-harness/gateway";
import type { PickerItem, PickerPanel } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { t } from "./i18n/index.ts";

export const searchEmpty = (): string => t("search.empty");

const NAMES: Record<SearchProviderId, string> = { tavily: "Tavily", deepseek: "DeepSeek" };

const sourceLabel = (source: NekoCredentialState["statuses"][string]["source"]): string => {
	switch (source) {
		case "saved":
			return t("search.source.saved");
		case "environment":
			return t("search.source.environment");
		case "runtime":
			return t("search.source.runtime");
		case "keyless":
			return t("search.source.keyless");
		default:
			return t("search.source.none");
	}
};

/** One row per provider; the current choice is marked and the key status explains what it needs. */
export function searchItems(
	settings: NekoSearchSettingsState | undefined,
	credentials: NekoCredentialState | undefined,
): PickerItem[] {
	if (!settings) return [];
	const source = (provider: SearchProviderId) => {
		const status = credentials?.statuses[provider];
		return status ? sourceLabel(status.source) : t("search.source.loading");
	};
	const deepseekMissing = credentials?.statuses.deepseek?.source === "none";
	const descriptions: Record<SearchProviderId, string> = {
		tavily: t("search.tavily", { source: source("tavily") }),
		deepseek: deepseekMissing ? t("search.deepseekMissing") : t("search.deepseek", { source: source("deepseek") }),
	};
	return SEARCH_PROVIDERS.map((value) => ({
		value,
		label: `${NAMES[value]}${settings.selected === value ? t("common.currentSuffix") : ""}`,
		description: descriptions[value],
	}));
}

type SearchClient = {
	readonly searchSettings: {
		readonly state: {
			readonly value: NekoSearchSettingsState | undefined;
			subscribe(listener: (value: NekoSearchSettingsState | undefined) => void): () => void;
		};
		set(input: { provider: SearchProviderId }): Promise<unknown>;
	};
	readonly credentials: {
		readonly state: {
			readonly value: NekoCredentialState | undefined;
			subscribe(listener: (value: NekoCredentialState | undefined) => void): () => void;
		};
	};
};

/**
 * Opens the /search panel and keeps it in sync with the gateway; the returned function stops the sync.
 * `k` (empty filter) closes the panel and hands the highlighted provider to `openKey`, which shows its
 * key input; this panel never collects keys itself.
 */
export function openSearchPanel(
	panel: PickerPanel,
	client: SearchClient,
	notify: (message: string) => void,
	openKey?: (provider: SearchProviderId) => void,
): () => void {
	const items = () => searchItems(client.searchSettings.state.value, client.credentials.state.value);
	const refresh = () => panel.update(items());
	const stops = [client.searchSettings.state.subscribe(refresh), client.credentials.state.subscribe(refresh)];
	panel.emptyText = searchEmpty();
	if (openKey) {
		panel.help = shortcutHints(
			["↑↓", t("action.select")],
			["Enter", t("action.choose")],
			["K", t("action.setKey")],
			["Esc", t("action.close")],
		);
		panel.listKey = (data, value) => {
			if (data.toLowerCase() !== "k" || panel.search.getValue() !== "" || value === undefined) return false;
			if (!(SEARCH_PROVIDERS as readonly string[]).includes(value)) return false;
			panel.close();
			openKey(value as SearchProviderId);
			return true;
		};
	}
	void panel.show(
		t("search.title"),
		async () => items(),
		async (value) => {
			await client.searchSettings.set({ provider: value as SearchProviderId });
			notify(t("search.set", { name: NAMES[value as SearchProviderId] }));
		},
	);
	return () => {
		for (const stop of stops) stop();
	};
}
