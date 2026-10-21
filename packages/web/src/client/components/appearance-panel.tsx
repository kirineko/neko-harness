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
import { Markdown } from "./markdown";

const THEME_OPTIONS: readonly { id: Theme; label: string; blurb: string }[] = [
	{ id: "sakura", label: "樱花", blurb: "蓝粉白浅色，默认" },
	{ id: "light", label: "纸白", blurb: "中性冷灰白，克制" },
	{ id: "dark", label: "夜墨", blurb: "深蓝灰深色，夜间友好" },
];

const FONT_OPTIONS: readonly { id: ChatFont; label: string }[] = [
	{ id: "sans", label: "无衬线" },
	{ id: "serif", label: "衬线" },
	{ id: "mono", label: "等宽" },
];

const SIZE_OPTIONS: readonly { id: ChatSize; label: string }[] = [
	{ id: "13", label: "小 13px" },
	{ id: "14", label: "默认 14px" },
	{ id: "16", label: "大 16px" },
	{ id: "18", label: "特大 18px" },
];

const WEIGHT_OPTIONS: readonly { id: ChatWeight; label: string }[] = [
	{ id: "regular", label: "常规" },
	{ id: "medium", label: "中等" },
	{ id: "semibold", label: "偏粗" },
];

const LEADING_OPTIONS: readonly { id: ChatLeading; label: string }[] = [
	{ id: "compact", label: "紧凑" },
	{ id: "normal", label: "标准" },
	{ id: "relaxed", label: "宽松" },
];

const SAMPLE_USER = "帮我看看这个函数为什么返回了 undefined？";
const SAMPLE_ASSISTANT = [
	"这是一段**示例回答**，用来预览当前排版。行内代码如 `const total = items.length`，下面是代码块：",
	"",
	"```ts",
	"function total(items: number[]) {",
	"  return items.reduce((sum, n) => sum + n, 0);",
	"}",
	"```",
	"",
	"- 列表项一",
	"- 列表项二",
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
	options: readonly { id: T; label: string }[];
	value: T;
	onPick: (value: T) => void;
}) {
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
						{option.label}
					</label>
				))}
			</div>
			{props.hint && <p className="mt-1.5 text-[11px] text-ink-400">{props.hint}</p>}
		</fieldset>
	);
}

/** 迷你预览：节点自身写 data-theme，所以无论当前是什么主题都显示该主题的真实配色。 */
function ThemePreview({ theme }: { theme: Theme }) {
	return (
		<span data-theme={theme} className="block rounded-xl border border-ink-200 bg-base p-2.5 text-ink-900">
			<span className="flex items-center gap-1.5 pb-2">
				<span className="size-2 rounded-full bg-sakura-500" />
				<span className="size-2 rounded-full bg-tianyi-500" />
				<span className="h-1.5 w-8 rounded-full bg-ink-200" />
			</span>
			<span className="ml-auto block w-3/5 rounded-lg border border-sakura-300 bg-sakura-100 px-2 py-1 text-xs text-sakura-900">
				你好
			</span>
			<span className="mt-1.5 block w-4/5 rounded-lg border border-tianyi-200 bg-surface px-2 py-1 text-xs text-ink-900">
				你好，有什么可以帮你？
			</span>
		</span>
	);
}

function ThemePicker(props: { value: Theme; onPick: (value: Theme) => void }) {
	return (
		<fieldset className="m-0 min-w-0 border-0 p-0">
			<legend className="sr-only">主题</legend>
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
									{option.label}
								</span>
								<span className="text-xs text-ink-500">{option.blurb}</span>
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
	return (
		<div className="flex flex-col gap-4">
			<Section id="theme" title="主题">
				<ThemePicker value={appearance.theme} onPick={(theme) => store.set({ theme })} />
			</Section>
			<Section id="typography" title="聊天排版" blurb="只影响聊天里的消息正文与输入框；代码块、工具卡与侧栏保持不变。">
				<div className="flex flex-col gap-4">
					<ChipGroup
						name="appearance-font"
						label="字体"
						hint="使用本机已安装的系统字体，实际效果取决于你的设备；缺少时自动回退。"
						options={FONT_OPTIONS}
						value={appearance.font}
						onPick={(font) => store.set({ font })}
					/>
					<ChipGroup
						name="appearance-size"
						label="字号"
						options={SIZE_OPTIONS}
						value={appearance.size}
						onPick={(size) => store.set({ size })}
					/>
					<ChipGroup
						name="appearance-weight"
						label="字重"
						options={WEIGHT_OPTIONS}
						value={appearance.weight}
						onPick={(weight) => store.set({ weight })}
					/>
					<ChipGroup
						name="appearance-leading"
						label="行高"
						options={LEADING_OPTIONS}
						value={appearance.leading}
						onPick={(leading) => store.set({ leading })}
					/>
				</div>
			</Section>
			<Section id="preview" title="示例" blurb="随上面的选择即时变化。">
				<div className="flex flex-col gap-2 rounded-xl bg-base p-3" data-testid="appearance-sample">
					<div className="bubble-user ml-auto max-w-[85%] px-4 py-2.5 whitespace-pre-wrap">{SAMPLE_USER}</div>
					<div className="bubble-assistant max-w-full px-4 py-2.5">
						<Markdown text={SAMPLE_ASSISTANT} />
					</div>
				</div>
			</Section>
			<div className="flex items-center justify-end gap-3">
				<span className="text-xs text-ink-500">{isDefaultAppearance(appearance) ? "当前为默认外观" : "已自定义"}</span>
				<button
					type="button"
					onClick={() => store.reset()}
					disabled={isDefaultAppearance(appearance)}
					className="btn-primary focus-neko h-9 rounded-full px-4 text-sm disabled:opacity-50"
				>
					恢复默认
				</button>
			</div>
		</div>
	);
}
