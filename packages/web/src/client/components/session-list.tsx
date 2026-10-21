import { matchesSession, messageTime, relativeTime, sessionName } from "@neko-harness/core/session-display";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { appActions, reportError } from "../lib/bootstrap";
import { workspaceSessions } from "../lib/gateway";
import { sessionStatusText } from "../lib/interactions";
import { useSessionTime } from "../lib/session-time";
import { useNekoState } from "../lib/store";
import { folderName, Icon, Modal, Popover, useMobile } from "./primitives";
import { WorkspacePicker } from "./workspace-picker";

export function SessionList({ open, onClose }: { open: boolean; onClose: () => void }) {
	const state = useNekoState();
	const now = useSessionTime();
	const mobile = useMobile();
	const [menu, setMenu] = useState<{ anchor: HTMLElement; id?: string } | null>(null);
	const menuSession = state.sessions.find((session) => session.id === menu?.id);
	const [picker, setPicker] = useState(false);
	const [archive, setArchive] = useState<string | null>(null);
	const [archiveError, setArchiveError] = useState("");
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
	if (!open) return null;
	const content = (
		<>
			<div className="sidebar-top">
				<div className="workspace-heading">
					<button
						type="button"
						className="workspace-trigger"
						aria-label="切换工作区"
						aria-expanded={menu !== null && !menu.id}
						disabled={disabled}
						onClick={(e) => setMenu({ anchor: e.currentTarget })}
					>
						<span className="workspace-mark">
							<Icon name="folder" />
						</span>
						<span className="truncate min-w-0">{folderName(state.workspaceRoot) || "工作区"}</span>
						<Icon name="chevron" />
					</button>
					{!mobile && (
						<button type="button" className="icon-btn" aria-label="收起侧栏" title="收起侧栏" onClick={onClose}>
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
					新建会话
				</button>
				<div className="search-box">
					<Icon name="search" />
					<input
						aria-label="搜索当前工作区会话"
						placeholder="搜索会话…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
				</div>
			</div>
			<div className="section-label">
				会话 <span>{sessions.length}</span>
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
									<span className="truncate min-w-0">{sessionName(session, "新会话")}</span>
									<span
										className={`session-meta${session.awaitingAnswer === true || session.awaitingPlan === true ? " font-semibold text-tianyi-800" : ""}`}
									>
										<time dateTime={new Date(messageTime(session)).toISOString()}>
											{relativeTime(messageTime(session), now, "zh")}
										</time>
										{sessionStatusText(session)}
									</span>
									<span className="session-tooltip" role="tooltip" id={`session-tip-${session.id}`}>
										{sessionName(session, "新会话")}
										<br />
										{new Date(messageTime(session)).toLocaleString("zh-CN")}
									</span>
								</span>
							</button>
							<button
								type="button"
								className="icon-btn row-more"
								disabled={disabled}
								aria-label={`${sessionName(session, "新会话")}的操作`}
								title="会话操作"
								onClick={(e) => setMenu({ anchor: e.currentTarget, id: session.id })}
							>
								<Icon name="more" />
							</button>
						</li>
					))}
				</ul>
				{sessions.length === 0 && (
					<div className="empty-text">
						{state.phase !== "ready" ? "等待网关连接…" : query ? "没有匹配的会话" : "此工作区暂无会话"}
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
					技能市场
				</Link>
				<Link
					to="/settings"
					className="chrome-row"
					onClick={() => {
						if (mobile) onClose();
					}}
				>
					<Icon name="settings" />
					设置
				</Link>
			</div>
		</>
	);
	return (
		<>
			{mobile ? (
				<Modal title="工作区与会话" drawer onClose={onClose}>
					{content}
				</Modal>
			) : (
				<aside className="chrome sidebar" aria-label="工作区与会话">
					{content}
				</aside>
			)}
			{menu && (
				<Popover anchor={menu.anchor} label={menu.id ? "会话操作" : "选择工作区"} onClose={() => setMenu(null)}>
					{menu.id ? (
						<>
							{menuSession && (
								<div className="session-details">
									<strong>{sessionName(menuSession, "新会话")}</strong>
									<small>{new Date(messageTime(menuSession)).toLocaleString("zh-CN")}</small>
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
								归档会话
							</button>
						</>
					) : (
						<>
							<div className="section-label">工作区</div>
							<div className="workspace-options">
								{state.workspaces.map((w) => (
									<button
										type="button"
										className={`workspace-option ${w.path === state.workspaceRoot ? "is-active" : ""}`}
										key={w.path}
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
											<span role="img" aria-label="当前工作区">
												✓
											</span>
										)}
									</button>
								))}
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
								添加工作区
							</button>
						</>
					)}
				</Popover>
			)}
			{picker && <WorkspacePicker initialPath={state.workspaceRoot} onClose={() => setPicker(false)} />}
			{archive && (
				<Modal title="归档会话" locked={state.operating} onClose={() => setArchive(null)}>
					<div className="confirm-body">
						<p>
							归档“
							{sessionName(
								state.sessions.find((s) => s.id === archive) ?? { title: "", firstPromptPreview: "" },
								"新会话",
							)}
							”？会话将从列表中隐藏，工作区和文件仍会保留。
						</p>
						{archiveError && (
							<p role="alert" className="error-text">
								{archiveError}
							</p>
						)}
						<div className="actions">
							<button type="button" className="btn-outline" disabled={state.operating} onClick={() => setArchive(null)}>
								取消
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
								确认归档
							</button>
						</div>
					</div>
				</Modal>
			)}
		</>
	);
}
