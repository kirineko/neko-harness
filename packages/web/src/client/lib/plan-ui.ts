import type { PlanMode, PlanRecord, PlanStatus } from "@neko-harness/core/interactions";
import { awaitingTitle } from "./interactions.ts";
import type { NekoState } from "./store.ts";

type Source = Pick<NekoState, "view" | "phase" | "operating">;

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
	awaiting_approval: "待批准",
	approved: "已批准",
	revision_requested: "要求修改",
	superseded: "已取代",
	cancelled: "已取消",
};

export const PLAN_MODE_LABEL = "规划模式（只读）";
export const PLAN_UNSUPPORTED_TEXT = "当前网关不支持规划模式，请重启网关后再试";

export type PlanState = {
	mode: PlanMode;
	/** Newest plan of the session, whatever its status. */
	current: PlanRecord | null;
	/** The plan waiting for the user's decision, if any. */
	awaiting: PlanRecord | null;
	/** Deciding is possible: connected, not switching sessions, and a live view. */
	online: boolean;
};

/** `null` = the gateway does not support plan mode (the view carries no `plan` field). */
export function planState(state: Source): PlanState | null {
	const plan = state.view?.plan;
	if (plan === undefined) return null;
	return {
		mode: plan.mode,
		current: plan.current,
		awaiting: plan.current?.status === "awaiting_approval" ? plan.current : null,
		online: state.phase === "ready" && !state.operating,
	};
}

/** Command argument check for `/plan`: `null` = not the command, "" = plain toggle, otherwise stray arguments. */
export function planCommandArgs(text: string): string | null {
	const match = /^\/plan(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? (match[1]?.trim() ?? "") : null;
}

/** Text for the user's decision outcome; `mine` = the saved record is what this tab asked for. */
export function planSettlementText(record: PlanRecord, mine: boolean): string {
	if (mine) return record.status === "approved" ? "已批准，开始执行计划" : "已提交修改要求，仍在规划模式";
	if (record.status === "superseded") return "该计划已被新的输入取代，没有保存你的决定。";
	if (record.status === "cancelled") return "该计划已取消（运行已停止或已离开规划模式），没有保存你的决定。";
	if (record.status === "awaiting_approval") return "决定尚未保存，请重试。";
	return `该计划已由其他端先处理，以已保存的结果为准：${PLAN_STATUS_LABEL[record.status]}`;
}

/** The status a decision asks for. */
export function decisionStatus(kind: "approve" | "revise"): PlanStatus {
	return kind === "approve" ? "approved" : "revision_requested";
}

/** The server rejects mode changes and decisions while a run is active; translate that code for the hint. */
export function planErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("PLAN_BUSY")) return "会话运行中，请先等待回答结束或停止后再试";
	return message;
}

/** Tab title while hidden: questions keep their count, a waiting plan adds "等待批准". */
export function attentionTitle(base: string, questions: number, plan: boolean): string {
	if (!plan) return awaitingTitle(base, questions);
	return `${questions > 0 ? `(${questions}) 等待回答 · ` : ""}等待批准 · ${base}`;
}
