import { useRef, useState } from "react";
import {
	CONTEXT_ROWS,
	type ContextGroup,
	type ContextRow,
	chipsFor,
	describeCurrent,
	type Marker,
	markers,
	patchFor,
	readSetting,
	SOURCE_LABELS,
	TOGGLES,
} from "../lib/context-settings";
import type { NekoContextSettingsPatch, NekoContextSettingsState } from "../lib/contract";
import { Icon } from "./primitives";

type Save = (item: { group: ContextGroup; field: string; label: string }, value: boolean | number | null) => void;

const GROUPS: readonly { id: ContextGroup; title: string; blurb: string }[] = [
	{
		id: "compaction",
		title: "上下文压缩",
		blurb: "对话变长时，把较早的内容整理成摘要，腾出空间继续聊。手动 /compact 始终可用。",
	},
	{
		id: "pruning",
		title: "工具结果裁剪",
		blurb:
			"把较早的大段工具输出在模型眼中换成一行说明；界面里的完整结果和历史记录不受影响。每次裁剪会让提示词缓存失效，所以按批量进行。",
	},
];

function Switch(props: { checked: boolean; label: string; disabled: boolean; onChange: (next: boolean) => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={props.checked}
			aria-label={props.label}
			disabled={props.disabled}
			onClick={() => props.onChange(!props.checked)}
			className={`focus-neko relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
				props.checked ? "bg-sakura-500" : "bg-ink-200"
			}`}
		>
			<span
				className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${
					props.checked ? "translate-x-[22px]" : "translate-x-0.5"
				}`}
			/>
		</button>
	);
}

/** Where each automatic step fires along the model window. */
function ThresholdBar({ items }: { items: Marker[] }) {
	return (
		<section className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft" aria-label="触发位置预览">
			<div className="flex items-center justify-between text-xs text-ink-500">
				<span className="font-semibold text-ink-900">触发位置</span>
				<span>模型上下文窗口</span>
			</div>
			<div className="px-6">
				<div className="relative mt-9 mb-9 h-2.5 rounded-full bg-gradient-to-r from-tianyi-100 via-sakura-100 to-sakura-200">
					{items.map((item) => (
						<div
							key={item.id}
							className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
							style={{ left: `${item.percent}%` }}
						>
							<span
								className={`block size-4 rounded-full border-2 border-surface shadow ${
									item.id === "pruning" ? "bg-tianyi-500" : "bg-sakura-600"
								}`}
							/>
							<span
								className={`absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-xs font-semibold ${
									item.id === "pruning" ? "-top-7 text-tianyi-800" : "top-6 text-sakura-800"
								}`}
							>
								{item.label} {item.native ? "≈" : ""}
								{item.percent}%
							</span>
						</div>
					))}
				</div>
			</div>
			<div className="flex justify-between text-[11px] text-ink-400">
				<span>0%</span>
				<span>100%</span>
			</div>
			{items.length === 0 && <p className="mt-2 text-xs text-ink-500">自动压缩与裁剪均已关闭。</p>}
		</section>
	);
}

function ChipRow(props: {
	row: ContextRow;
	settings: NekoContextSettingsState;
	disabled: boolean;
	dim: boolean;
	onPick: (value: number | null) => void;
}) {
	const { row, settings, disabled, dim, onPick } = props;
	const { source } = readSetting(settings, row);
	return (
		<div className={`transition-opacity ${dim ? "opacity-55" : ""}`}>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3">
				<span className="text-sm font-semibold text-ink-900">{row.label}</span>
				<span className="text-xs text-ink-500">{describeCurrent(row, settings)}</span>
			</div>
			<p className="mt-0.5 text-xs text-ink-500">{row.description}</p>
			<fieldset className="m-0 mt-2 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
				<legend className="sr-only">{row.label}</legend>
				{chipsFor(row, settings).map((chip) => (
					<button
						key={chip.id}
						type="button"
						aria-pressed={chip.selected}
						disabled={disabled}
						data-row={row.key}
						data-chip={chip.id}
						onClick={() => !chip.selected && onPick(chip.value)}
						className={`focus-neko rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-60 ${
							chip.selected
								? "border-sakura-400 bg-sakura-100 font-semibold text-sakura-800"
								: "border-sakura-200 bg-surface text-ink-700 hover:bg-sakura-50"
						}`}
					>
						{chip.label}
					</button>
				))}
			</fieldset>
			{source === "config" && <p className="mt-1 text-[11px] text-ink-400">来自配置文件，选择其他档位会覆盖它。</p>}
		</div>
	);
}

export function ContextSettingsPanel(props: {
	settings: NekoContextSettingsState | null;
	ready: boolean;
	onChange: (patch: NekoContextSettingsPatch) => Promise<void>;
	onReset: () => Promise<void>;
}) {
	const { settings, ready, onChange, onReset } = props;
	const [saving, setSaving] = useState(0);
	const [message, setMessage] = useState("");
	const disabled = !ready || !settings;
	const latest = useRef(0);

	// Clicks are never dropped: each save is sent in click order and the gateway applies them in that order.
	async function run(work: () => Promise<void>, done: string) {
		const ticket = ++latest.current;
		setSaving((count) => count + 1);
		setMessage("");
		try {
			await work();
			if (ticket === latest.current) setMessage(done);
		} catch {
			if (ticket === latest.current) setMessage("保存失败，请检查连接后重试。");
		} finally {
			setSaving((count) => count - 1);
		}
	}
	const save: Save = (item, value) =>
		void run(() => onChange(patchFor(item, value)), value === null ? `${item.label}已恢复默认` : "已保存");

	if (!settings) return <p className="text-sm text-ink-500">读取中…</p>;
	const anySaved = [...Object.values(settings.sources.compaction), ...Object.values(settings.sources.pruning)].includes(
		"saved",
	);

	return (
		<div className="flex flex-col gap-4">
			<ThresholdBar items={markers(settings)} />
			{GROUPS.map((group) => {
				const toggle = TOGGLES[group.id];
				const { value: enabled, source } = readSetting(settings, toggle);
				return (
					<section
						key={group.id}
						className="rounded-2xl border border-sakura-200 bg-surface p-5 shadow-soft"
						aria-labelledby={`ctx-${group.id}`}
					>
						<div className="flex items-start gap-3">
							<span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-sakura-50 text-sakura-700">
								<Icon name={group.id === "compaction" ? "layers" : "sparkles"} size={16} />
							</span>
							<div className="min-w-0 flex-1">
								<h2 id={`ctx-${group.id}`} className="text-base font-bold text-ink-900">
									{group.title}
								</h2>
								<p className="mt-0.5 text-xs text-ink-500">{group.blurb}</p>
							</div>
							<div className="flex flex-col items-end gap-1">
								<Switch
									checked={enabled === true}
									label={group.id === "compaction" ? "自动压缩" : "裁剪工具结果"}
									disabled={disabled}
									onChange={(next) => save({ ...toggle, label: group.title }, next)}
								/>
								<span className="text-[11px] text-ink-400">{SOURCE_LABELS[source]}</span>
							</div>
						</div>
						<div className="mt-4 flex flex-col gap-4 border-t border-sakura-100 pt-4">
							{CONTEXT_ROWS.filter((row) => row.group === group.id).map((row) => (
								<ChipRow
									key={row.key}
									row={row}
									settings={settings}
									disabled={disabled}
									dim={enabled !== true}
									onPick={(value) => save(row, value)}
								/>
							))}
						</div>
					</section>
				);
			})}
			<div className="flex flex-wrap items-center gap-3">
				<button
					type="button"
					disabled={disabled || !anySaved}
					onClick={() => void run(onReset, "已全部恢复默认")}
					className="focus-neko rounded-full border border-sakura-200 bg-surface px-4 py-1.5 text-xs text-ink-700 hover:bg-sakura-50 disabled:opacity-50"
				>
					全部恢复默认
				</button>
				<output aria-live="polite" className="min-h-4 text-xs text-tianyi-800">
					{saving > 0 ? "保存中…" : message}
				</output>
			</div>
		</div>
	);
}
