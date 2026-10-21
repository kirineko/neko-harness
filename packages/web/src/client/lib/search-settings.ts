import { SEARCH_PROVIDERS, type SearchProviderId } from "@neko-harness/core/search-providers";
import type { NekoCredentialState, NekoSearchSettingsState } from "./contract.ts";
import { getT, type PlainKey } from "./i18n/index.ts";

export const SEARCH_NAMES: Record<SearchProviderId, string> = {
	tavily: "Tavily",
	deepseek: "DeepSeek",
};

export type SearchOptionView = {
	value: SearchProviderId;
	label: string;
	description: string;
	selected: boolean;
};

const SOURCES: Record<NekoCredentialState["statuses"][string]["source"], PlainKey> = {
	saved: "search.source.saved",
	environment: "search.source.environment",
	runtime: "search.source.runtime",
	keyless: "search.source.keyless",
	none: "search.source.none",
};

export function searchOptions(
	settings: NekoSearchSettingsState | null,
	credentials: NekoCredentialState | null,
): SearchOptionView[] {
	const t = getT();
	const source = (provider: SearchProviderId) => {
		const status = credentials?.statuses[provider];
		return status ? t(SOURCES[status.source]) : t("common.loading");
	};
	const descriptions: Record<SearchProviderId, string> = {
		tavily: t("search.tavilyDescription", { source: source("tavily") }),
		deepseek: t("search.deepseekDescription", { source: source("deepseek") }),
	};
	return SEARCH_PROVIDERS.map((value) => ({
		value,
		label: SEARCH_NAMES[value],
		description: descriptions[value],
		selected: settings?.selected === value,
	}));
}

/** DeepSeek without a key cannot search; the page points the user to its credential card on the same page. */
export function searchWarning(
	settings: NekoSearchSettingsState | null,
	credentials: NekoCredentialState | null,
): string | null {
	if (settings?.selected === "deepseek" && credentials?.statuses.deepseek?.source === "none")
		return getT()("search.deepseekWarning");
	return null;
}
