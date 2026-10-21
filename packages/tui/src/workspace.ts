import { byMessage, byVisited, messageTime, relativeTime, sessionName } from "@neko-harness/core/session-display";
import type { NekoSessionSummary } from "@neko-harness/gateway";

export function workspaceSessions(sessions: readonly NekoSessionSummary[], cwd: string): NekoSessionSummary[] {
	return sessions.filter((s) => s.workspaceRoot === cwd).sort(byMessage);
}

export function recentlyVisited(sessions: readonly NekoSessionSummary[], cwd: string): NekoSessionSummary[] {
	return workspaceSessions(sessions, cwd).sort(byVisited);
}

export const AWAITING_ANSWER = "等待回答";
export const AWAITING_PLAN = "等待批准";

/** Status word of a directory entry; a session whose assistant waits for an answer shows that, not "Running". */
export function sessionStatusText(s: Pick<NekoSessionSummary, "status" | "awaitingAnswer" | "awaitingPlan">): string {
	if (s.awaitingAnswer === true) return AWAITING_ANSWER;
	if (s.awaitingPlan === true) return AWAITING_PLAN;
	return s.status === "running" ? "Running" : s.status === "error" ? "Error" : "Idle";
}

export function sessionPickerItems(
	sessions: readonly NekoSessionSummary[],
	cwd: string,
	current: string,
	now = Date.now(),
) {
	return workspaceSessions(sessions, cwd).map((s) => ({
		value: s.id,
		label: `${s.id === current ? "* " : ""}${sessionName(s)}`,
		rightLabel:
			s.awaitingAnswer === true || s.awaitingPlan === true
				? `${s.awaitingAnswer === true ? AWAITING_ANSWER : AWAITING_PLAN} · ${relativeTime(messageTime(s), now)}`
				: relativeTime(messageTime(s), now),
		searchText: `${s.firstPromptPreview} ${s.id}`,
		description: `${s.model ? `${s.model.provider}/${s.model.modelId}` : "No model"} | ${sessionStatusText(s)}${s.id === current ? " | Current" : ""}\n${new Date(messageTime(s)).toLocaleString("en-GB")}`,
	}));
}
