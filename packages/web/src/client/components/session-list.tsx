import { matchesSession, messageTime, sessionName } from "@neko-harness/core/session-display";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { appActions, reportError } from "../lib/bootstrap";
import { workspaceSessions } from "../lib/gateway";
import { localizeCoreError } from "../lib/i18n/core-text.ts";
import { formatDateTime, formatRelative } from "../lib/i18n/format.ts";
import { useT } from "../lib/i18n/index.ts";
import { sessionStatusText } from "../lib/interactions";
import { useSessionTime } from "../lib/session-time";
import { useNekoState } from "../lib/store";
import { folderName, Icon, Modal, Popover, useMobile } from "./primitives";
import { WorkspacePicker } from "./workspace-picker";

export function SessionList({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useT();
	const newName = t("common.newSession");
	const state = useNekoState();
	const now = useSessionTime();
	const mobile = useMobile();
	const [menu, setMenu] = useState<{ anchor: HTMLElement; id?: string } | null>(null);
	const menuSession = state.sessions.find((session) => session.id === menu?.id);
	const [picker, setPicker] = useState(false);
	const [archive, setArchive] = useState<string | null>(null);
	const [archiveError, setArchiveError] = useState("");
	const [removal, setRemoval] = useState<string | null>(null);
	const [removalError, setRemovalError] = useState("");
	const [removalBusy, setRemovalBusy] = useState(false);
	const [query, setQuery] = useState("");
	const disabled = state.phase !== "ready" || state.operating;
	const sessions = workspaceSessions(state.sessions, state.workspaceRoot).filter((s) => matchesSession(s, query));
	const action = (operation: Promise<void>) => {
		void operation
			.then(() => {
				if (mobile) onClose();
			})
			.catch(reportError);
	};
	const launchRoot = state.webInfo?.launchRoot;
	const removeReason = (path: string): string | null =>
		path === launchRoot
			? t("sessions.removeWorkspaceLaunch")
			: state.workspaces.length <= 1
				? t("sessions.removeWorkspaceLast")
				: null;
	if (!open) return null;
	const content = (
		<>
			<div className="sidebar-top">
				<div className="workspace-heading">
					<button
						type="button"
						className="workspace-trigger"
						aria-label={t("sessions.switchWorkspace")}
						aria-expanded={menu !== null && !menu.id}
						disabled={disabled}
						onClick={(e) => setMenu({ anchor: e.currentTarget })}
					>
						<span className="workspace-mark">
							<Icon name="folder" />
						</span>
						<span className="truncate min-w-0">{folderName(state.workspaceRoot) || t("common.workspace")}</span>
						<Icon name="chevron" />
					</button>
					{!mobile && (
						<button
							type="button"
							className="icon-btn"
							aria-label={t("sessions.collapse")}
							title={t("sessions.collapse")}
							onClick={onClose}
						>
							<Icon name="panel" />
						</button>
					)}
				</div>
				<button
					type="button"
					className="chrome-row font-medium"
					disabled={disabled}
					onClick={() => action(appActions.createSession())}
				>
					<Icon name="plus" />
					{t("sessions.new")}
				</button>
				<div className="search-box">
					<Icon name="search" />
					<input
						aria-label={t("sessions.searchAria")}
						placeholder={t("sessions.searchPlaceholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
			</div>
			<div className="section-label">
				{t("sessions.heading")} <span>{sessions.length}</span>
			</div>
			<div className="session-scroll">
				<ul className="session-list">
					{sessions.map((session) => (
						<li key={session.id} className={`session-row ${session.id === state.currentSessionId ? "is-active" : ""}`}>
							<button
								type="button"
								className="chrome-row session-select"
								disabled={disabled}
								aria-current={session.id === state.currentSessionId ? "page" : undefined}
								aria-describedby={`session-tip-${session.id}`}
								onClick={() => action(appActions.selectSession(session.id))}
							>
								<Icon name="chat" />
								<span className="session-copy">
									<span className="truncate min-w-0">{sessionName(session, newName)}</span>
									<span
										className={`session-meta${session.awaitingAnswer === true || session.awaitingPlan === true ? " font-semibold text-tianyi-800" : ""}`}
									>
										<time dateTime={new Date(messageTime(session)).toISOString()}>
											{formatRelative(messageTime(session), now)}
										</time>
										{sessionStatusText(session)}
									</span>
									<span className="session-tooltip" role="tooltip" id={`session-tip-${session.id}`}>
										{sessionName(session, newName)}
										<br />
										{formatDateTime(messageTime(session))}
									</span>
								</span>
							</button>
							<button
								type="button"
								className="icon-btn row-more"
								disabled={disabled}
								aria-label={t("sessions.actionsFor", { name: sessionName(session, newName) })}
								title={t("sessions.actions")}
								onClick={(e) => setMenu({ anchor: e.currentTarget, id: session.id })}
							>
								<Icon name="more" />
							</button>
						</li>
					))}
				</ul>
				{sessions.length === 0 && (
					<div className="empty-text">
						{state.phase !== "ready"
							? t("sessions.waitingGateway")
							: query
								? t("sessions.noMatch")
								: t("sessions.empty")}
					</div>
				)}
			</div>
			<div className="sidebar-bottom">
				<span className="path-text" title={state.workspaceRoot}>
					{state.workspaceRoot}
				</span>
				<Link
					to="/skills"
					className="chrome-row"
					onClick={() => {
						if (mobile) onClose();
					}}
				>
					<Icon name="store" />
					{t("sessions.market")}
				</Link>
				<Link
					to="/settings"
					className="chrome-row"
					onClick={() => {
						if (mobile) onClose();
					}}
				>
					<Icon name="settings" />
					{t("sessions.settings")}
				</Link>
			</div>
		</>
	);
	return (
		<>
			{mobile ? (
				<Modal title={t("sessions.drawer")} drawer onClose={onClose}>
					{content}
				</Modal>
			) : (
				<aside className="chrome sidebar" aria-label={t("sessions.drawer")}>
					{content}
				</aside>
			)}
			{menu && (
				<Popover
					anchor={menu.anchor}
					label={menu.id ? t("sessions.actions") : t("sessions.chooseWorkspace")}
					onClose={() => setMenu(null)}
				>
					{menu.id ? (
						<>
							{menuSession && (
								<div className="session-details">
									<strong>{sessionName(menuSession, newName)}</strong>
									<small>{formatDateTime(messageTime(menuSession))}</small>
								</div>
							)}
							<button
								type="button"
								className="chrome-row"
								onClick={() => {
									setArchive(menu.id!);
									setArchiveError("");
									setMenu(null);
								}}
							>
								<Icon name="archive" />
								{t("sessions.archive")}
							</button>
						</>
					) : (
						<>
							<div className="section-label">{t("common.workspace")}</div>
							<div className="workspace-options">
								{state.workspaces.map((w) => {
									const reason = removeReason(w.path);
									return (
										<div className={`workspace-row ${w.path === state.workspaceRoot ? "is-active" : ""}`} key={w.path}>
											<button
												type="button"
												className="workspace-option"
												title={w.path}
												onClick={() => {
													setMenu(null);
													setQuery("");
													action(appActions.selectWorkspace(w.path));
												}}
											>
												<Icon name="folder" />
												<span>
													<strong>{folderName(w.path)}</strong>
													<small>{w.path}</small>
												</span>
												{w.path === state.workspaceRoot && (
													<span role="img" aria-label={t("sessions.currentWorkspace")}>
														✓
													</span>
												)}
											</button>
											<button
												type="button"
												className="icon-btn row-remove"
												disabled={disabled || reason !== null}
												aria-label={t("sessions.removeWorkspaceAria", { name: folderName(w.path) })}
												aria-describedby={reason ? `workspace-remove-${w.path}` : undefined}
												title={reason ?? t("sessions.removeWorkspace")}
												onClick={() => {
													setRemoval(w.path);
													setRemovalError("");
													setMenu(null);
												}}
											>
												<Icon name="trash" />
											</button>
											{reason && (
												<span className="sr-only" id={`workspace-remove-${w.path}`}>
													{reason}
												</span>
											)}
										</div>
									);
								})}
							</div>
							<button
								type="button"
								className="chrome-row add-workspace"
								onClick={() => {
									setMenu(null);
									setPicker(true);
								}}
							>
								<Icon name="plus" />
								{t("sessions.addWorkspace")}
							</button>
						</>
					)}
				</Popover>
			)}
			{picker && <WorkspacePicker initialPath={state.workspaceRoot} onClose={() => setPicker(false)} />}
			{removal && (
				<Modal
					title={t("sessions.removeWorkspace")}
					locked={state.operating || removalBusy}
					onClose={() => setRemoval(null)}
				>
					<div className="confirm-body">
						<p>
							<strong>{folderName(removal)}</strong>
						</p>
						<p className="path-text" title={removal}>
							{removal}
						</p>
						<ul className="confirm-notes">
							<li>{t("sessions.removeWorkspaceNoFiles")}</li>
							<li>
								{t("sessions.removeWorkspaceHidden", { count: workspaceSessions(state.sessions, removal).length })}
							</li>
							<li>{t("sessions.removeWorkspaceRestore")}</li>
						</ul>
						{removalError && (
							<p role="alert" className="error-text">
								{removalError}
							</p>
						)}
						<div className="actions">
							<button
								type="button"
								className="btn-outline"
								disabled={state.operating || removalBusy}
								onClick={() => setRemoval(null)}
							>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								className="btn-danger"
								disabled={state.operating || removalBusy}
								onClick={() => {
									setRemovalBusy(true);
									setRemovalError("");
									void appActions
										.removeWorkspace(removal)
										.then(() => setRemoval(null))
										.catch((e: unknown) =>
											setRemovalError(localizeCoreError(e instanceof Error ? e.message : String(e))),
										)
										.finally(() => setRemovalBusy(false));
								}}
							>
								{t("sessions.confirmRemoveWorkspace")}
							</button>
						</div>
					</div>
				</Modal>
			)}
			{archive && (
				<Modal title={t("sessions.archive")} locked={state.operating} onClose={() => setArchive(null)}>
					<div className="confirm-body">
						<p>
							{t("sessions.archiveConfirm", {
								name: sessionName(
									state.sessions.find((s) => s.id === archive) ?? { title: "", firstPromptPreview: "" },
									newName,
								),
							})}
						</p>
						{archiveError && (
							<p role="alert" className="error-text">
								{archiveError}
							</p>
						)}
						<div className="actions">
							<button type="button" className="btn-outline" disabled={state.operating} onClick={() => setArchive(null)}>
								{t("common.cancel")}
							</button>
							<button
								type="button"
								className="btn-primary"
								disabled={state.operating}
								onClick={() => {
									void appActions
										.archiveSession(archive)
										.then(() => setArchive(null))
										.catch((e: unknown) => setArchiveError(String(e)));
								}}
							>
								{t("sessions.confirmArchive")}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</>
	);
}
