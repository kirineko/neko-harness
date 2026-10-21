import { matchesKey } from "@earendil-works/pi-tui";
import type { NekoContextSettingsPatch, NekoContextSettingsState } from "@neko-harness/gateway";
import type { PickerDetail, PickerItem, PickerPanel } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { type PlainKey, t } from "./i18n/index.ts";
import { theme } from "./theme/index.ts";

export const contextEmpty = (): string => t("context.empty");

type Kind = "bool" | "percent" | "tokens" | "count" | "chars";
type Row = {
	readonly key: string;
	readonly group: "compaction" | "pruning";
	readonly field: string;
	readonly label: PlainKey;
	readonly kind: Kind;
	readonly description: PlainKey;
	readonly presets: readonly (boolean | number)[];
};

export const CONTEXT_ROWS: readonly Row[] = [
	{
		key: "compaction.enabled",
		group: "compaction",
		field: "enabled",
		label: "context.row.autoCompaction.label",
		kind: "bool",
		description: "context.row.autoCompaction.description",
		presets: [true, false],
	},
	{
		key: "compaction.triggerPercent",
		group: "compaction",
		field: "triggerPercent",
		label: "context.row.compactAt.label",
		kind: "percent",
		description: "context.row.compactAt.description",
		presets: [30, 40, 50, 60, 70, 80],
	},
	{
		key: "compaction.keepRecentTokens",
		group: "compaction",
		field: "keepRecentTokens",
		label: "context.row.keepRecent.label",
		kind: "tokens",
		description: "context.row.keepRecent.description",
		presets: [10_000, 20_000, 40_000, 80_000],
	},
	{
		key: "pruning.enabled",
		group: "pruning",
		field: "enabled",
		label: "context.row.pruneResults.label",
		kind: "bool",
		description: "context.row.pruneResults.description",
		presets: [true, false],
	},
	{
		key: "pruning.triggerPercent",
		group: "pruning",
		field: "triggerPercent",
		label: "context.row.pruneAt.label",
		kind: "percent",
		description: "context.row.pruneAt.description",
		presets: [20, 30, 35, 45, 55],
	},
	{
		key: "pruning.keepRecent",
		group: "pruning",
		field: "keepRecent",
		label: "context.row.keepRecentResults.label",
		kind: "count",
		description: "context.row.keepRecentResults.description",
		presets: [5, 10, 20, 40],
	},
	{
		key: "pruning.minChars",
		group: "pruning",
		field: "minChars",
		label: "context.row.minResultSize.label",
		kind: "chars",
		description: "context.row.minResultSize.description",
		presets: [2000, 4000, 8000, 16000],
	},
	{
		key: "pruning.minSavePercent",
		group: "pruning",
		field: "minSavePercent",
		label: "context.row.minRelease.label",
		kind: "percent",
		description: "context.row.minRelease.description",
		presets: [2, 5, 10, 15],
	},
];

const SOURCES = {
	default: "context.source.default",
	config: "context.source.config",
	saved: "context.source.saved",
} as const;

function format(kind: Kind, value: boolean | number | null): string {
	if (value === null) return t("context.value.default");
	if (typeof value === "boolean") return value ? t("context.value.on") : t("context.value.off");
	switch (kind) {
		case "percent":
			return `${value}%`;
		case "tokens":
			return t("context.value.tokens", { count: value >= 1000 ? `${Math.round(value / 1000)}k` : value });
		case "chars":
			return t("context.value.chars", { count: value >= 1000 ? `${Math.round(value / 1000)}k` : value });
		default:
			return String(value);
	}
}

function read(state: NekoContextSettingsState, row: Row) {
	const effective = state.effective[row.group] as Record<string, boolean | number | null>;
	const sources = state.sources[row.group] as Record<string, keyof typeof SOURCES>;
	return { value: effective[row.field] ?? null, source: sources[row.field] ?? "default" };
}

export const RESET_VALUE = "reset";

/** Settings grouped under headers; each row shows its effective value and where it comes from. */
export function contextItems(state: NekoContextSettingsState | undefined): PickerItem[] {
	if (!state) return [];
	const items: PickerItem[] = [];
	let group = "";
	for (const row of CONTEXT_ROWS) {
		if (row.group !== group) {
			group = row.group;
			items.push({
				value: `header:${group}`,
				label: group === "compaction" ? t("context.group.compaction") : t("context.group.pruning"),
				header: true,
			});
		}
		const { value, source } = read(state, row);
		const custom = source !== "default" && value !== null && !row.presets.includes(value);
		items.push({
			value: row.key,
			label: t(row.label),
			rightLabel: `${format(row.kind, value)}  ${t(SOURCES[source])}${custom ? ` · ${t("context.custom")}` : ""}`,
			description: t(row.description),
		});
	}
	items.push({
		value: RESET_VALUE,
		label: t("context.reset"),
		description: t("context.resetDescription"),
	});
	return items;
}

export type ContextClient = {
	readonly contextSettings: {
		readonly state: {
			readonly value: NekoContextSettingsState | undefined;
			subscribe(listener: (value: NekoContextSettingsState | undefined) => void): () => void;
		};
		set(patch: NekoContextSettingsPatch): Promise<unknown>;
		reset(input: Record<string, never>): Promise<unknown>;
	};
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Preset chooser for one setting; Enter saves, Esc returns to the list. */
class PresetDetail implements PickerDetail {
	get help(): string {
		return shortcutHints(["↑↓", t("action.select")], ["Enter", t("action.save")], ["Esc", t("action.back")]);
	}
	#index = 0;
	#error = "";
	#saving = false;
	readonly #options: readonly (boolean | number | null)[];

	readonly #row: Row;
	readonly #client: ContextClient;
	readonly #panel: PickerPanel;
	readonly #notify: (message: string) => void;
	readonly #changed: () => void;

	constructor(
		row: Row,
		client: ContextClient,
		panel: PickerPanel,
		notify: (message: string) => void,
		changed: () => void,
	) {
		this.#row = row;
		this.#client = client;
		this.#panel = panel;
		this.#notify = notify;
		this.#changed = changed;
		const state = client.contextSettings.state.value;
		const current = state ? read(state, row) : { value: null, source: "default" as const };
		const options: (boolean | number | null)[] = [null, ...row.presets];
		const custom = current.source !== "default" && current.value !== null && !row.presets.includes(current.value);
		if (custom) options.push(current.value);
		this.#options = options;
		this.#index = current.source === "saved" || custom ? Math.max(0, options.indexOf(current.value)) : 0;
	}

	lines(_width: number, height: number): readonly string[] {
		const state = this.#client.contextSettings.state.value;
		const current = state ? read(state, this.#row) : undefined;
		const head = [theme.accent(t(this.#row.label)), theme.dim(t(this.#row.description))];
		if (this.#saving) head.push(t("common.saving"));
		if (this.#error) head.push(theme.error(t("common.error", { message: this.#error })));
		const options = this.#options.map((option, i) => {
			const custom = option !== null && !this.#row.presets.includes(option);
			const text = `${format(this.#row.kind, option)}${custom ? ` (${t("context.custom")})` : ""}${
				option === null && current ? ` - ${t("context.now", { source: t(SOURCES[current.source]) })}` : ""
			}`;
			return i === this.#index ? theme.selection(`❯ ${text}`) : `  ${text}`;
		});
		const count = Math.max(1, height - head.length);
		const start = Math.max(0, Math.min(this.#index - Math.floor(count / 2), options.length - count));
		return [...head, ...options.slice(start, start + count)];
	}

	handleKey(data: string): boolean {
		if (this.#saving) return true;
		if (matchesKey(data, "up")) this.#index = Math.max(0, this.#index - 1);
		else if (matchesKey(data, "down")) this.#index = Math.min(this.#options.length - 1, this.#index + 1);
		else if (matchesKey(data, "enter")) {
			const value = this.#options[this.#index] ?? null;
			this.#saving = true;
			this.#error = "";
			const patch = { [this.#row.group]: { [this.#row.field]: value } } as NekoContextSettingsPatch;
			void this.#client.contextSettings.set(patch).then(
				() => {
					this.#saving = false;
					this.#notify(t("context.setTo", { label: t(this.#row.label), value: format(this.#row.kind, value) }));
					this.#panel.popDetail();
				},
				(error) => {
					this.#saving = false;
					this.#error = message(error);
					this.#changed();
				},
			);
		} else return false;
		return true;
	}
}

/** Opens the /context panel and keeps it in sync with the gateway; the returned function stops the sync. */
export function openContextPanel(
	panel: PickerPanel,
	client: ContextClient,
	notify: (message: string) => void,
): () => void {
	const items = () => contextItems(client.contextSettings.state.value);
	const stop = client.contextSettings.state.subscribe(() => panel.update(items()));
	panel.emptyText = contextEmpty();
	void panel.show(
		t("context.title"),
		async () => items(),
		async (value) => {
			if (value === RESET_VALUE) {
				await client.contextSettings.reset({});
				notify(t("context.resetDone"));
				return;
			}
			const row = CONTEXT_ROWS.find((item) => item.key === value);
			if (!row) return;
			return new PresetDetail(row, client, panel, notify, () => panel.changed());
		},
	);
	return stop;
}
