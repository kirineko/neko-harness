import { byMessage, byVisited, messageTime, sessionName } from "@neko-harness/core/session-display";
import type { NekoSessionSummary } from "@neko-harness/gateway";
import { formatDateTime, relativeTime } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";

export function workspaceSessions(sessions: readonly NekoSessionSummary[], cwd: string): NekoSessionSummary[] {
	return sessions.filter((s) => s.workspaceRoot === cwd).sort(byMessage);
}

export function recentlyVisited(sessions: readonly NekoSessionSummary[], cwd: string): NekoSessionSummary[] {
	return workspaceSessions(sessions, cwd).sort(byVisited);
}

export const awaitingAnswerLabel = (): string => t("session.awaitingAnswer");
export const awaitingPlanLabel = (): string => t("session.awaitingPlan");

/** Status word of a directory entry; a session whose assistant waits for an answer shows that, not "Running". */
export function sessionStatusText(s: Pick<NekoSessionSummary, "status" | "awaitingAnswer" | "awaitingPlan">): string {
	if (s.awaitingAnswer === true) return awaitingAnswerLabel();
	if (s.awaitingPlan === true) return awaitingPlanLabel();
	return s.status === "running" ? t("session.running") : s.status === "error" ? t("session.error") : t("session.idle");
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
				? `${s.awaitingAnswer === true ? awaitingAnswerLabel() : awaitingPlanLabel()} · ${relativeTime(messageTime(s), now)}`
				: relativeTime(messageTime(s), now),
		searchText: `${s.firstPromptPreview} ${s.id}`,
		description: `${s.model ? `${s.model.provider}/${s.model.modelId}` : t("session.noModel")} | ${sessionStatusText(s)}${s.id === current ? ` | ${t("common.current")}` : ""}\n${formatDateTime(messageTime(s))}`,
	}));
}
