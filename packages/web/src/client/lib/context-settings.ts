import type { NekoContextSettingsPatch, NekoContextSettingsState } from "./contract.ts";
import { getT, type PlainKey } from "./i18n/index.ts";

export type ContextGroup = "compaction" | "pruning";
export type ContextSource = "default" | "config" | "saved";
export type ContextUnit = "percent" | "tokens" | "count" | "chars";

export type ContextRow = {
	key: string;
	group: ContextGroup;
	field: string;
	label: PlainKey;
	description: PlainKey;
	unit: ContextUnit;
	/** Preset values shown as one-click chips; a value from the config file that is not among them gets its own chip. */
	presets: readonly number[];
};

export type ContextToggle = { group: ContextGroup; field: "enabled"; key: string };

export const TOGGLES: Record<ContextGroup, ContextToggle> = {
	compaction: { group: "compaction", field: "enabled", key: "compaction.enabled" },
	pruning: { group: "pruning", field: "enabled", key: "pruning.enabled" },
};

export const CONTEXT_ROWS: readonly ContextRow[] = [
	{
		key: "compaction.triggerPercent",
		group: "compaction",
		field: "triggerPercent",
		label: "context.row.compactionTrigger.label",
		description: "context.row.compactionTrigger.description",
		unit: "percent",
		presets: [30, 40, 50, 60, 70, 80],
	},
	{
		key: "compaction.keepRecentTokens",
		group: "compaction",
		field: "keepRecentTokens",
		label: "context.row.keepRecentTokens.label",
		description: "context.row.keepRecentTokens.description",
		unit: "tokens",
		presets: [10_000, 20_000, 40_000, 80_000],
	},
	{
		key: "pruning.triggerPercent",
		group: "pruning",
		field: "triggerPercent",
		label: "context.row.pruningTrigger.label",
		description: "context.row.pruningTrigger.description",
		unit: "percent",
		presets: [20, 30, 35, 45, 55],
	},
	{
		key: "pruning.keepRecent",
		group: "pruning",
		field: "keepRecent",
		label: "context.row.keepRecent.label",
		description: "context.row.keepRecent.description",
		unit: "count",
		presets: [5, 10, 20, 40],
	},
	{
		key: "pruning.minChars",
		group: "pruning",
		field: "minChars",
		label: "context.row.minChars.label",
		description: "context.row.minChars.description",
		unit: "chars",
		presets: [2_000, 4_000, 8_000, 16_000],
	},
	{
		key: "pruning.minSavePercent",
		group: "pruning",
		field: "minSavePercent",
		label: "context.row.minSave.label",
		description: "context.row.minSave.description",
		unit: "percent",
		presets: [2, 5, 10, 15],
	},
];

export const SOURCE_LABELS: Record<ContextSource, PlainKey> = {
	default: "context.source.default",
	config: "context.source.config",
	saved: "context.source.saved",
};

type Values = Record<string, boolean | number | null>;
type Sources = Record<string, ContextSource>;

export function readSetting(
	state: NekoContextSettingsState,
	item: { group: ContextGroup; field: string },
): { value: boolean | number | null; source: ContextSource } {
	const effective = state.effective[item.group] as Values;
	const sources = state.sources[item.group] as Sources;
	return { value: effective[item.field] ?? null, source: sources[item.field] ?? "default" };
}

export function formatValue(unit: ContextUnit, value: number): string {
	const t = getT();
	switch (unit) {
		case "percent":
			return `${value}%`;
		case "tokens":
			return value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
		case "chars":
			return value >= 1000
				? t("context.value.charsK", { value: Number((value / 1000).toFixed(1)) })
				: t("context.value.chars", { value });
		default:
			return t("context.value.count", { value });
	}
}

export type ChipView = { id: string; label: string; value: number | null; selected: boolean };

/** One-click options: "默认" clears the saved value, then the presets, then a chip for an off-preset current value. */
export function chipsFor(row: ContextRow, state: NekoContextSettingsState): ChipView[] {
	const t = getT();
	const { value, source } = readSetting(state, row);
	const current = typeof value === "number" ? value : null;
	const chips: ChipView[] = [
		{ id: "default", label: t("context.chipDefault"), value: null, selected: source !== "saved" },
	];
	for (const preset of row.presets)
		chips.push({
			id: String(preset),
			label: formatValue(row.unit, preset),
			value: preset,
			selected: source === "saved" && current === preset,
		});
	if (current !== null && source !== "default" && !row.presets.includes(current))
		chips.push({
			id: `custom-${current}`,
			label: t("context.chipCustom", { value: formatValue(row.unit, current) }),
			value: current,
			selected: source === "saved",
		});
	return chips;
}

export function describeCurrent(row: ContextRow, state: NekoContextSettingsState): string {
	const t = getT();
	const { value, source } = readSetting(state, row);
	const shown = typeof value === "number" ? formatValue(row.unit, value) : t("context.nearLimit");
	return t("context.current", { value: shown, source: t(SOURCE_LABELS[source]) });
}

export function patchFor(
	item: { group: ContextGroup; field: string },
	value: boolean | number | null,
): NekoContextSettingsPatch {
	return { [item.group]: { [item.field]: value } } as NekoContextSettingsPatch;
}

export type Marker = { id: "compaction" | "pruning"; label: string; percent: number; native: boolean };

/** Where each automatic step fires on a 0-100% context window, for the threshold bar. */
export function markers(state: NekoContextSettingsState): Marker[] {
	const t = getT();
	const out: Marker[] = [];
	const { compaction, pruning } = state.effective;
	if (pruning.enabled)
		out.push({ id: "pruning", label: t("context.marker.pruning"), percent: pruning.triggerPercent, native: false });
	if (compaction.enabled)
		out.push({
			id: "compaction",
			label: t("context.marker.compaction"),
			percent: compaction.triggerPercent ?? 98,
			native: compaction.triggerPercent === null,
		});
	return out;
}
