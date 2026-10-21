import type { ReactNode } from "react";
import {
	type Appearance,
	type AppearanceStore,
	appearanceStore,
	type ChatFont,
	type ChatLeading,
	type ChatSize,
	type ChatWeight,
	isDefaultAppearance,
	type Theme,
	useAppearance,
} from "../lib/appearance";
import { type PlainKey, type Translate, useT } from "../lib/i18n/index.ts";
import { Markdown } from "./markdown";

const THEME_OPTIONS: readonly { id: Theme; label: PlainKey; blurb: PlainKey }[] = [
	{ id: "sakura", label: "appearance.theme.sakura", blurb: "appearance.theme.sakuraBlurb" },
	{ id: "light", label: "appearance.theme.light", blurb: "appearance.theme.lightBlurb" },
	{ id: "dark", label: "appearance.theme.dark", blurb: "appearance.theme.darkBlurb" },
];

const FONT_OPTIONS: readonly { id: ChatFont; label: PlainKey }[] = [
	{ id: "sans", label: "appearance.font.sans" },
	{ id: "serif", label: "appearance.font.serif" },
	{ id: "mono", label: "appearance.font.mono" },
];

const SIZE_OPTIONS: readonly { id: ChatSize; label: PlainKey }[] = [
	{ id: "13", label: "appearance.size.13" },
	{ id: "14", label: "appearance.size.14" },
	{ id: "16", label: "appearance.size.16" },
	{ id: "18", label: "appearance.size.18" },
];

const WEIGHT_OPTIONS: readonly { id: ChatWeight; label: PlainKey }[] = [
	{ id: "regular", label: "appearance.weight.regular" },
	{ id: "medium", label: "appearance.weight.medium" },
	{ id: "semibold", label: "appearance.weight.semibold" },
];

const LEADING_OPTIONS: readonly { id: ChatLeading; label: PlainKey }[] = [
	{ id: "compact", label: "appearance.leading.compact" },
	{ id: "normal", label: "appearance.leading.normal" },
	{ id: "relaxed", label: "appearance.leading.relaxed" },
];

const sampleAssistant = (t: Translate) =>
	[
		t("appearance.sampleAssistantIntro"),
		"",
		"```ts",
		"function total(items: number[]) {",
		"  return items.reduce((sum, n) => sum + n, 0);",
		"}",
		"```",
		"",
		`- ${t("appearance.sampleItem1")}`,
		`- ${t("appearance.sampleItem2")}`,
	].join("\n");

function Section(props: { id: string; title: string; blurb?: string; children: ReactNode }) {
	return (
		<section
			className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft"
			aria-labelledby={`appearance-${props.id}`}
		>
			<h2 id={`appearance-${props.id}`} className="text-base font-bold text-ink-900">
				{props.title}
			</h2>
			{props.blurb && <p className="mt-0.5 text-xs text-ink-500">{props.blurb}</p>}
			<div className="mt-3">{props.children}</div>
		</section>
	);
}

/** 单选组：原生 radio（键盘方向键与 checked 语义），外观由 label 承担。 */
function ChipGroup<T extends string>(props: {
	name: string;
	label: string;
	hint?: string;
	options: readonly { id: T; label: PlainKey }[];
	value: T;
	onPick: (value: T) => void;
}) {
	const t = useT();
	return (
		<fieldset className="m-0 min-w-0 border-0 p-0">
			<legend className="text-sm font-semibold text-ink-900">{props.label}</legend>
			<div className="mt-2 flex flex-wrap gap-1.5">
				{props.options.map((option) => (
					<label
						key={option.id}
						className={`choice-focus cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors ${
							props.value === option.id
								? "border-sakura-400 bg-sakura-100 font-semibold text-sakura-800"
								: "border-sakura-200 bg-surface text-ink-700 hover:bg-sakura-50"
						}`}
					>
						<input
							type="radio"
							className="sr-only"
							name={props.name}
							value={option.id}
							checked={props.value === option.id}
							onChange={() => props.onPick(option.id)}
						/>
						{t(option.label)}
					</label>
				))}
			</div>
			{props.hint && <p className="mt-1.5 text-[11px] text-ink-400">{props.hint}</p>}
		</fieldset>
	);
}

/** 迷你预览：节点自身写 data-theme，所以无论当前是什么主题都显示该主题的真实配色。 */
function ThemePreview({ theme }: { theme: Theme }) {
	const t = useT();
	return (
		<span data-theme={theme} className="block rounded-xl border border-ink-200 bg-base p-2.5 text-ink-900">
			<span className="flex items-center gap-1.5 pb-2">
				<span className="size-2 rounded-full bg-sakura-500" />
				<span className="size-2 rounded-full bg-tianyi-500" />
				<span className="h-1.5 w-8 rounded-full bg-ink-200" />
			</span>
			<span className="ml-auto block w-3/5 rounded-lg border border-sakura-300 bg-sakura-100 px-2 py-1 text-xs text-sakura-900">
				{t("appearance.previewUser")}
			</span>
			<span className="mt-1.5 block w-4/5 rounded-lg border border-tianyi-200 bg-surface px-2 py-1 text-xs text-ink-900">
				{t("appearance.previewAssistant")}
			</span>
		</span>
	);
}

function ThemePicker(props: { value: Theme; onPick: (value: Theme) => void }) {
	const t = useT();
	return (
		<fieldset className="m-0 min-w-0 border-0 p-0">
			<legend className="sr-only">{t("appearance.theme")}</legend>
			<div className="grid gap-3 sm:grid-cols-3">
				{THEME_OPTIONS.map((option) => {
					const selected = props.value === option.id;
					return (
						<label
							key={option.id}
							className={`choice-focus block cursor-pointer rounded-2xl border-2 p-2 transition-colors ${
								selected ? "border-sakura-500 bg-sakura-50" : "border-sakura-200 hover:bg-sakura-50"
							}`}
						>
							<input
								type="radio"
								className="sr-only"
								name="appearance-theme"
								value={option.id}
								checked={selected}
								onChange={() => props.onPick(option.id)}
							/>
							<ThemePreview theme={option.id} />
							<span className="mt-2 flex items-baseline gap-2 px-1 pb-0.5">
								<span className={`text-sm ${selected ? "font-bold text-sakura-800" : "font-semibold text-ink-900"}`}>
									{t(option.label)}
								</span>
								<span className="text-xs text-ink-500">{t(option.blurb)}</span>
							</span>
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}

export function AppearancePanel({ store = appearanceStore() }: { store?: AppearanceStore }) {
	const appearance: Appearance = useAppearance(store);
	const t = useT();
	return (
		<div className="flex flex-col gap-4">
			<Section id="theme" title={t("appearance.theme")}>
				<ThemePicker value={appearance.theme} onPick={(theme) => store.set({ theme })} />
			</Section>
			<Section id="typography" title={t("appearance.typography")} blurb={t("appearance.typographyBlurb")}>
				<div className="flex flex-col gap-4">
					<ChipGroup
						name="appearance-font"
						label={t("appearance.font")}
						hint={t("appearance.fontHint")}
						options={FONT_OPTIONS}
						value={appearance.font}
						onPick={(font) => store.set({ font })}
					/>
					<ChipGroup
						name="appearance-size"
						label={t("appearance.size")}
						options={SIZE_OPTIONS}
						value={appearance.size}
						onPick={(size) => store.set({ size })}
					/>
					<ChipGroup
						name="appearance-weight"
						label={t("appearance.weight")}
						options={WEIGHT_OPTIONS}
						value={appearance.weight}
						onPick={(weight) => store.set({ weight })}
					/>
					<ChipGroup
						name="appearance-leading"
						label={t("appearance.leading")}
						options={LEADING_OPTIONS}
						value={appearance.leading}
						onPick={(leading) => store.set({ leading })}
					/>
				</div>
			</Section>
			<Section id="preview" title={t("appearance.sample")} blurb={t("appearance.sampleBlurb")}>
				<div className="flex flex-col gap-2 rounded-xl bg-base p-3" data-testid="appearance-sample">
					<div className="bubble-user ml-auto max-w-[85%] px-4 py-2.5 whitespace-pre-wrap">
						{t("appearance.sampleUser")}
					</div>
					<div className="bubble-assistant max-w-full px-4 py-2.5">
						<Markdown text={sampleAssistant(t)} />
					</div>
				</div>
			</Section>
			<div className="flex items-center justify-end gap-3">
				<span className="text-xs text-ink-500">
					{isDefaultAppearance(appearance) ? t("appearance.isDefault") : t("appearance.customized")}
				</span>
				<button
					type="button"
					onClick={() => store.reset()}
					disabled={isDefaultAppearance(appearance)}
					className="btn-primary focus-neko h-9 rounded-full px-4 text-sm disabled:opacity-50"
				>
					{t("appearance.reset")}
				</button>
			</div>
		</div>
	);
}
