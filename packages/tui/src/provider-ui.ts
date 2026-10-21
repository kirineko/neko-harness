import { CREDENTIAL_PROVIDERS, MODEL_PROVIDERS, type NekoModelRef, type NekoSelectableModel } from "@neko-harness/core";
import type { NekoCredentialState, NekoDefaultModelState } from "@neko-harness/gateway";
import type { PickerItem, PickerPanel } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { formatTokens } from "./format.ts";
import { t } from "./i18n/index.ts";

export const modelKey = (model: { provider: string; modelId: string }): string => `${model.provider}/${model.modelId}`;

export const providerName = (id: string): string => CREDENTIAL_PROVIDERS.find((spec) => spec.id === id)?.name ?? id;

/** The gateway rejects sends with these prefixes when the current provider is disabled or has no key. */
export const isProviderRejection = (message: string): boolean =>
	/^(PROVIDER_KEY_REQUIRED|PROVIDER_DISABLED):/.test(message);

/** Client-side mirror of the gateway check so the draft is kept and the user gets a pointer to /login. */
export function providerSendBlock(
	model: { provider: string } | null | undefined,
	credentials: NekoCredentialState | undefined,
): string | undefined {
	const status = model ? credentials?.statuses[model.provider] : undefined;
	if (!model || !status) return undefined;
	const name = providerName(model.provider);
	if (status.enabled === false) return t("provider.disabled", { name });
	if (status.source === "none") return t("provider.configure", { name });
	return undefined;
}

/** Why a model row cannot be picked or set as default; shown when Enter/`d` lands on it. */
const needsKeyHint = (provider: string): string => t("provider.needsKeyHint", { name: providerName(provider) });

/**
 * Grouped /model rows: current provider first, then catalog order; models without credentials are not confirmable.
 * `defaultModel` is the resolved model new sessions start with, so the row the `d` key would clear is visible.
 */
export function modelItems(
	models: readonly NekoSelectableModel[],
	current: { provider: string; modelId: string } | null | undefined,
	defaultModel?: { provider: string; modelId: string } | null,
) {
	const currentKey = current ? modelKey(current) : undefined;
	const defaultKey = defaultModel ? modelKey(defaultModel) : undefined;
	const order = new Map<string, number>(MODEL_PROVIDERS.map((spec, index) => [spec.id, index + 1]));
	const rank = (provider: string) => (provider === current?.provider ? 0 : (order.get(provider) ?? order.size + 1));
	const providers = [...new Set(models.map((model) => model.provider))].sort(
		(a, b) => rank(a) - rank(b) || a.localeCompare(b),
	);
	const items: PickerItem[] = [];
	for (const provider of providers) {
		const group = models
			.filter((model) => model.provider === provider)
			.sort(
				(a, b) =>
					Number(modelKey(b) === currentKey) - Number(modelKey(a) === currentKey) || a.name.localeCompare(b.name),
			);
		const name = providerName(provider);
		const available = group.some((model) => model.available);
		items.push({
			value: `header:${provider}`,
			label: `${name}${available ? "" : ` · ${t("provider.needsKey")}`}`,
			header: true,
		});
		for (const model of group) {
			const key = modelKey(model);
			const image = model.input.includes("image");
			const tags = [
				...(key === defaultKey ? [t("provider.default")] : []),
				...(model.available ? [] : [t("provider.needsKey")]),
				formatTokens(model.contextWindow),
				...(model.reasoning ? [t("provider.thinking")] : []),
				...(image ? [t("provider.images")] : []),
			];
			items.push({
				value: key,
				label: `${key}${key === currentKey ? t("common.currentSuffix") : ""}${key === defaultKey ? " ★" : ""}`,
				rightLabel: tags.join(" · "),
				searchText: `${model.name} ${name}`,
				description: `${model.name} | ${t("provider.context", { tokens: formatTokens(model.contextWindow) })}${model.reasoning ? ` | ${t("provider.thinking")}` : ""} | ${image ? t("provider.images") : t("provider.textOnly")}`,
				...(model.available ? {} : { blockedHint: needsKeyHint(provider) }),
			});
		}
	}
	return items;
}

export type ModelPanelClient = {
	readonly models: {
		list(input: null): Promise<readonly NekoSelectableModel[]>;
	};
	readonly defaultModel: {
		readonly state: {
			readonly value: NekoDefaultModelState | undefined;
			subscribe(listener: (value: NekoDefaultModelState | undefined) => void): () => void;
		};
		set(input: NekoModelRef): Promise<unknown>;
		clear(input: null): Promise<unknown>;
	};
};

/**
 * Opens the /model panel. Enter switches the current session's model; `d` toggles the highlighted
 * row as the default for new sessions (set when not the default, clear when it is). Rows without a
 * key are not confirmable: `d` explains and leaves the default untouched. The default marker follows
 * the `neko.default-model` subscription, so changes from the Web UI or another client sync live.
 */
export function openModelPanel(
	panel: PickerPanel,
	client: ModelPanelClient,
	current: NekoModelRef | null | undefined,
	applyModel: (model: NekoSelectableModel) => Promise<void>,
	notify: (message: string) => void,
): () => void {
	let models: readonly NekoSelectableModel[] = [];
	const currentKey = current ? modelKey(current) : null;
	const effectiveDefault = () => client.defaultModel.state.value?.effective ?? null;
	const items = () => modelItems(models, current, effectiveDefault());
	const stop = client.defaultModel.state.subscribe(() => panel.update(items()));
	panel.groupedFilter = true;
	panel.help = shortcutHints(
		["↑↓", t("action.select")],
		["Enter", t("action.open")],
		["D", t("action.toggleDefault")],
		["Esc", t("action.close")],
	);
	panel.listKey = (data, value) => {
		if (data.toLowerCase() !== "d" || panel.search.getValue() !== "" || value === undefined) return false;
		const model = models.find((m) => modelKey(m) === value);
		if (!model) return false;
		if (!model.available) {
			panel.hint = needsKeyHint(model.provider);
			return true;
		}
		const effective = effectiveDefault();
		const toggle =
			effective !== null && modelKey(effective) === value
				? client.defaultModel.clear(null)
				: client.defaultModel.set({ provider: model.provider, modelId: model.modelId });
		void toggle.catch((error) => notify(error instanceof Error ? error.message : String(error)));
		return true;
	};
	void panel.show(
		t("provider.title"),
		async () => {
			models = await client.models.list(null);
			return items();
		},
		async (value) => {
			const selected = models.find((m) => modelKey(m) === value);
			if (selected?.available && value !== currentKey) await applyModel(selected);
		},
	);
	return stop;
}
