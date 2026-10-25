import type { CodemodeCallView, CodemodeView } from "@neko-harness/core";
import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import { renderCodeHtml } from "../lib/highlight.ts";
import { localizeCoreText } from "../lib/i18n/core-text.ts";
import { type PlainKey, useT } from "../lib/i18n/index.ts";
import { Icon } from "./primitives";
import { ToolCard, type ToolCardProps, toolStatus } from "./tool-card";

export type CodemodeCardProps = ToolCardProps & { codemode: CodemodeView };

const CALL_STATUS = {
	running: { label: "codemode.call.running", icon: "spinner", className: "text-tianyi-700" },
	ok: { label: "codemode.call.ok", icon: "check", className: "text-ink-500" },
	error: { label: "codemode.call.error", icon: "close", className: "text-sakura-800" },
	cancelled: { label: "codemode.call.cancelled", icon: "clock", className: "text-ink-500" },
} as const satisfies Record<CodemodeCallView["status"], { label: PlainKey; icon: string; className: string }>;

function Script({ code }: { code: string }) {
	const html = useMemo(
		() => DOMPurify.sanitize(renderCodeHtml(code, "javascript"), { USE_PROFILES: { html: true } }),
		[code],
	);
	return (
		<pre className="max-h-48 overflow-auto rounded-lg bg-ink-50 p-2 font-mono text-xs text-ink-700">
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML went through DOMPurify.sanitize above. */}
			<code dangerouslySetInnerHTML={{ __html: html }} />
		</pre>
	);
}

function CallRow({ call }: { call: CodemodeCallView }) {
	const t = useT();
	const status = CALL_STATUS[call.status];
	return (
		<li className="flex flex-col gap-0.5 py-0.5" data-call-status={call.status}>
			<div className="flex min-w-0 items-center gap-2">
				<span
					className={`inline-flex shrink-0 items-center ${status.className}`}
					role="img"
					aria-label={t(status.label)}
				>
					<Icon name={status.icon} size={12} className={call.status === "running" ? "animate-spin" : undefined} />
				</span>
				<span className="shrink-0 font-semibold text-tianyi-800">{call.name}</span>
				<span className="min-w-0 flex-1 truncate text-ink-600">{call.args}</span>
				{call.durationMs !== null && (
					<span className="shrink-0 text-ink-400">{(call.durationMs / 1000).toFixed(1)}s</span>
				)}
			</div>
			{call.error !== null && <div className="pl-5 text-sakura-800">{call.error}</div>}
		</li>
	);
}

/** codemode 脚本卡片：脚本（高亮）、嵌套工具调用列表、输出与完整输出路径；折叠时不做高亮与消毒。 */
export function CodemodeCard(props: CodemodeCardProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const status = toolStatus(props.phase, props.isError);
	const { calls, omitted, fullOutputPath } = props.codemode;
	const total = calls.length + omitted;
	const duration =
		props.phase === "done" && props.durationMs != null ? ` · ${(props.durationMs / 1000).toFixed(1)}s` : "";
	const hasBody =
		props.detail !== null ||
		total > 0 ||
		props.output != null ||
		props.result != null ||
		props.note != null ||
		fullOutputPath !== null;
	const outputText = props.phase === "done" ? props.result : props.output;

	return (
		<div className="overflow-hidden rounded-card border border-tianyi-200 bg-surface shadow-soft" data-codemode-card>
			<button
				type="button"
				aria-expanded={hasBody ? expanded : undefined}
				onClick={() => {
					if (hasBody) setExpanded(!expanded);
				}}
				className="focus-neko flex w-full items-center gap-2 px-3 py-2 text-left"
			>
				<span className="text-tianyi-500">
					<Icon name="code" size={14} />
				</span>
				<span className="font-mono text-sm font-semibold text-tianyi-800">{props.name}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-600">
					{props.summary}
					{total > 0 && <span className="text-ink-400"> · {t("codemode.card.callCount", { count: total })}</span>}
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
					{props.detail !== null && (
						<div>
							<div className="mb-1 text-xs font-medium text-tianyi-700">{t("codemode.card.script")}</div>
							<Script code={props.detail} />
						</div>
					)}
					{total > 0 && (
						<div>
							<div className="mb-1 text-xs font-medium text-tianyi-700">
								{t("codemode.card.calls", { count: total })}
							</div>
							<ul className="m-0 max-h-48 list-none overflow-auto rounded-lg bg-tianyi-50 p-2 font-mono text-xs">
								{calls.map((call) => (
									<CallRow key={call.id} call={call} />
								))}
								{omitted > 0 && (
									<li className="py-0.5 text-ink-500">{t("codemode.card.omitted", { count: omitted })}</li>
								)}
							</ul>
						</div>
					)}
					{outputText != null && outputText !== "" && (
						<div>
							<div className={`mb-1 text-xs font-medium ${props.isError ? "text-sakura-800" : "text-ink-600"}`}>
								{props.phase !== "done" ? t("tool.output") : props.isError ? t("tool.errorOutput") : t("tool.result")}
							</div>
							<pre
								className={`max-h-48 overflow-auto rounded-lg p-2 font-mono text-xs ${
									props.isError ? "bg-sakura-50 text-sakura-900" : "bg-ink-50 text-ink-700"
								}`}
							>
								{outputText}
							</pre>
						</div>
					)}
					{fullOutputPath !== null && (
						<div className="break-all text-xs text-ink-500">
							{t("codemode.card.fullOutput", { path: fullOutputPath })}
						</div>
					)}
					{props.note != null && <div className="text-xs italic text-ink-500">{localizeCoreText(props.note, t)}</div>}
				</div>
			)}
		</div>
	);
}

/** 带 codemode 数据的工具项用专属卡片，其余（含旧网关的 codemode 项）仍是普通工具卡。 */
export function ToolOrCodemodeCard(props: ToolCardProps & { codemode?: CodemodeView | undefined }) {
	const { codemode, ...rest } = props;
	return codemode ? <CodemodeCard {...rest} codemode={codemode} /> : <ToolCard {...rest} />;
}
