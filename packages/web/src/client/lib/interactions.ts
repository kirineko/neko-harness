import {
	describeSettlement,
	type QuestionRecord,
	type QuestionStatus,
	type QuestionSummary,
	type TodoItem,
	type TodoStatus,
	todoProgress,
} from "@neko-harness/core/interactions";
import type { NekoState } from "./store.ts";

type Source = Pick<NekoState, "view" | "phase" | "operating" | "currentSessionId" | "retained">;

export type TodoState = {
	items: readonly TodoItem[];
	revision: number;
	completed: number;
	total: number;
	/** Showing the last loaded list: the view is gone or the gateway connection is not ready. */
	offline: boolean;
};

/** The retained snapshot only counts for the session it came from. */
function retainedFor(state: Source) {
	return state.retained !== null && state.retained.sessionId === state.currentSessionId ? state.retained : null;
}

/** `null` = the gateway does not support todos (or nothing was ever loaded); an empty list is a supported state. */
export function todoState(state: Source): TodoState | null {
	const list = state.view !== null ? state.view.todos : retainedFor(state)?.todos;
	if (list === undefined) return null;
	return {
		items: list.items,
		revision: list.revision,
		...todoProgress(list.items),
		offline: state.view === null || state.phase !== "ready",
	};
}

export type QuestionsState = {
	pending: readonly QuestionSummary[];
	/** Answering is possible: connected, not switching sessions, and a live view. */
	online: boolean;
};

/** `null` = the gateway does not support ask_user; an empty `pending` is a supported state. */
export function questionState(state: Source): QuestionsState | null {
	const list = state.view !== null ? state.view.questions : retainedFor(state)?.questions;
	if (list === undefined) return null;
	return { pending: list.pending, online: state.phase === "ready" && !state.operating && state.view !== null };
}

export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
	pending: "待办",
	in_progress: "进行中",
	completed: "已完成",
};
export const QUESTION_STATUS_LABEL: Record<QuestionStatus, string> = {
	pending: "等待回答",
	answered: "已回答",
	skipped: "已跳过",
	cancelled: "已取消",
};

/** Suffix of a session row: a question waiting for the user replaces "运行中"; absent `awaitingAnswer` = unsupported. */
export function sessionStatusText(session: {
	status: "idle" | "running" | "error";
	awaitingAnswer?: boolean;
	awaitingPlan?: boolean;
}): string {
	if (session.awaitingAnswer === true) return " · 等待回答";
	if (session.awaitingPlan === true) return " · 等待批准";
	return session.status === "running" ? " · 运行中" : session.status === "error" ? " · 出错" : "";
}

/** Tab title while the page is hidden and the session waits for an answer; restored by the caller. */
export function awaitingTitle(base: string, pending: number): string {
	return pending > 0 ? `(${pending}) 等待回答 · ${base}` : base;
}

/**
 * Model-authored text is shown as plain text, so control and bidi-override characters that could disguise
 * what a line says are spelled out; newlines and tabs stay.
 */
export function plainText(text: string): string {
	return [...text.replace(/\r\n?/g, "\n")]
		.map((char) => {
			const code = char.charCodeAt(0);
			return (code < 32 && code !== 9 && code !== 10) ||
				(code >= 127 && code <= 159) ||
				(code >= 0x202a && code <= 0x202e) ||
				(code >= 0x2066 && code <= 0x2069)
				? `\\u${code.toString(16).padStart(4, "0")}`
				: char;
		})
		.join("");
}

/** One-line state of a settled question, from its saved record. */
export function settlementText(record: QuestionRecord): string {
	if (record.status === "answered") {
		const answer = describeSettlement(record);
		return answer ? `已回答：${answer}` : "已回答";
	}
	if (record.status === "skipped") return "已跳过，未提供答案";
	if (record.status === "cancelled") return "已取消（运行已停止或会话已归档）";
	return QUESTION_STATUS_LABEL.pending;
}

/** Whether a saved record is exactly what a response asked for (otherwise another decision won). */
export function isSameDecision(
	record: QuestionRecord,
	response: { kind: "answer"; optionIds?: string[]; text?: string } | { kind: "skip" },
): boolean {
	if (response.kind === "skip") return record.status === "skipped";
	if (record.status !== "answered" || record.answer === null) return false;
	const chosen = response.optionIds ?? [];
	return (
		record.answer.optionIds.length === chosen.length &&
		record.answer.optionIds.every((id) => chosen.includes(id)) &&
		record.answer.text === (response.text ?? null)
	);
}

/** The answer part of a transcript `ask_user` row: selected labels, then the user's own words. */
export function interactionAnswer(interaction: {
	optionIds?: string[];
	labels?: string[];
	text?: string | null;
}): string {
	const parts = [...(interaction.labels ?? interaction.optionIds ?? [])];
	if (interaction.text) parts.push(interaction.text);
	return parts.join(", ");
}
