import type { WireChangeSummary } from "@neko-harness/gateway/contract";
import { type CSSProperties, type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import { usePanelWidth } from "../lib/panel-width.ts";
import { useResource } from "../lib/use-resource.ts";
import { ancestorDirs } from "../lib/workspace.ts";
import { ChangeDetail, ChangesList } from "./changes-list";
import { FileTree } from "./file-tree";
import { FileViewer } from "./file-viewer";
import { ResizeHandle } from "./resize-handle";

type Tab = "files" | "changes";

/**
 * Right-hand, read-only workspace browser. The component stays mounted while closed (and is keyed by session by
 * the page), so tab, expanded directories and the open file survive close/reopen and reset on a session switch.
 * Closing aborts every in-flight request.
 */
export function WorkspacePanel({
	sessionId,
	open,
	onClose,
	changes,
}: {
	sessionId: string;
	open: boolean;
	onClose: () => void;
	changes: WireChangeSummary | undefined;
}) {
	const t = useT();
	const panelWidth = usePanelWidth();
	const api = useCallback(() => appActions.workspace(sessionId), [sessionId]);
	const [tab, setTab] = useState<Tab>("files");
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [openFile, setOpenFile] = useState<string | null>(null);
	const [changeFile, setChangeFile] = useState<string | null>(null);
	const [refresh, setRefresh] = useState(0);
	const revision = changes?.revision ?? 0;
	const ids = useId();
	const tabId = (name: Tab) => `${ids}-tab-${name}`;
	const panelId = `${ids}-panel`;

	const treeVisible = open && tab === "files" && openFile === null;
	const viewerVisible = open && tab === "files" && openFile !== null;
	const listVisible = open && tab === "changes" && changeFile === null;
	const detailVisible = open && tab === "changes" && changeFile !== null;
	// The change list is only read while something on screen needs it, and again when the revision moves.
	const list = useResource("changes", listVisible || viewerVisible, () => api().changes(), revision);

	const closeButton = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLElement>(null);
	const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 1023px)");
		const update = () => setNarrow(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement as HTMLElement | null;
		const siblings =
			narrow && panel.current?.parentElement
				? [...panel.current.parentElement.children].filter(
						(node): node is HTMLElement => node instanceof HTMLElement && node !== panel.current,
					)
				: [];
		const inert = siblings.map((node) => node.inert);
		siblings.forEach((node) => {
			node.inert = true;
		});
		closeButton.current?.focus();
		return () => {
			siblings.forEach((node, index) => {
				node.inert = inert[index]!;
			});
			if (previous?.isConnected) previous.focus();
		};
	}, [open, narrow]);

	// Back from the viewer lands on the tree row of the file that was open.
	const restoreFocus = useRef<string | null>(null);
	useEffect(() => {
		const path = restoreFocus.current;
		if (path === null || openFile !== null || tab !== "files") return;
		restoreFocus.current = null;
		[...(panel.current?.querySelectorAll<HTMLElement>("[role=treeitem][data-path]") ?? [])]
			.find((row) => row.dataset.path === path)
			?.focus();
	}, [openFile, tab]);

	const toggle = (path: string) =>
		setExpanded((previous) => {
			const next = new Set(previous);
			if (!next.delete(path)) next.add(path);
			return next;
		});
	const viewCurrent = (path: string) => {
		setExpanded((previous) => new Set([...previous, ...ancestorDirs(path)]));
		setOpenFile(path);
		setTab("files");
	};
	const selectTab = (next: Tab) => {
		setTab(next);
		document.getElementById(tabId(next))?.focus();
	};
	const onTabKey = (event: KeyboardEvent) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		selectTab(event.key === "ArrowLeft" || event.key === "Home" ? "files" : "changes");
	};

	const fileCount = changes?.files ?? 0;
	const tabClass = (name: Tab) =>
		`focus-neko rounded-t-lg border-b-2 px-3 py-1.5 text-sm ${
			tab === name
				? "border-sakura-500 font-medium text-sakura-900"
				: "border-transparent text-ink-600 hover:bg-sakura-50"
		}`;
	return (
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: Narrow screens explicitly use the dialog role with aria-modal.
		<aside
			ref={panel}
			role={narrow ? "dialog" : "complementary"}
			aria-modal={narrow && open ? true : undefined}
			aria-label={t("common.workspace")}
			data-workspace-panel
			style={{ "--panel-w": `${panelWidth.width}px` } as CSSProperties}
			className={`${open ? "flex" : "hidden"} fixed inset-0 z-30 min-w-0 flex-col border-l border-sakura-200 bg-base lg:relative lg:z-auto lg:w-[var(--panel-w)] lg:max-w-[60vw] lg:shrink-0`}
			onKeyDown={(e) => {
				if (!e.currentTarget.contains(e.target as Node)) return;
				if (e.key === "Tab" && window.innerWidth < 1024) {
					const controls = [
						...e.currentTarget.querySelectorAll<HTMLElement>(
							"button:not([disabled]),a[href],summary,[tabindex='0'],[role=treeitem][tabindex='0']",
						),
					].filter((element) => element.getClientRects().length > 0);
					const first = controls[0],
						last = controls.at(-1);
					if (e.shiftKey && document.activeElement === first) {
						e.preventDefault();
						last?.focus();
					} else if (!e.shiftKey && document.activeElement === last) {
						e.preventDefault();
						first?.focus();
					}
				}
				if (e.key === "Escape") {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<ResizeHandle
				width={panelWidth.width}
				onChange={panelWidth.set}
				onCommit={panelWidth.commit}
				onReset={panelWidth.reset}
			/>
			<div className="flex items-center justify-between border-b border-sakura-200 px-4 py-1.5">
				<strong className="text-sm text-ink-800">{t("common.workspace")}</strong>
				<button
					ref={closeButton}
					type="button"
					className="focus-neko rounded-lg px-2 py-1 text-sm text-ink-600 hover:bg-sakura-50"
					aria-label={t("wspanel.close")}
					onClick={onClose}
				>
					{t("common.close")}
				</button>
			</div>
			<div
				role="tablist"
				aria-label={t("wspanel.views")}
				className="flex shrink-0 gap-1 border-b border-sakura-100 px-2 pt-1"
			>
				<button
					type="button"
					role="tab"
					id={tabId("files")}
					aria-selected={tab === "files"}
					aria-controls={panelId}
					tabIndex={tab === "files" ? 0 : -1}
					className={tabClass("files")}
					onClick={() => setTab("files")}
					onKeyDown={onTabKey}
				>
					{t("wspanel.files")}
				</button>
				<button
					type="button"
					role="tab"
					id={tabId("changes")}
					aria-selected={tab === "changes"}
					aria-controls={panelId}
					tabIndex={tab === "changes" ? 0 : -1}
					className={tabClass("changes")}
					onClick={() => setTab("changes")}
					onKeyDown={onTabKey}
				>
					{t("wspanel.changes", { count: fileCount })}
				</button>
			</div>
			<div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)} className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className={`${tab === "files" && openFile === null ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
					<FileTree
						api={api}
						active={treeVisible}
						version={`${refresh}:${revision}`}
						expanded={expanded}
						selected={openFile}
						onToggle={toggle}
						onOpen={setOpenFile}
						onRefresh={() => setRefresh((value) => value + 1)}
					/>
				</div>
				{tab === "files" && openFile !== null && (
					<FileViewer
						key={openFile}
						api={api}
						path={openFile}
						active={viewerVisible}
						changes={list.data}
						backLabel={t("wspanel.backToTree")}
						onBack={() => {
							restoreFocus.current = openFile;
							setOpenFile(null);
						}}
					/>
				)}
				{tab === "changes" && changeFile === null && (
					<ChangesList
						list={list.data}
						status={list.status}
						error={list.error}
						onRetry={list.reload}
						onSelect={setChangeFile}
					/>
				)}
				{tab === "changes" && changeFile !== null && (
					<ChangeDetail
						key={changeFile}
						api={api}
						path={changeFile}
						active={detailVisible}
						revision={revision}
						outside={list.data?.files.some((file) => file.path === changeFile && file.outside)}
						onBack={() => setChangeFile(null)}
						onView={viewCurrent}
					/>
				)}
			</div>
		</aside>
	);
}
