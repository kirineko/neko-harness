import type { WireChangeList, WireWorkspaceFile } from "@neko-harness/gateway/contract";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import { languageFromPath } from "../lib/diff-highlight.ts";
import { renderCodeHtml } from "../lib/highlight.ts";
import { useT } from "../lib/i18n/index.ts";
import { useResource } from "../lib/use-resource.ts";
import { formatBytes, isNotFound, lineCount, splitPath } from "../lib/workspace.ts";
import type { WorkspaceApi } from "./file-tree";

/** Beyond this many characters the file is shown as plain text: highlighting 512 KiB blocks the page. */
const HIGHLIGHT_LIMIT = 200_000;

/** Code view zoom, persisted as a percentage so a chosen size survives reloads. */
const ZOOM_KEY = "neko.fileZoom";
const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 10;

const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));

function readZoom(): number {
	try {
		const stored = Number(localStorage.getItem(ZOOM_KEY));
		return Number.isFinite(stored) && stored > 0 ? clampZoom(stored) : 100;
	} catch {
		return 100;
	}
}

function CodeView(props: { file: WireWorkspaceFile; zoom: number; onZoom(delta: number): void }) {
	const t = useT();
	const content = (props.file.content ?? "").replace(/\n$/, "");
	const html = useMemo(() => {
		const language = content.length > HIGHLIGHT_LIMIT ? undefined : languageFromPath(props.file.path);
		return DOMPurify.sanitize(renderCodeHtml(content, language), { USE_PROFILES: { html: true } });
	}, [content, props.file.path]);
	const numbers = useMemo(
		() => Array.from({ length: lineCount(content) }, (_, index) => index + 1).join("\n"),
		[content],
	);
	// Ctrl/Cmd + wheel zooms the code like an editor; React wheel listeners are passive, so bind natively.
	const area = useRef<HTMLElement>(null);
	const onZoom = useRef(props.onZoom);
	onZoom.current = props.onZoom;
	useEffect(() => {
		const el = area.current;
		if (!el) return;
		const wheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			onZoom.current(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, []);
	return (
		<section
			ref={area}
			aria-label={t("viewer.content")}
			data-testid="file-code"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll container must be keyboard focusable to scroll long lines.
			tabIndex={0}
			className="focus-neko min-h-0 flex-1 overflow-auto bg-base"
		>
			<div
				data-testid="file-code-scale"
				className="flex min-w-max font-mono"
				style={{ fontSize: `${(12 * props.zoom) / 100}px`, lineHeight: `${(20 * props.zoom) / 100}px` }}
			>
				<pre
					aria-hidden
					data-testid="file-gutter"
					className="sticky left-0 shrink-0 select-none border-r border-sakura-100 bg-base px-2 py-2 text-right text-ink-400"
				>
					{numbers}
				</pre>
				<pre className="hljs px-3 py-2 whitespace-pre">
					{/* biome-ignore lint/security/noDangerouslySetInnerHtml: the highlighted HTML went through DOMPurify.sanitize above. */}
					<code dangerouslySetInnerHTML={{ __html: html }} />
				</pre>
			</div>
		</section>
	);
}

function Notice(props: { title: string; detail?: string; action?: { label: string; run(): void }; tone?: "error" }) {
	return (
		<div
			role={props.tone === "error" ? "alert" : "status"}
			data-testid="file-notice"
			className="flex flex-col items-start gap-2 p-4 text-sm"
		>
			<p className={`font-medium ${props.tone === "error" ? "text-sakura-800" : "text-ink-800"}`}>{props.title}</p>
			{props.detail && <p className="break-words text-xs text-ink-600">{props.detail}</p>}
			{props.action && (
				<button
					type="button"
					className="focus-neko rounded-lg border border-sakura-300 px-3 py-1 text-xs text-sakura-800 hover:bg-sakura-50"
					onClick={props.action.run}
				>
					{props.action.label}
				</button>
			)}
		</div>
	);
}

/** Read-only file content with line numbers; no editing, saving, creating, deleting or renaming. */
export function FileViewer(props: {
	api: WorkspaceApi;
	path: string;
	active: boolean;
	/** Latest agent change list, used to notice that the open file was modified after it was read. */
	changes: WireChangeList | undefined;
	onBack(): void;
	backLabel: string;
}) {
	const t = useT();
	const file = useResource(props.path, props.active, (signal) => props.api().file(props.path, signal));
	const { name, dir } = splitPath(props.path);
	const back = useRef<HTMLButtonElement>(null);
	useEffect(() => back.current?.focus(), []);

	// A change recorded after the file was read marks the shown content as possibly outdated.
	const seq = props.changes?.files.find((entry) => entry.path === props.path)?.lastSeq ?? 0;
	const known = props.changes !== undefined;
	const baseline = useRef<number | undefined>(undefined);
	const [stale, setStale] = useState(false);
	const loaded = file.data;
	// biome-ignore lint/correctness/useExhaustiveDependencies: A new read (new data object) restarts the comparison.
	useEffect(() => {
		baseline.current = known ? seq : undefined;
		setStale(false);
	}, [loaded]);
	useEffect(() => {
		if (!known) return;
		if (baseline.current === undefined) baseline.current = seq;
		else if (seq > baseline.current) setStale(true);
	}, [known, seq]);

	const [zoom, setZoom] = useState(readZoom);
	useEffect(() => {
		try {
			localStorage.setItem(ZOOM_KEY, String(zoom));
		} catch {
			// Private browsing may deny storage; zoom still works for the session.
		}
	}, [zoom]);
	const adjustZoom = (delta: number) => setZoom((current) => clampZoom(current + delta));
	const zoomButton =
		"focus-neko rounded-lg border border-sakura-300 px-2 py-0.5 text-sakura-800 hover:bg-sakura-50 disabled:opacity-50";

	const data = file.data;
	const notFound = file.status === "error" && !data && isNotFound(file.error);
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="file-viewer">
			<div className="flex shrink-0 flex-col gap-1 border-b border-sakura-100 px-3 py-2 text-xs">
				<div className="flex min-w-0 items-center gap-2">
					<button
						ref={back}
						type="button"
						className="focus-neko shrink-0 rounded-lg border border-sakura-300 px-2 py-0.5 text-sakura-800 hover:bg-sakura-50"
						onClick={props.onBack}
					>
						{props.backLabel}
					</button>
					<strong className="min-w-0 flex-1 truncate text-sm text-ink-800" title={props.path}>
						{name}
					</strong>
					<fieldset aria-label={t("viewer.zoom")} className="flex min-w-0 shrink-0 items-center gap-1">
						<button
							type="button"
							className={zoomButton}
							aria-label={t("viewer.zoomOut")}
							disabled={zoom <= ZOOM_MIN}
							onClick={() => adjustZoom(-ZOOM_STEP)}
						>
							−
						</button>
						<button
							type="button"
							className={`${zoomButton} min-w-12`}
							aria-label={t("viewer.zoomReset")}
							title={t("viewer.zoomResetTitle")}
							disabled={zoom === 100}
							onClick={() => setZoom(100)}
						>
							{zoom}%
						</button>
						<button
							type="button"
							className={zoomButton}
							aria-label={t("viewer.zoomIn")}
							disabled={zoom >= ZOOM_MAX}
							onClick={() => adjustZoom(ZOOM_STEP)}
						>
							+
						</button>
					</fieldset>
					<button
						type="button"
						className="focus-neko shrink-0 rounded-lg border border-sakura-300 px-2 py-0.5 text-sakura-800 hover:bg-sakura-50 disabled:opacity-50"
						aria-label={t("viewer.refreshAria")}
						disabled={file.status === "loading"}
						onClick={file.reload}
					>
						{file.status === "loading" && data ? t("viewer.refreshing") : t("viewer.refresh")}
					</button>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-ink-500">
					<span className="min-w-0 break-all" title={props.path}>
						{dir === "" ? t("viewer.workspaceRoot") : dir}
					</span>
					{data && <span className="shrink-0">{formatBytes(data.size)}</span>}
				</div>
			</div>
			{stale && (
				<output className="flex shrink-0 flex-wrap items-center gap-2 bg-tianyi-50 px-3 py-1.5 text-xs text-tianyi-900">
					<span>{t("viewer.stale")}</span>
					<button
						type="button"
						className="focus-neko rounded-md border border-tianyi-300 px-2 py-0.5"
						onClick={file.reload}
					>
						{t("viewer.reload")}
					</button>
				</output>
			)}
			{notFound ? (
				<Notice
					title={t("viewer.missing")}
					detail={t("viewer.missingDetail")}
					action={{ label: t("common.retry"), run: file.reload }}
				/>
			) : file.status === "error" && !data ? (
				<Notice
					tone="error"
					title={t("viewer.readFailed", { error: file.error ?? "" })}
					action={{ label: t("common.retry"), run: file.reload }}
				/>
			) : !data ? (
				<Notice title={t("common.loadingEllipsis")} />
			) : data.kind === "protected" ? (
				<Notice title={t("viewer.protected")} detail={t("viewer.protectedDetail")} />
			) : data.kind === "binary" ? (
				<Notice title={t("viewer.binary")} detail={t("viewer.binarySize", { size: formatBytes(data.size) })} />
			) : (
				<>
					{file.status === "error" && (
						<div
							role="alert"
							className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-sakura-800"
						>
							<span className="min-w-0 break-words">{t("viewer.refreshFailed", { error: file.error ?? "" })}</span>
							<button
								type="button"
								className="focus-neko rounded-md border border-sakura-300 px-2 py-0.5"
								onClick={file.reload}
							>
								{t("common.retry")}
							</button>
						</div>
					)}
					{data.truncated && (
						<div role="note" className="shrink-0 bg-sakura-50 px-3 py-1.5 text-xs text-sakura-900">
							{t("viewer.truncated", { size: formatBytes(data.size) })}
						</div>
					)}
					<CodeView file={data} zoom={zoom} onZoom={adjustZoom} />
				</>
			)}
		</div>
	);
}
