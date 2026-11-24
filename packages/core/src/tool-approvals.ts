import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineSignal,
	type Harness,
	hook,
	type TaskId,
	ToolTask,
	type Tx,
	wrapTool,
} from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { obj, oneOf } from "@earendil-works/pi-schema";
import { enabledTools } from "./agent-change.ts";
import { DelegationsDoc, SubagentDoc, SubagentsDoc } from "./subagents.ts";

export type ToolApproval = {
	id: number;
	version: string;
	childId: number;
	delegationTaskId: number;
	callId: string;
	command: string;
	cwd: string;
	timeout: number | null;
	status: "pending" | "allowed" | "denied" | "cancelled";
	createdAt: number;
	decidedAt: number | null;
};
export const ApprovalsDoc = defineDoc<{ items: ToolApproval[] }>({
	kind: "app.neko.approvals",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
});
export const ApprovalSignal = defineSignal({
	name: "app.neko.tool-approval-settled",
	version: 1,
	schema: obj({
		status: oneOf(["allowed", "denied", "cancelled"]),
	}),
});
async function live(tx: Tx, id: number): Promise<boolean> {
	const task = await tx.task(id as TaskId);
	return !!task && !task.abortRequested && task.state.status !== "terminal" && task.state.status !== "completing";
}
export async function cancelRoundApprovals(tx: Tx, parent: ConversationId, delegationTaskId: number): Promise<void> {
	const doc = await tx.doc(ApprovalsDoc, parent);
	const now = Date.now();
	for (const item of doc.items) {
		if (item.delegationTaskId === delegationTaskId && item.status === "pending") {
			item.status = "cancelled";
			item.decidedAt = now;
		}
	}
}
export class ToolApprovals {
	readonly harness: Harness;
	#context: Context;
	#parents = new Set<ConversationId>();
	constructor(harness: Harness, context: Context = BACKGROUND_CONTEXT) {
		this.harness = harness;
		this.#context = context;
	}
	track(...ids: ConversationId[]): void {
		for (const id of ids) this.#parents.add(id);
	}
	async reconcile(parent: ConversationId, context: Context): Promise<void> {
		this.#parents.add(parent);
		const snap = await this.harness.snapshot(ApprovalsDoc, parent, context);
		if (!snap?.items.some((a) => a.status === "pending")) return;
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(ApprovalsDoc, parent);
			const now = Date.now();
			for (const item of doc.items) {
				if (item.status === "pending" && (!(await live(tx, item.id)) || !(await live(tx, item.delegationTaskId)))) {
					item.status = "cancelled";
					item.decidedAt = now;
				}
			}
		}, context);
	}
	async reconcileAll(): Promise<void> {
		for (const parent of this.#parents) await this.reconcile(parent, this.#context);
	}
	async cancelTask(parent: ConversationId, id: number, context: Context): Promise<void> {
		const snap = await this.harness.snapshot(ApprovalsDoc, parent, context);
		if (!snap?.items.some((a) => a.id === id && a.status === "pending")) return;
		await this.harness.commit(async (tx) => {
			const item = (await tx.doc(ApprovalsDoc, parent)).items.find((a) => a.id === id);
			if (item?.status === "pending") {
				item.status = "cancelled";
				item.decidedAt = Date.now();
			}
		}, context);
	}
	async list(parent: ConversationId, context: Context): Promise<ToolApproval[]> {
		this.#parents.add(parent);
		return this.harness.commit(async (tx) => {
			const doc = await tx.doc(ApprovalsDoc, parent);
			for (const item of doc.items) {
				if (item.status === "pending" && (!(await live(tx, item.id)) || !(await live(tx, item.delegationTaskId)))) {
					item.status = "cancelled";
					item.decidedAt = Date.now();
				}
			}
			return JSON.parse(JSON.stringify(doc.items));
		}, context);
	}
	async decide(
		parent: ConversationId,
		delegationTaskId: number,
		id: number,
		version: string,
		decision: "allowed" | "denied",
		context: Context,
	) {
		return this.harness.commit(async (tx) => {
			const delegation = (await tx.doc(DelegationsDoc, parent)).items.find((d) => d.taskId === delegationTaskId);
			const item = (await tx.doc(ApprovalsDoc, parent)).items.find((a) => a.id === id);
			if (
				!delegation ||
				delegation.historyThrough !== undefined ||
				!item ||
				item.delegationTaskId !== delegationTaskId ||
				item.childId !== delegation.childId ||
				item.version !== version
			)
				throw new Error("Approval does not belong to this task or has changed");
			if (item.status !== "pending") return item.status;
			const active = (await live(tx, id)) && (await live(tx, delegationTaskId));
			item.status = active ? decision : "cancelled";
			item.decidedAt = Date.now();
			if (active) await tx.signal(id as TaskId, ApprovalSignal, item.version, { status: item.status });
			return item.status;
		}, context);
	}
	async ensure(
		parent: ConversationId,
		candidate: Omit<ToolApproval, "version" | "status" | "createdAt" | "decidedAt">,
		context: Context,
	): Promise<ToolApproval> {
		this.#parents.add(parent);
		return this.harness.commit(async (tx) => {
			if (!(await live(tx, candidate.id)) || !(await live(tx, candidate.delegationTaskId)))
				throw new Error("Task stopped");
			const doc = await tx.doc(ApprovalsDoc, parent);
			const existing = doc.items.find((a) => a.id === candidate.id);
			if (existing) {
				if (
					existing.command !== candidate.command ||
					existing.cwd !== candidate.cwd ||
					existing.timeout !== candidate.timeout ||
					existing.childId !== candidate.childId
				)
					throw new Error("Approval operation changed; a new call is required");
				return { ...existing };
			}
			const created: ToolApproval = {
				...candidate,
				version: randomUUID(),
				status: "pending",
				createdAt: Date.now(),
				decidedAt: null,
			};
			doc.items.push(created);
			return { ...created };
		}, context);
	}
}
export function createApprovalExtension(service: () => ToolApprovals) {
	return defineExtension({
		name: "neko-tool-approvals",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const role = await api.snapshot(SubagentDoc, api.conversationId, context);
					if (role?.role !== "explore" || call.name !== "bash") return;
					if (role.parentId === null) return { block: "Missing parent session" };
					const approvals = service(),
						parent = role.parentId as ConversationId;
					const existing = (await api.snapshot(ApprovalsDoc, parent, context))?.items.find((a) => a.id === api.taskId);
					if (existing?.status === "denied" || existing?.status === "cancelled") {
						return { block: "Command denied or cancelled by user. Use another approach or report the limitation." };
					}
					const child = await approvals.harness.conversation(api.conversationId, context);
					if (!child) return { block: "Missing child session" };
					const agent = await child.agent(context);
					if (!agent.cwd) return { block: "Missing working directory" };
					const cwd = await realpath(agent.cwd);
					const identity = (await api.snapshot(SubagentsDoc, parent, context))?.items.find(
						(a) => a.childId === api.conversationId,
					);
					const delegation = (await api.snapshot(DelegationsDoc, parent, context))?.items.find(
						(d) =>
							d.childId === api.conversationId &&
							d.historyThrough === undefined &&
							d.taskId === identity?.activeRoundId,
					);
					if (!delegation) return { block: "Missing delegation" };
					const item = await approvals.ensure(
						parent,
						{
							id: api.taskId,
							childId: api.conversationId,
							delegationTaskId: delegation.taskId,
							callId: call.id,
							command: String(call.arguments.command),
							cwd,
							timeout: typeof call.arguments.timeout === "number" ? call.arguments.timeout : null,
						},
						context,
					);
					if (item.status === "pending") {
						return { sleep: { signals: [ApprovalSignal.key(item.version)] } };
					}
					return item.status === "allowed"
						? undefined
						: { block: "Command denied or cancelled by user. Use another approach or report the limitation." };
				},
				afterTool: async (call, _result, api, context) => {
					if (call.name !== "bash") return;
					const role = await api.snapshot(SubagentDoc, api.conversationId, context);
					if (role?.role !== "explore" || role.parentId === null) return;
					await service().cancelTask(role.parentId as ConversationId, api.taskId, context);
					return undefined;
				},
			}),
		],
		wraps: [
			wrapTool(createBashTool(), (bash) => ({
				...bash,
				execute: async (args, api, context) => {
					const role = await api.snapshot(SubagentDoc, api.conversationId, context);
					if (role?.role === "explore") {
						const item =
							role.parentId === null
								? undefined
								: (await api.snapshot(ApprovalsDoc, role.parentId as ConversationId, context))?.items.find(
										(a) => a.id === api.taskId,
									);
						const cwd = api.env && (await api.env.canonicalPath(api.env.cwd, context));
						if (
							!item ||
							item.status !== "allowed" ||
							item.command !== args.command ||
							item.timeout !== (args.timeout ?? null) ||
							!cwd?.ok ||
							cwd.value !== item.cwd
						)
							throw new Error("Bash approval missing or operation changed");
					}
					context.abortSignal?.throwIfAborted();
					return bash.execute(args, api, context);
				},
			})),
		],
	});
}
export async function prepareApprovalConversations(
	harness: Harness,
	ids: ConversationId[],
	extension: ReturnType<typeof createApprovalExtension>,
	context: Context,
) {
	for (const id of ids) {
		if ((await harness.snapshot(SubagentDoc, id, context))?.role !== "explore") continue;
		const child = await harness.conversation(id, context);
		const agent = await child!.agent(context);
		await harness.commit(
			(tx) =>
				configure(tx, id, {
					tools: [...enabledTools(agent).filter((t) => t.name !== "bash"), createBashTool()],
					extensions: { add: [extension] },
				}),
			context,
		);
	}
}
