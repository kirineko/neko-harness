import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type Extension,
	type Harness,
	hook,
	InboxDoc,
	type ToolRegistration,
	ToolTask,
	wrapTool,
} from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import {
	InteractionInputError,
	PLAN_LIMITS,
	type PlanArgs,
	type PlanDecision,
	type PlanMode,
	type PlanRecord,
	type PlanStatus,
	type PlanView,
	validatePlanArgs,
} from "./interactions.ts";
import { isSafeCommand } from "./plan-bash.ts";
import { PLAN_HISTORY, PLAN_REMOVED_TOOLS, PlanDoc, type PlanItem, type PlanState } from "./plan-doc.ts";
import { queuedUserInput } from "./queued.ts";
import { SubagentDoc } from "./subagents.ts";
import { live } from "./user-questions.ts";

export { PLAN_CODER_BLOCKED, PLAN_INSTRUCTIONS, PLAN_REMOVED_TOOLS, PlanDoc } from "./plan-doc.ts";

export const PLAN_BUSY = "PLAN_BUSY: Wait for the current run to finish or stop it first.";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const toRecord = ({ taskId: _taskId, dispatched: _dispatched, ...record }: PlanItem): PlanRecord => clone(record);

function settle(state: PlanState, item: PlanItem, status: Exclude<PlanStatus, "awaiting_approval">) {
	item.status = status;
	item.settledAt = Date.now();
	state.revision += 1;
}

/** Durable plan mode and plans of every conversation. */
export class PlanService {
	readonly harness: Harness;
	readonly #context: Context;
	constructor(harness: Harness, context: Context) {
		this.harness = harness;
		this.#context = context;
	}

	async #state(id: ConversationId): Promise<Readonly<PlanState> | undefined> {
		return this.harness.snapshot(PlanDoc, id, this.#context);
	}

	async mode(id: ConversationId): Promise<PlanMode> {
		return (await this.#state(id))?.mode ?? "normal";
	}

	async view(id: ConversationId): Promise<PlanView> {
		const state = await this.#state(id);
		const current = state?.items.at(-1);
		return {
			mode: state?.mode ?? "normal",
			revision: state?.revision ?? 0,
			current: current ? toRecord(current as PlanItem) : null,
		};
	}

	async get(id: ConversationId, version: string): Promise<PlanRecord | undefined> {
		const item = (await this.#state(id))?.items.find((i) => i.version === version);
		return item ? toRecord(item as PlanItem) : undefined;
	}

	/** The plan waiting for a decision, if any. */
	async awaiting(id: ConversationId): Promise<PlanRecord | undefined> {
		const item = (await this.#state(id))?.items.find((i) => i.status === "awaiting_approval");
		return item ? toRecord(item as PlanItem) : undefined;
	}

	/** Set the mode; leaving plan mode cancels a plan that still waits. Returns whether the document changed. */
	async setMode(id: ConversationId, mode: PlanMode): Promise<boolean> {
		return this.harness.commit(async (tx) => {
			const state = await tx.doc(PlanDoc, id);
			let changed = false;
			if (state.mode !== mode) {
				state.mode = mode;
				state.revision += 1;
				changed = true;
			}
			if (mode === "normal")
				for (const item of state.items)
					if (item.status === "awaiting_approval") {
						settle(state, item, "cancelled");
						changed = true;
					}
			return changed;
		}, this.#context);
	}

	/** Record the plan of one `submit_plan` call, or return the one an earlier attempt of the same call recorded. */
	async submit(id: ConversationId, taskId: number, args: PlanArgs, context: Context): Promise<PlanRecord> {
		return this.harness.commit(async (tx) => {
			if (!(await live(tx, taskId))) throw new Error("Task stopped");
			const state = await tx.doc(PlanDoc, id);
			const existing = state.items.find((item) => item.taskId === taskId);
			if (existing) {
				if (
					existing.title !== args.title ||
					existing.note !== args.note ||
					JSON.stringify(existing.steps) !== JSON.stringify(args.steps)
				)
					throw new Error("Plan operation changed; a new call is required.");
				return toRecord(existing as PlanItem);
			}
			if (state.mode !== "plan") throw new Error("submit_plan is only available in plan mode.");
			for (const item of state.items) if (item.status === "awaiting_approval") settle(state, item, "superseded");
			const item: PlanItem = {
				version: randomUUID(),
				title: args.title,
				steps: [...args.steps],
				note: args.note,
				status: "awaiting_approval",
				feedback: null,
				createdAt: Date.now(),
				settledAt: null,
				taskId,
				dispatched: false,
			};
			state.items.push(item);
			if (state.items.length > PLAN_HISTORY) state.items.splice(0, state.items.length - PLAN_HISTORY);
			state.revision += 1;
			return toRecord(item);
		}, context);
	}

	/**
	 * The first valid decision wins. Only the waiting version can be decided; any other returns as it is. Approval also
	 * leaves plan mode in the same commit, so no reader sees an approved plan in a plan-mode session.
	 */
	async decide(
		id: ConversationId,
		version: string,
		decision: PlanDecision,
	): Promise<{ record: PlanRecord; item: PlanItem }> {
		return this.harness.commit(async (tx) => {
			const state = await tx.doc(PlanDoc, id);
			const item = state.items.find((i) => i.version === version);
			if (!item) throw new Error("Plan not found.");
			if (item.status === "awaiting_approval") {
				if (decision.kind === "approve") {
					settle(state, item, "approved");
					state.mode = "normal";
				} else {
					settle(state, item, "revision_requested");
					item.feedback = decision.feedback;
				}
			}
			return { record: toRecord(item), item: clone(item) };
		}, this.#context);
	}

	/** A new ordinary input replaces the waiting plan; the session stays in plan mode. */
	async supersedePending(id: ConversationId): Promise<void> {
		if (await this.awaiting(id)) await this.#cancel(id, "superseded");
	}

	/** Stop or archive: a waiting plan can no longer be approved. */
	async cancelPending(id: ConversationId): Promise<void> {
		if (await this.awaiting(id)) await this.#cancel(id, "cancelled");
	}

	async #cancel(id: ConversationId, status: "superseded" | "cancelled") {
		await this.harness.commit(async (tx) => {
			const state = await tx.doc(PlanDoc, id);
			for (const item of state.items) if (item.status === "awaiting_approval") settle(state, item, status);
		}, this.#context);
	}

	/** The latest settled plan whose execute / revise input has not been submitted yet. */
	async undispatched(id: ConversationId): Promise<PlanItem | undefined> {
		const item = (await this.#state(id))?.items.findLast(
			(i) => (i.status === "approved" || i.status === "revision_requested") && !i.dispatched,
		);
		return item ? clone(item as PlanItem) : undefined;
	}

	async markDispatched(id: ConversationId, version: string): Promise<void> {
		await this.harness.commit(async (tx) => {
			const item = (await tx.doc(PlanDoc, id)).items.find((i) => i.version === version);
			if (item) item.dispatched = true;
		}, this.#context);
	}
}

/** Input text that tells the model to execute the approved plan. */
export function approvedPlanPrompt(plan: Pick<PlanRecord, "title" | "steps" | "note">): string {
	return [
		`The user approved your plan "${plan.title}". Plan mode is off: edit, write and all commands are available again. Execute the plan now, step by step:`,
		...plan.steps.map((step, index) => `${index + 1}. ${step}`),
		...(plan.note ? ["", `Notes: ${plan.note}`] : []),
		"",
		"Use the todo tool to track progress, and verify the result when you are done.",
	].join("\n");
}

/** Input text that asks the model to revise the plan. */
export function planRevisionPrompt(plan: Pick<PlanRecord, "title">, feedback: string): string {
	return [
		`The user asked for changes to your plan "${plan.title}". Do not start implementing; you are still in plan mode.`,
		"",
		feedback,
		"",
		"Research what you need, then call submit_plan with the revised plan.",
	].join("\n");
}

const parameters = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.titleChars, description: "Short name of the plan." }),
		steps: Type.Array(Type.String({ minLength: 1, maxLength: PLAN_LIMITS.stepChars }), {
			minItems: 1,
			maxItems: PLAN_LIMITS.maxSteps,
			description: "Ordered, concrete implementation steps.",
		}),
		note: Type.Optional(
			Type.String({ maxLength: PLAN_LIMITS.noteChars, description: "Risks, assumptions and how to verify." }),
		),
	},
	{ additionalProperties: false },
);

/** UI details persisted with the `submit_plan` result: what was submitted, identified by its version. */
export type PlanDetails = { version: string; title: string; steps: string[]; note: string };

function submitPlanTool(service: () => PlanService) {
	return defineTool({
		name: "submit_plan",
		description:
			"Submit your implementation plan for the user's approval. title: short name. steps: ordered, concrete steps. note: optional risks, assumptions and verification. Call it once, as the only tool call of its turn, when your research is done; the turn ends and the user approves it or asks for changes.",
		parameters,
		deferred: true,
		replay: "safe",
		executionMode: "sequential",
		callers: ["model"],
		execute: async (input, api, context) => {
			context.abortSignal?.throwIfAborted();
			if ((await api.snapshot(SubagentDoc, api.conversationId, context))?.role)
				throw new Error("Subagents cannot submit plans; report your findings to the main agent.");
			let args: PlanArgs;
			try {
				args = validatePlanArgs(input);
			} catch (error) {
				if (error instanceof InteractionInputError) throw new Error(`Invalid submit_plan arguments: ${error.message}`);
				throw error;
			}
			let record = await service().submit(api.conversationId, api.taskId, args, context);
			// A user input already queued answers the user's newer intent: it is placed after this plan, so the plan is stale.
			const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
			if (record.status === "awaiting_approval" && inbox?.items.some((item) => queuedUserInput(item))) {
				await service().supersedePending(api.conversationId);
				record = (await service().get(api.conversationId, record.version)) ?? record;
			}
			const details: PlanDetails = {
				version: record.version,
				title: record.title,
				steps: record.steps,
				note: record.note,
			};
			return {
				output: [
					{
						type: "text",
						text: "Plan submitted. It now waits for the user's decision. Stop here: do not call other tools or continue the work.",
					},
				],
				details,
				control: { terminate: true },
			};
		},
	});
}

const unsafeBash = (command: string) =>
	`Plan mode is read-only, so this command was not run (it is not on the read-only allowlist): ${command}\nUse read, find_files or search_text, run a read-only command, or ask the user. If the command is needed, put it in the plan.`;
const blockedTool = (name: string) =>
	`Plan mode is read-only: ${name} is unavailable. Research with read-only tools, then call submit_plan.`;

/** The `submit_plan` tool plus the read-only guards that apply while a session is in plan mode. */
export const createPlanExtension = (service: () => PlanService): Extension =>
	defineExtension({
		name: "neko-plan",
		tools: [submitPlanTool(service) as ToolRegistration],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					if ((await api.snapshot(PlanDoc, api.conversationId, context))?.mode !== "plan") return;
					if ((PLAN_REMOVED_TOOLS as readonly string[]).includes(call.name)) return { block: blockedTool(call.name) };
					if (call.name === "bash") {
						const command = String(call.arguments.command ?? "");
						if (!isSafeCommand(command)) return { block: unsafeBash(command) };
					}
				},
			}),
		],
		wraps: [
			wrapTool(createBashTool(), (bash) => ({
				...bash,
				execute: async (args, api, context) => {
					if (
						(await api.snapshot(PlanDoc, api.conversationId, context))?.mode === "plan" &&
						!isSafeCommand(args.command)
					)
						throw new Error(unsafeBash(args.command));
					return bash.execute(args, api, context);
				},
			})),
		],
	});
