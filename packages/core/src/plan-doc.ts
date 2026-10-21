import { defineDoc } from "@earendil-works/pi-durable";
import type { PlanMode, PlanRecord } from "./interactions.ts";

/** One submitted plan; `taskId` is the `submit_plan` call's tool task id and makes submission idempotent. */
export type PlanItem = PlanRecord & {
	taskId: number;
	/** Whether the input a decision produces (execute / revise) has been submitted. */
	dispatched: boolean;
};

export type PlanState = { mode: PlanMode; revision: number; items: PlanItem[] };

/** Plans kept per session; older ones are dropped when a new one is submitted. */
export const PLAN_HISTORY = 5;

/**
 * The session's plan mode and plans. This document is authoritative; the agent configuration (tools, instructions)
 * is a projection of `mode` and is reconciled against it. Rewindable so a fork keeps the plan state of its fork point.
 */
export const PlanDoc = defineDoc<PlanState>({
	kind: "app.neko.plan",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ mode: "normal", revision: 0, items: [] }),
});

export const PLAN_CODER_BLOCKED =
	"Plan mode is read-only: the coder subagent is unavailable. Use explore or plan subagents, or finish the plan first.";
