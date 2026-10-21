import type { ChatView, SubagentSummary } from "@neko-harness/core";
import { downloadImage } from "@neko-harness/core/image-transfer";
import { mergeTranscriptItems } from "@neko-harness/core/transcript-items";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import { useNekoState } from "../lib/store";
import { ImageReaderContext } from "./image-gallery";
import { MessageList } from "./message-list";

function Detail({
	entry,
	active,
	target,
}: {
	entry: SubagentSummary;
	active: boolean;
	target?: { taskId: number; nonce: number };
}) {
	const t = useT();
	const { phase, operating, view: parentView } = useNekoState();
	const [view, setView] = useState<ChatView | null>(null);
	const [error, setError] = useState("");
	const [older, setOlder] = useState<ChatView["items"]>([]);
	const [before, setBefore] = useState<number | null | undefined>();
	const [loading, setLoading] = useState(false);
	const [, setNow] = useState(Date.now);
	useEffect(() => {
		if (!active || entry.activeRoundId === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active, entry.activeRoundId]);
	// A ready gateway can still be attaching a different session. Cached panels must
	// wait for that attachment and its first snapshot before acquiring child handles.
	const ready = phase === "ready" && !operating && parentView !== null;
	const service = useMemo(
		() => (ready && active ? appActions.subagent(entry.agentId) : null),
		[ready, active, entry.agentId],
	);
	const epoch = useRef(0);
	useEffect(() => {
		const generation = ++epoch.current;
		setLoading(false);
		setBefore(undefined);
		if (!service) return;
		const stop = service.view.subscribe((value) => {
			if (generation === epoch.current && service.error) setError(service.error);
			if (generation === epoch.current && value) {
				setView((previous) => {
					if (previous?.items.length && !value.items.some((item) => previous.items.some((old) => old.key === item.key)))
						setBefore(value.historyBefore);
					return { ...value, items: mergeTranscriptItems(previous?.items ?? [], value.items) };
				});
				setBefore((previous) => (previous === undefined ? value.historyBefore : previous));
				if (!service.error) setError("");
			}
		});
		return () => {
			epoch.current++;
			stop();
		};
	}, [service]);
	const imageReader = useMemo(
		() =>
			service
				? (entryId: number, contentIndex: number) =>
						downloadImage((offset) => service.getImage({ entryId, contentIndex, offset }))
				: null,
		[service],
	);
	const merged = useMemo(() => {
		if (!view) return null;
		return { ...view, items: mergeTranscriptItems(older, view.items) };
	}, [view, older]);
	const history = useCallback(async () => {
		if (!service || loading || before == null) return;
		const generation = epoch.current;
		setLoading(true);
		try {
			const result = await service.history(before == null ? {} : { before });
			if (generation !== epoch.current) return;
			setOlder((previous) => mergeTranscriptItems(previous, result.items));
			setBefore(result.next);
		} catch (e) {
			if (generation === epoch.current) setError(String(e));
		} finally {
			if (generation === epoch.current) setLoading(false);
		}
	}, [service, loading, before]);
	const targetEntry = target ? view?.rounds?.find((r) => r.taskId === target.taskId)?.inputEntryId : undefined;
	const currentRound = view?.rounds?.find((r) => r.taskId === (entry.activeRoundId ?? entry.lastRoundId));
	useEffect(() => {
		if (
			active &&
			targetEntry !== undefined &&
			merged &&
			!merged.items.some((i) => i.type === "user" && i.id === targetEntry) &&
			before != null &&
			!loading
		)
			void history();
	}, [active, targetEntry, merged, before, loading, history]);
	return (
		<div className={`${active ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
			<div className="flex flex-wrap items-center gap-2 border-b border-sakura-100 p-3 text-xs">
				<span>
					{entry.historyThrough !== undefined ? t("subagent.history") : ""}
					{t(`task.status.${entry.status}`)}
				</span>
				{view && (
					<span title={t("subagent.usage")}>
						↑{view.usage.input} ↓{view.usage.output} · ${view.usage.cost.toFixed(4)}
					</span>
				)}
				{currentRound && (
					<span title={t("subagent.duration")}>
						{Math.max(0, Math.round(((currentRound.endedAt ?? Date.now()) - currentRound.createdAt) / 1000))}s
					</span>
				)}
				{entry.historyThrough === undefined && (entry.status === "running" || entry.status === "queued") && (
					<button
						type="button"
						className="focus-neko rounded-lg border border-sakura-300 px-2 leading-[14px]"
						onClick={() => {
							void service?.stop({ taskId: entry.activeRoundId! }).catch((e) => setError(String(e)));
						}}
					>
						{t("subagent.stop")}
					</button>
				)}
			</div>
			{error && (
				<p role="alert" className="p-3 text-sm text-sakura-800">
					{error}
				</p>
			)}
			<ImageReaderContext.Provider value={imageReader}>
				<MessageList
					view={merged}
					focusEntry={targetEntry !== undefined && target ? { id: targetEntry, nonce: target.nonce } : undefined}
					onLoadEarlier={active && before != null ? history : undefined}
					busy={view?.busy ?? false}
					emptyLabel={entry.status === "queued" ? t("subagent.queued") : t("subagent.noContent")}
				/>
			</ImageReaderContext.Provider>
		</div>
	);
}
export function SubagentPanel({
	entries,
	selected,
	open,
	onSelect,
	onClose,
	approval,
	target,
}: {
	entries: SubagentSummary[];
	selected: string | null;
	open: boolean;
	onSelect: (id: string) => void;
	onClose: () => void;
	approval?: ReactNode;
	target?: { taskId: number; nonce: number };
}) {
	const t = useT();
	const [visited, setVisited] = useState<string[]>([]);
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
		if (selected !== null) setVisited((ids) => (ids.includes(selected) ? ids : [...ids, selected]));
	}, [selected]);
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
	return (
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: Narrow screens explicitly use the dialog role with aria-modal.
		<aside
			ref={panel}
			role={narrow ? "dialog" : "complementary"}
			aria-modal={narrow && open ? true : undefined}
			aria-label={t("subagent.title")}
			className={`${open ? "flex" : "hidden"} fixed inset-0 z-30 min-w-0 flex-col border-l border-sakura-200 bg-base lg:static lg:z-auto lg:w-[min(42vw,40rem)] lg:shrink-0`}
			onKeyDown={(e) => {
				if (!e.currentTarget.contains(e.target as Node)) return;
				if (e.key === "Tab" && window.innerWidth < 1024) {
					const controls = [
						...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],summary,[tabindex='0']"),
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
			<div className="flex items-center justify-between border-b border-sakura-200 px-4 py-1.5">
				<strong className="text-sm text-ink-800">{t("subagent.title")}</strong>
				<button
					ref={closeButton}
					type="button"
					className="focus-neko rounded-lg px-2 py-1 text-sm text-ink-600 hover:bg-sakura-50"
					onClick={onClose}
				>
					{t("common.close")}
				</button>
			</div>
			<div className="max-h-44 shrink-0 overflow-auto border-b border-sakura-100 p-2">
				{entries.map((entry) => (
					<button
						type="button"
						key={entry.agentId}
						aria-pressed={selected === entry.agentId}
						className={`focus-neko flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${selected === entry.agentId ? "bg-tianyi-100" : "hover:bg-sakura-50"}`}
						onClick={() => onSelect(entry.agentId)}
					>
						<span className="min-w-0 truncate">
							<span className="text-tianyi-700">{entry.role}</span> · {entry.title}
						</span>
						<span className="shrink-0 text-xs text-ink-500">{t("subagent.rounds", { count: entry.roundCount })}</span>
					</button>
				))}
			</div>
			{visited.map((id) => {
				const entry = entries.find((d) => d.agentId === id);
				return entry ? (
					<Detail
						key={id}
						entry={entry}
						active={open && id === selected}
						target={id === selected ? target : undefined}
					/>
				) : null;
			})}
			{approval}
		</aside>
	);
}
