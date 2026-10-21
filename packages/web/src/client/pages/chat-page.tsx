import type { SubagentSummary } from "@neko-harness/core";
import { useEffect, useId, useRef, useState } from "react";
import { ApprovalInbox } from "../components/approval-inbox";
import { Composer } from "../components/composer";
import { JobPanel } from "../components/job-panel";
import { MessageList } from "../components/message-list";
import { PlanDock } from "../components/plan-card";
import { DismissButton, folderName, useMobile } from "../components/primitives";
import { QuestionDock } from "../components/question-card";
import { SessionList } from "../components/session-list";
import { ShellNotice } from "../components/shell-notice";
import { SubagentPanel } from "../components/subagent-panel";
import { TodoPanel } from "../components/todo-panel";
import { TopBar } from "../components/top-bar";
import { WorkspacePanel } from "../components/workspace-panel";
import { useAwaitingTitle } from "../lib/awaiting-title";
import { appActions, reportError } from "../lib/bootstrap";
import { useT } from "../lib/i18n/index.ts";
import { questionState, todoState } from "../lib/interactions";
import { MOBILE_QUERY, WORKSPACE_WIDTH } from "../lib/layout";
import { planState } from "../lib/plan-ui";
import { storeActions, useNekoState } from "../lib/store";

const INFO_NOTICE_MS = 8000;

export function ChatPage() {
	const t = useT();
	const { view, phase, notice, operating, workspaceRoot, currentSessionId, retained } = useNekoState();
	const mobile = useMobile();
	useEffect(() => {
		if (notice?.level !== "info") return;
		const timer = setTimeout(storeActions.clearNotice, INFO_NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);
	const targetSequence = useRef(0);
	const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
	useEffect(() => {
		const query = window.matchMedia("(max-width: 1023px)");
		const update = () => setNarrow(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	const [panels, setPanels] = useState<
		Record<
			string,
			{ open: boolean; selected: string | null; entries: SubagentSummary[]; target?: { taskId: number; nonce: number } }
		>
	>({});
	const agentEntries = view?.agents;
	// The right-hand slot has one owner at a time. The subagent flag lives per session in `panels` (its panels stay
	// mounted and keep their `open` across session switches); jobs/workspace are tied to the session they were opened
	// in, so switching sessions closes them. `toggleRight`/`selectIdentity` are the only writers and keep them exclusive.
	const [rightFor, setRightFor] = useState<{ sessionId: string; kind: "jobs" | "workspace" } | null>(null);
	const rightForRef = useRef(rightFor);
	rightForRef.current = rightFor;
	useEffect(() => {
		setRightFor((previous) => (previous && previous.sessionId !== currentSessionId ? null : previous));
	}, [currentSessionId]);
	useEffect(() => {
		if (!currentSessionId || !agentEntries?.length) return;
		setPanels((previous) => ({
			...previous,
			[currentSessionId]: {
				// The first delegation opens the panel only if nothing else already holds the slot.
				open: previous[currentSessionId]
					? previous[currentSessionId]!.open
					: rightForRef.current?.sessionId !== currentSessionId,
				...(previous[currentSessionId]?.target ? { target: previous[currentSessionId]!.target } : {}),
				selected: previous[currentSessionId]?.selected ?? agentEntries[0]!.agentId,
				entries: agentEntries,
			},
		}));
	}, [agentEntries, currentSessionId]);
	const jobsOpen = rightFor?.kind === "jobs" && rightFor.sessionId === currentSessionId;
	const workspaceOpen = rightFor?.kind === "workspace" && rightFor.sessionId === currentSessionId;
	const toggleRight = (kind: "jobs" | "workspace") => {
		if (!currentSessionId) return;
		if (rightFor?.kind === kind && rightFor.sessionId === currentSessionId) return setRightFor(null);
		setPanels((previous) =>
			previous[currentSessionId]
				? { ...previous, [currentSessionId]: { ...previous[currentSessionId]!, open: false } }
				: previous,
		);
		setRightFor({ sessionId: currentSessionId, kind });
	};
	// Once a session's gateway reported `changes`, its panel stays mounted across a reconnect (view is null meanwhile).
	const [workspaceSession, setWorkspaceSession] = useState<string | null>(null);
	useEffect(() => {
		if (currentSessionId && view?.changes !== undefined) setWorkspaceSession(currentSessionId);
	}, [currentSessionId, view?.changes]);
	const [workspaceWidth, setWorkspaceWidth] = useState<number>(WORKSPACE_WIDTH.initial);
	// The todo list opens in the page flow for the session it was opened in; an empty list has no panel at all.
	const todoPanelId = useId();
	const [todosOpenFor, setTodosOpenFor] = useState<string | null>(null);
	const todos = todoState({ view, phase, operating, currentSessionId, retained });
	const todosOpen = todosOpenFor !== null && todosOpenFor === currentSessionId && (todos?.total ?? 0) > 0;
	useAwaitingTitle(
		questionState({ view, phase, operating, currentSessionId, retained })?.pending.length ?? 0,
		(planState({ view, phase, operating })?.awaiting ?? null) !== null,
	);
	const selectIdentity = (id: string, taskId?: number) => {
		if (!currentSessionId) return;
		setRightFor(null);
		const nonce = ++targetSequence.current;
		setPanels((previous) => ({
			...previous,
			[currentSessionId]: {
				open: true,
				selected: id,
				entries: agentEntries ?? [],
				...(taskId === undefined ? {} : { target: { taskId, nonce } }),
			},
		}));
	};
	const selectAgent = (taskId: number) => {
		const round = view?.subagents?.find((r) => r.taskId === taskId);
		if (round?.agentId) selectIdentity(round.agentId, taskId);
	};
	const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia(MOBILE_QUERY).matches);
	useEffect(() => {
		setSidebarOpen(!mobile);
	}, [mobile]);
	const approvalInPanel = narrow && !!panels[currentSessionId ?? ""]?.open;
	const busy = view?.busy ?? false;
	const status = view?.status ?? null;

	return (
		<div className="flex h-dvh">
			<a href="#main-content" className="skip-link">
				{t("chat.skip")}
			</a>
			<SessionList open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
			<div className="flex min-w-0 flex-1 flex-col">
				<TopBar
					sidebarOpen={sidebarOpen}
					conn={phase}
					onToggleSessions={() => setSidebarOpen(!sidebarOpen)}
					jobsOpen={jobsOpen}
					todos={{
						open: todosOpen,
						panelId: todoPanelId,
						onToggle: () => setTodosOpenFor(todosOpen ? null : (currentSessionId ?? null)),
					}}
					onToggleJobs={() => toggleRight("jobs")}
					workspace={
						view?.changes !== undefined
							? { open: workspaceOpen, count: view.changes.files, onToggle: () => toggleRight("workspace") }
							: undefined
					}
				/>
				<ShellNotice />
				{notice !== null && (
					<div
						className={`discrete-in flex items-center gap-2 border-b py-1 pr-2 pl-9 text-xs ${
							notice.level === "error"
								? "border-sakura-300 bg-sakura-100 text-sakura-900"
								: "border-tianyi-200 bg-tianyi-50 text-tianyi-900"
						}`}
						role="alert"
					>
						<span className="min-w-0 flex-1 text-center">{notice.text}</span>
						<DismissButton label={t("chat.dismissNotice")} onClick={storeActions.clearNotice} />
					</div>
				)}
				<main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col focus:outline-none">
					{todosOpen && <TodoPanel id={todoPanelId} onClose={() => setTodosOpenFor(null)} />}
					{!currentSessionId && phase === "ready" && !operating ? (
						<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
							<h1 className="text-xl font-semibold text-ink-900">{folderName(workspaceRoot)}</h1>
							<p className="text-sm text-ink-600">{t("chat.startHere")}</p>
							<button
								type="button"
								className="btn-primary focus-neko rounded-xl px-4 py-2"
								onClick={() => {
									void appActions.createSession().catch(reportError);
								}}
							>
								{t("sessions.new")}
							</button>
						</div>
					) : (
						<MessageList
							view={view}
							busy={busy}
							onSubagent={selectAgent}
							tray={
								(agentEntries?.length ?? 0) > 0 ? (
									<button
										type="button"
										className="focus-neko rounded-full border border-sakura-300 bg-surface px-3.5 py-1 text-xs font-medium text-sakura-800 hover:bg-sakura-50"
										onClick={() =>
											selectIdentity(panels[currentSessionId ?? ""]?.selected ?? agentEntries![0]!.agentId)
										}
									>
										{t("chat.subagents", { count: agentEntries!.length })}
										{agentEntries!.some((d) => d.approvalCount)
											? t("chat.subagentsApproval", {
													count: agentEntries!.reduce((n, d) => n + (d.approvalCount ?? 0), 0),
												})
											: ""}
										{agentEntries!.some((d) => d.historyThrough === undefined && d.status === "running")
											? t("chat.subagentsRunning", {
													count: agentEntries!.filter((d) => d.historyThrough === undefined && d.status === "running")
														.length,
												})
											: ""}
									</button>
								) : undefined
							}
						/>
					)}
					{/* Gives way last: the todo panel and the message list shrink first, then this stack scrolls. */}
					<div
						className="flex max-h-[60dvh] shrink-[0.01] flex-col overflow-y-auto overscroll-contain"
						data-attention-stack
					>
						{!approvalInPanel && <ApprovalInbox />}
						<QuestionDock />
						<PlanDock />
					</div>
					<Composer disabled={phase !== "ready" || operating} busy={busy} status={status} />
				</main>
			</div>
			{Object.entries(panels).map(([sessionId, panel]) => (
				<SubagentPanel
					key={sessionId}
					entries={sessionId === currentSessionId ? (agentEntries ?? panel.entries) : panel.entries}
					approval={approvalInPanel && sessionId === currentSessionId ? <ApprovalInbox /> : undefined}
					selected={panel.selected}
					open={sessionId === currentSessionId && panel.open}
					onSelect={selectIdentity}
					target={panel.target}
					onClose={() => setPanels((previous) => ({ ...previous, [sessionId]: { ...panel, open: false } }))}
				/>
			))}
			{currentSessionId && view?.jobs !== undefined && (
				<JobPanel
					key={currentSessionId}
					sessionId={currentSessionId}
					jobs={view.jobs}
					open={jobsOpen}
					onClose={() => setRightFor(null)}
				/>
			)}
			{currentSessionId && workspaceSession === currentSessionId && (
				<WorkspacePanel
					key={`workspace:${currentSessionId}`}
					sessionId={currentSessionId}
					open={workspaceOpen}
					onClose={() => setRightFor(null)}
					changes={view?.changes}
					width={workspaceWidth}
					onWidth={setWorkspaceWidth}
				/>
			)}
		</div>
	);
}
