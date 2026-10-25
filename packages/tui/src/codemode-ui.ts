import { CODEMODE_MODES, type CodemodeMode, isCodemodeMode } from "@neko-harness/core/codemode-mode";
import type { NekoCodemodeSettingsState } from "@neko-harness/gateway";
import type { PickerItem, PickerPanel } from "./components/picker.ts";
import { type PlainKey, t } from "./i18n/index.ts";

export const codemodeEmpty = (): string => t("codemode.empty");

export const CODEMODE_RESET_VALUE = "reset";

const MODE_TEXT: Record<CodemodeMode, { label: PlainKey; description: PlainKey }> = {
	off: { label: "codemode.mode.off", description: "codemode.mode.offDescription" },
	on: { label: "codemode.mode.on", description: "codemode.mode.onDescription" },
	only: { label: "codemode.mode.only", description: "codemode.mode.onlyDescription" },
};
const SOURCES = {
	default: "context.source.default",
	config: "context.source.config",
	saved: "context.source.saved",
} as const;

/** One row per mode (the effective one marked with its source) and a reset row that clears the saved value. */
export function codemodeItems(state: NekoCodemodeSettingsState | undefined): PickerItem[] {
	if (!state) return [];
	const items: PickerItem[] = CODEMODE_MODES.map((mode) => ({
		value: mode,
		label: t(MODE_TEXT[mode].label),
		...(state.effective.mode === mode
			? { rightLabel: `${t("common.currentSuffix").trim()}  ${t(SOURCES[state.source])}` }
			: {}),
		description: t(MODE_TEXT[mode].description),
	}));
	items.push({
		value: CODEMODE_RESET_VALUE,
		label: t("codemode.reset"),
		description: t("codemode.resetDescription"),
	});
	return items;
}

export type CodemodeClient = {
	readonly codemodeSettings: {
		readonly state: {
			readonly value: NekoCodemodeSettingsState | undefined;
			subscribe(listener: (value: NekoCodemodeSettingsState | undefined) => void): () => void;
		};
		set(input: { mode: CodemodeMode }): Promise<unknown>;
		reset(input: Record<string, never>): Promise<unknown>;
	};
};

/** Opens the /codemode panel and keeps it in sync with the gateway; the returned function stops the sync. */
export function openCodemodePanel(
	panel: PickerPanel,
	client: CodemodeClient,
	notify: (message: string) => void,
): () => void {
	const items = () => codemodeItems(client.codemodeSettings.state.value);
	const stop = client.codemodeSettings.state.subscribe(() => panel.update(items()));
	panel.emptyText = codemodeEmpty();
	void panel.show(
		t("codemode.title"),
		async () => items(),
		async (value) => {
			if (value === CODEMODE_RESET_VALUE) {
				await client.codemodeSettings.reset({});
				notify(t("codemode.resetDone"));
				return;
			}
			if (!isCodemodeMode(value)) return;
			await client.codemodeSettings.set({ mode: value });
			notify(t("codemode.setTo", { mode: t(MODE_TEXT[value].label) }));
		},
	);
	return stop;
}
