import { useState } from "react";
import { diffPathFromSummary } from "../lib/diff-highlight.ts";
import { localizeCoreText } from "../lib/i18n/core-text.ts";
import { type PlainKey, useT } from "../lib/i18n/index.ts";
import { DiffView } from "./diff-view";
import { Icon } from "./primitives";

export type ToolCardProps = {
	name: string;
	summary: string;
	detail: string | null;
	phase: "pending" | "running" | "done";
	isError?: boolean;
	output?: string | null;
	result?: string | null;
	durationMs?: number | null;
	note?: string | null;
	/** 展示型 diff（edit 透传上游 details；write 由参数合成）；无则为 null。 */
	diff?: string | null;
	/** diff 新增行数；无 diff 时为 null。 */
	diffAdded?: number | null;
	/** diff 删除行数；无 diff 时为 null。 */
	diffRemoved?: number | null;
	diffTruncated?: boolean;
};

/* 状态 = 图标 + 色彩双重编码：失败态不止靠边框色差，灰度下仍可辨识 */
const STATUS = {
	pending: {
		label: "tool.status.pending",
		icon: "clock",
		spin: false,
		className: "border-ink-200 bg-ink-100 text-ink-600",
	},
	running: {
		label: "tool.status.running",
		icon: "spinner",
		spin: true,
		className: "border-tianyi-300 bg-tianyi-100 text-tianyi-900",
	},
	doneOk: {
		label: "tool.status.done",
		icon: "check",
		spin: false,
		className: "border-ink-200 bg-ink-50 text-ink-600",
	},
	doneError: {
		label: "tool.status.failed",
		icon: "close",
		spin: false,
		className: "border-2 border-sakura-500 bg-sakura-100 text-sakura-900 font-semibold",
	},
} as const satisfies Record<string, { label: PlainKey; icon: string; spin: boolean; className: string }>;

/** 工具调用卡片：名称、参数摘要、状态徽章；展开看参数详情、代码变更 diff 与输出/结果预览。 */
export function ToolCard(props: ToolCardProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const status = props.phase !== "done" ? STATUS[props.phase] : props.isError ? STATUS.doneError : STATUS.doneOk;
	const duration =
		props.phase === "done" && props.durationMs !== undefined && props.durationMs !== null
			? ` · ${(props.durationMs / 1000).toFixed(1)}s`
			: "";
	const showDiff = expanded && props.diff != null;
	const added = props.diffAdded ?? null;
	const removed = props.diffRemoved ?? null;
	const diffCount =
		added !== null && removed !== null
			? added > 0 && removed > 0
				? `(+${added}/-${removed})`
				: added > 0
					? `(+${added})`
					: removed > 0
						? `(-${removed})`
						: null
			: null;
	// 完整 write diff 可替代 detail；截断时保留原文入口。
	const showDetail = props.detail !== null && !(props.name === "write" && props.diff != null && !props.diffTruncated);
	const hasBody =
		showDetail || props.output != null || props.result != null || props.note != null || props.diff != null;

	return (
		<div className="overflow-hidden rounded-card border border-tianyi-200 bg-surface shadow-soft">
			<button
				type="button"
				aria-expanded={hasBody ? expanded : undefined}
				onClick={() => {
					if (hasBody) setExpanded(!expanded);
				}}
				className="focus-neko flex w-full items-center gap-2 px-3 py-2 text-left"
			>
				<span className="text-tianyi-500">
					<Icon name="bolt" size={14} />
				</span>
				<span className="font-mono text-sm font-semibold text-tianyi-800">{props.name}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-600">
					{props.summary}
					{diffCount !== null && <span className="text-ink-400"> {diffCount}</span>}
				</span>
				<span
					className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${status.className}`}
				>
					<Icon name={status.icon} size={12} className={status.spin ? "animate-spin" : undefined} />
					{t(status.label)}
					{duration}
				</span>
				{hasBody && (
					<span aria-hidden className="shrink-0 text-ink-400">
						{expanded ? "▾" : "▸"}
					</span>
				)}
			</button>
			{expanded && (
				<div className="space-y-2 border-t border-tianyi-100 px-3 py-2">
					{showDiff && props.diff != null && (
						<div>
							<div className="mb-1 text-xs font-medium text-tianyi-700">{t("tool.diff")}</div>
							{props.diffTruncated && <div className="mb-1 text-xs text-ink-600">{t("tool.diffTruncated")}</div>}
							{/* diff 按行渲染：语法高亮 + 增删底色两层着色；语言从摘要中的目标路径推断。 */}
							<DiffView
								diff={props.diff}
								path={diffPathFromSummary(props.name, props.summary)}
								format={props.name === "write" ? "write" : "edit"}
								className="max-h-48 overflow-auto rounded-lg bg-ink-50 p-2 font-mono text-xs text-ink-700"
							/>
						</div>
					)}
					{showDetail && (
						<div>
							{props.name === "write" && props.diffTruncated && (
								<div className="mb-1 text-xs font-medium text-tianyi-700">{t("tool.fullWrite")}</div>
							)}
							<pre className="max-h-48 overflow-auto rounded-lg bg-ink-50 p-2 font-mono text-xs text-ink-700">
								{props.detail}
							</pre>
						</div>
					)}
					{props.output != null && props.output !== "" && (
						<div>
							<div className="mb-1 text-xs font-medium text-tianyi-700">{t("tool.output")}</div>
							<pre className="max-h-48 overflow-auto rounded-lg bg-tianyi-50 p-2 font-mono text-xs text-ink-700">
								{props.output}
							</pre>
						</div>
					)}
					{props.result != null && props.result !== "" && (
						<div>
							<div className={`mb-1 text-xs font-medium ${props.isError ? "text-sakura-800" : "text-ink-600"}`}>
								{props.isError ? t("tool.errorOutput") : t("tool.result")}
							</div>
							<pre
								className={`max-h-48 overflow-auto rounded-lg p-2 font-mono text-xs ${
									props.isError ? "bg-sakura-50 text-sakura-900" : "bg-ink-50 text-ink-700"
								}`}
							>
								{props.result}
							</pre>
						</div>
					)}
					{props.note != null && <div className="text-xs italic text-ink-500">{localizeCoreText(props.note, t)}</div>}
				</div>
			)}
		</div>
	);
}
