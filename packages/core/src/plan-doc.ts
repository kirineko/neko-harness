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
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ mode: "normal", revision: 0, items: [] }),
});

export const PLAN_CODER_BLOCKED =
	"Plan mode is read-only: the coder subagent is unavailable. Use explore or plan subagents, or finish the plan first.";

/** Tools removed from the session while it plans; a later `edit`/`write`/`job` call cannot even resolve. */
export const PLAN_REMOVED_TOOLS = ["edit", "write", "job"] as const;

export const PLAN_INSTRUCTIONS = [
	"You are in plan mode: research and plan only, and change nothing.",
	"- Allowed: read, find_files, search_text, web_search, web_extract, todo, ask_user, read-only subagents (explore, plan) and bash limited to read-only commands (listing, searching, git log/diff/status, version checks). Other commands are rejected.",
	"- Not available: edit, write, job and any command that modifies files, installs packages or starts processes. Do not try to work around this.",
	"- When you understand the task, call submit_plan once, alone in its turn, with a short title, ordered concrete steps and an optional note (risks, assumptions, verification). The user then approves it or asks for changes.",
	"- After submit_plan do nothing else. If the user asks for changes, research what is needed and submit a revised plan.",
	"- Use ask_user only for decisions you cannot settle by reading the code.",
].join("\n");
