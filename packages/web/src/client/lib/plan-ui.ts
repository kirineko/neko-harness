import type { PlanMode, PlanRecord, PlanStatus } from "@neko-harness/core/interactions";
import { getT, type PlainKey } from "./i18n/index.ts";
import { awaitingTitle } from "./interactions.ts";
import type { NekoState } from "./store.ts";

type Source = Pick<NekoState, "view" | "phase" | "operating">;

const PLAN_STATUS_KEY: Record<PlanStatus, PlainKey> = {
	awaiting_approval: "plan.status.awaiting_approval",
	approved: "plan.status.approved",
	revision_requested: "plan.status.revision_requested",
	superseded: "plan.status.superseded",
	cancelled: "plan.status.cancelled",
};

export const planStatusLabel = (status: PlanStatus): string => getT()(PLAN_STATUS_KEY[status]);
export const planModeLabel = (): string => getT()("plan.modeLabel");
export const planUnsupportedText = (): string => getT()("plan.unsupported");

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
	const t = getT();
	if (mine) return record.status === "approved" ? t("plan.settle.approved") : t("plan.settle.revised");
	if (record.status === "superseded") return t("plan.settle.superseded");
	if (record.status === "cancelled") return t("plan.settle.cancelled");
	if (record.status === "awaiting_approval") return t("plan.settle.pending");
	return t("plan.settle.other", { status: planStatusLabel(record.status) });
}

/** The status a decision asks for. */
export function decisionStatus(kind: "approve" | "revise"): PlanStatus {
	return kind === "approve" ? "approved" : "revision_requested";
}

/** Whether the error is the server's `PLAN_BUSY` rejection (mode changes and decisions need an idle session). */
export function isPlanBusy(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).includes("PLAN_BUSY");
}

/** The server rejects mode changes and decisions while a run is active; translate that code for the hint. */
export function planErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (isPlanBusy(error)) return getT()("plan.busy");
	return message;
}

/** Tab title while hidden: questions keep their count, a waiting plan adds "等待批准". */
export function attentionTitle(base: string, questions: number, plan: boolean): string {
	if (!plan) return awaitingTitle(base, questions);
	const t = getT();
	return `${questions > 0 ? t("title.answerPrefix", { count: questions }) : ""}${t("title.planPrefix")}${base}`;
}
