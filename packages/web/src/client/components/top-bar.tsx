import { sessionName } from "@neko-harness/core/session-display";
import { type PlainKey, useT } from "../lib/i18n/index.ts";
import type { ConnPhase } from "../lib/store";
import { useNekoState } from "../lib/store";
import { ExportMenu } from "./export-menu";
import { OpenWorkspaceMenu } from "./open-workspace-menu";
import { folderName, Icon } from "./primitives";
import { TodoButton } from "./todo-panel";
import { UpdateNotice } from "./update-notice";

const PHASE_KEYS: Record<ConnPhase, PlainKey> = {
	ready: "common.connected",
	connecting: "common.connecting",
	reconnecting: "common.reconnecting",
	error: "common.connectionFailed",
};
export function TopBar(props: {
	conn: ConnPhase;
	onToggleSessions: () => void;
	sidebarOpen?: boolean;
	onToggleJobs?: () => void;
	jobsOpen?: boolean;
	todos?: { open: boolean; onToggle: () => void; panelId: string };
	/** Present only on a gateway with the workspace browser; `count` is the number of files the agent changed. */
	workspace?: { open: boolean; count: number; onToggle: () => void };
}) {
	const t = useT();
	const { workspaceRoot, currentSessionId, operating, sessions, view } = useNekoState();
	// `jobs` is absent on a gateway without background jobs, so the entry stays hidden there.
	const jobs = view?.jobs;
	const running = jobs?.filter((job) => job.status === "running").length ?? 0;
	const current = sessions.find((session) => session.id === currentSessionId);
	return (
		<>
			<header className="chrome topbar">
				<button
					type="button"
					className="icon-btn"
					aria-label={t("topbar.toggleSidebar")}
					title={t("topbar.toggleSidebar")}
					aria-expanded={props.sidebarOpen}
					onClick={props.onToggleSessions}
				>
					<Icon name="panel" />
				</button>
				<span className="topbar-path" title={workspaceRoot}>
					<Icon name="folder" />
					<span className="truncate min-w-0">{folderName(workspaceRoot) || t("common.workspace")}</span>
				</span>
				<span className="text-ink-500">/</span>
				<span className="truncate min-w-0" title={current ? sessionName(current, t("common.newSession")) : undefined}>
					{current ? sessionName(current, t("common.newSession")) : t("common.newSession")}
				</span>
				<output
					className={`conn-status ${props.conn === "ready" ? "is-connected" : props.conn === "error" ? "is-error" : ""}`}
				>
					{operating ? t("topbar.switching") : t(PHASE_KEYS[props.conn])}
				</output>
				{props.todos && (
					<TodoButton open={props.todos.open} onToggle={props.todos.onToggle} panelId={props.todos.panelId} />
				)}
				{jobs !== undefined && jobs.length > 0 && props.onToggleJobs && (
					<button
						type="button"
						className="focus-neko shrink-0 whitespace-nowrap rounded-full border border-sakura-300 px-2.5 py-0.5 text-xs text-sakura-800 hover:bg-sakura-50"
						aria-expanded={props.jobsOpen}
						title={t("job.panel")}
						onClick={props.onToggleJobs}
					>
						{t("topbar.jobs", {
							state:
								running > 0
									? t("topbar.jobsRunning", { count: running })
									: t("topbar.jobsCount", { count: jobs.length }),
						})}
					</button>
				)}
				<OpenWorkspaceMenu ready={props.conn === "ready" && !operating} />
				{props.workspace && (
					<button
						type="button"
						data-workspace-entry
						className="icon-btn workspace-entry"
						aria-expanded={props.workspace.open}
						aria-label={
							props.workspace.count > 0
								? t("topbar.workspaceAria", { count: props.workspace.count })
								: t("common.workspace")
						}
						title={t("topbar.workspaceTitle")}
						onClick={props.workspace.onToggle}
					>
						<Icon name="panel-right" />
						{props.workspace.count > 0 && (
							<span className="workspace-badge" aria-hidden="true">
								{props.workspace.count > 99 ? "99+" : props.workspace.count}
							</span>
						)}
					</button>
				)}
				<ExportMenu />
			</header>
			<UpdateNotice />
		</>
	);
}
