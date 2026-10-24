import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	type Harness,
	hook,
	type TaskId,
	ToolTask,
	type Tx,
	wrapTool,
} from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
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
async function live(tx: Tx, id: number): Promise<boolean> {
	const task = await tx.task(id as TaskId);
	return !!task && !task.abortRequested && task.state.status !== "terminal" && task.state.status !== "completing";
}
export class ToolApprovals {
	readonly harness: Harness;
	#parents = new Set<ConversationId>();
	constructor(harness: Harness, context: Context) {
		this.harness = harness;
		const stop = harness.subscribeCommits(({ changes }) => {
			if (!changes.some((c) => c.type === "task" && (c.value.abortRequested || c.value.state.status === "terminal")))
				return;
			for (const parent of this.#parents) void this.list(parent, context).catch(() => {});
		});
		harness.closed.finally(stop).catch(() => {});
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
			item.status = (await live(tx, id)) && (await live(tx, delegationTaskId)) ? decision : "cancelled";
			item.decidedAt = Date.now();
			return item.status;
		}, context);
	}
	async wait(parent: ConversationId, id: number, context: Context): Promise<ToolApproval> {
		const state = await this.harness.documentState(ApprovalsDoc, parent, context);
		if (!state) throw new Error("Approval unavailable");
		try {
			return await new Promise((resolve, reject) => {
				let stop = () => {};
				const cleanup = () => {
					stop();
					context.abortSignal?.removeEventListener("abort", abort);
				};
				const abort = () => {
					cleanup();
					reject(context.abortSignal?.reason ?? new Error("Cancelled"));
				};
				const check = () => {
					const item = state.value?.items.find((a) => a.id === id);
					if (item && item.status !== "pending") {
						cleanup();
						resolve(structuredClone(item));
					}
				};
				stop = state.subscribe(check);
				context.abortSignal?.addEventListener("abort", abort, { once: true });
				if (context.abortSignal?.aborted) abort();
				else check();
			});
		} finally {
			state.dispose();
		}
	}
	async ensure(
		parent: ConversationId,
		candidate: Omit<ToolApproval, "version" | "status" | "createdAt" | "decidedAt">,
		context: Context,
	) {
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
				return;
			}
			doc.items.push({
				...candidate,
				version: randomUUID(),
				status: "pending",
				createdAt: Date.now(),
				decidedAt: null,
			});
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
					const child = await approvals.harness.conversation(api.conversationId, context);
					const agent = await child!.agent(context);
					const cwd = await realpath(agent.cwd!);
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
					await approvals.ensure(
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
					const result = await approvals.wait(parent, api.taskId, context);
					return result.status === "allowed"
						? undefined
						: { block: "Command denied or cancelled by user. Use another approach or report the limitation." };
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
					tools: [...agent.tools.filter((t) => t.name !== "bash"), createBashTool()],
					extensions: { add: [extension] },
				}),
			context,
		);
	}
}
