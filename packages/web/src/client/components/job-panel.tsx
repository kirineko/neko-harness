import { JobTail, summarizeJobs } from "@neko-harness/core/job-summary";
import type { WireJobSummary } from "@neko-harness/gateway/contract";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import { atBottom, jobStatusText, sanitizeJobOutput } from "../lib/job-output";
import { usePanelWidth } from "../lib/panel-width.ts";
import { ResizeHandle } from "./resize-handle";

const POLL_MS = 1000;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function Detail({ sessionId, job }: { sessionId: string; job: WireJobSummary }) {
	const t = useT();
	const jobId = job.jobId;
	const tail = useRef(new JobTail());
	const [, setVersion] = useState(0);
	const [error, setError] = useState("");
	const [follow, setFollow] = useState(true);
	const [stopping, setStopping] = useState(false);
	const followRef = useRef(true);
	const bodyRef = useRef<HTMLDivElement>(null);
	const running = job.status === "running";
	const runningRef = useRef(running);
	runningRef.current = running;
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => setNow(Date.now()), POLL_MS);
		return () => clearInterval(timer);
	}, [running]);

	// Poll by offset while the job runs, plus one last read after it ends. The guard drops
	// responses that arrive after the job or session changed.
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			const wasRunning = runningRef.current;
			try {
				const read = await appActions.jobOutput(sessionId, jobId, tail.current.offset);
				if (cancelled) return;
				tail.current.apply(read, sanitizeJobOutput);
				setError("");
				setVersion((v) => v + 1);
				if (wasRunning) timer = setTimeout(() => void poll(), POLL_MS);
			} catch (e) {
				if (!cancelled) setError(errorText(e));
			}
		};
		void poll();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [sessionId, jobId]);

	useLayoutEffect(() => {
		const el = bodyRef.current;
		if (el && followRef.current) el.scrollTop = el.scrollHeight;
	});

	const toBottom = useCallback(() => {
		const el = bodyRef.current;
		if (!el) return;
		followRef.current = true;
		setFollow(true);
		el.scrollTop = el.scrollHeight;
	}, []);

	const stop = () => {
		if (stopping) return;
		setStopping(true);
		appActions
			.jobStop(sessionId, jobId)
			.catch((e) => setError(errorText(e)))
			.finally(() => setStopping(false));
	};

	const text = tail.current.text;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-col gap-1 border-b border-sakura-100 p-3 text-xs">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium text-ink-800">{jobStatusText(job, now)}</span>
					{running && (
						<button
							type="button"
							disabled={stopping}
							className="focus-neko rounded-lg border border-sakura-300 px-2 py-0.5 disabled:opacity-50"
							onClick={stop}
						>
							{stopping ? t("job.stopping") : t("job.stop")}
						</button>
					)}
				</div>
				<code className="max-h-20 overflow-auto whitespace-pre-wrap break-all text-ink-700">{job.command}</code>
				<span className="break-all text-ink-500">{job.cwd}</span>
			</div>
			{error && (
				<p role="alert" className="shrink-0 p-3 text-sm text-sakura-800">
					{error}
				</p>
			)}
			<div className="relative min-h-0 flex-1">
				<div
					ref={bodyRef}
					data-testid="job-output"
					className="h-full overflow-y-auto overflow-x-hidden p-3"
					onScroll={(e) => {
						const next = atBottom(e.currentTarget);
						followRef.current = next;
						setFollow(next);
					}}
				>
					{tail.current.dropped > 0 && (
						<p className="mb-2 text-xs text-sakura-800">{t("job.dropped", { count: tail.current.dropped })}</p>
					)}
					{text === "" ? (
						<p className="text-xs text-ink-500">
							{tail.current.offset === undefined ? t("job.reading") : t("job.noOutput")}
						</p>
					) : (
						<pre className="whitespace-pre-wrap break-words font-mono text-xs text-ink-800">{text}</pre>
					)}
				</div>
				{!follow && (
					<button
						type="button"
						onClick={toBottom}
						className="focus-neko discrete-in absolute right-3 bottom-3 rounded-full border border-sakura-300 bg-surface px-3.5 py-1 text-xs font-medium text-sakura-800 hover:bg-sakura-50"
					>
						{t("job.toBottom")}
					</button>
				)}
			</div>
		</div>
	);
}

export function JobPanel({
	sessionId,
	jobs,
	open,
	onClose,
}: {
	sessionId: string;
	jobs: readonly WireJobSummary[];
	open: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const [selected, setSelected] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now);
	const panelWidth = usePanelWidth();
	const closeButton = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLElement>(null);
	const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 1023px)");
		const update = () => setNarrow(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	const summary = summarizeJobs(jobs, now);
	useEffect(() => {
		if (!open || summary.running === 0) return;
		const timer = setInterval(() => setNow(Date.now()), POLL_MS);
		return () => clearInterval(timer);
	}, [open, summary.running]);
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

	const current = summary.rows.find((row) => row.job.jobId === selected) ?? summary.rows[0];
	return (
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: Narrow screens explicitly use the dialog role with aria-modal.
		<aside
			ref={panel}
			role={narrow ? "dialog" : "complementary"}
			aria-modal={narrow && open ? true : undefined}
			aria-label={t("job.panel")}
			style={{ "--panel-w": `${panelWidth.width}px` } as CSSProperties}
			className={`${open ? "flex" : "hidden"} fixed inset-0 z-30 min-w-0 flex-col border-l border-sakura-200 bg-base lg:relative lg:z-auto lg:w-[var(--panel-w)] lg:max-w-[60vw] lg:shrink-0`}
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
			<ResizeHandle
				width={panelWidth.width}
				onChange={panelWidth.set}
				onCommit={panelWidth.commit}
				onReset={panelWidth.reset}
			/>
			<div className="flex items-center justify-between border-b border-sakura-200 px-4 py-1.5">
				<strong className="text-sm text-ink-800">{t("job.panel")}</strong>
				<button
					ref={closeButton}
					type="button"
					className="focus-neko rounded-lg px-2 py-1 text-sm text-ink-600 hover:bg-sakura-50"
					onClick={onClose}
				>
					{t("common.close")}
				</button>
			</div>
			{summary.rows.length === 0 ? (
				<p className="p-4 text-sm text-ink-500">{t("job.panelEmpty")}</p>
			) : (
				<>
					<div className="max-h-44 shrink-0 overflow-auto border-b border-sakura-100 p-2">
						{summary.rows.map((row) => (
							<button
								type="button"
								key={row.job.jobId}
								aria-pressed={current?.job.jobId === row.job.jobId}
								className={`focus-neko flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${current?.job.jobId === row.job.jobId ? "bg-tianyi-100" : "hover:bg-sakura-50"}`}
								onClick={() => setSelected(row.job.jobId)}
							>
								<span className="min-w-0 flex-1 truncate">
									<span className="text-tianyi-700">{row.job.jobId}</span> · {row.label}
								</span>
								<span className="shrink-0 text-xs text-ink-500">{jobStatusText(row.job, now)}</span>
							</button>
						))}
					</div>
					{open && current && (
						<Detail key={`${sessionId}:${current.job.jobId}`} sessionId={sessionId} job={current.job} />
					)}
				</>
			)}
		</aside>
	);
}
