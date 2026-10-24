import type { Context } from "@earendil-works/chord";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type Extension,
	type Harness,
	LiveDoc,
	type TaskId,
	type TaskRuntime,
	type Tx,
	UsageDoc,
	type UsageState,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { NekoInput } from "./input.ts";
import { PLAN_CODER_BLOCKED, PlanDoc } from "./plan-doc.ts";
import type { UsageTotals } from "./projection.ts";
import { emptySubagentUsage, subagentUsageTotals, subtractSubagentUsage } from "./subagent-usage.ts";

export type SubagentRole = "explore" | "plan" | "coder";
export type Delegation = {
	parentId: number;
	taskId: number;
	callId: string;
	childId: number;
	role: SubagentRole;
	title: string;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	report: string | null;
	agentId?: string;
	round?: number;
	runnerId?: number;
	inputEntryId?: number;
	answerEntryId?: number;
	usageStart?: UsageState;
	usageEnd?: UsageState;
	roundUsage?: UsageTotals | null;
	approvalCount?: number;
	historyThrough?: number;
	historyUsage?: UsageTotals;
};
export type SubagentIdentity = {
	agentId: string;
	parentId: number;
	childId: number;
	role: SubagentRole;
	cwd: string;
	title: string;
	createdAt: number;
	activeRoundId: number | null;
};
export type SubagentSummary = {
	agentId: string;
	parentId: number;
	childId: number;
	role: SubagentRole;
	title: string;
	status: "idle" | "queued" | "running";
	activeRoundId: number | null;
	lastRoundId: number;
	lastReport?: string | null;
	roundCount: number;
	taskTitle: string;
	approvalCount: number;
	createdAt: number;
	historyThrough?: number;
	historyUsage?: UsageTotals;
};
export const agentIdFor = (childId: number) => `agent-${childId}`;
export const DelegationsDoc = defineDoc<{ items: Delegation[] }>({
	kind: "app.neko.delegations",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
});
export const SubagentsDoc = defineDoc<{ items: SubagentIdentity[] }>({
	kind: "app.neko.subagents",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] }),
});
export const SubagentDoc = defineDoc<{ role: SubagentRole | null; parentId: number | null }>({
	kind: "app.neko.subagent",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ role: null, parentId: null }),
});
const SlotsDoc = defineDoc<{ items: { taskId: number; parentId: number; cwd: string; coder: boolean }[] }>({
	kind: "app.neko.subagent-slots",
	checkpointWhen: () => false,
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});
export const ROLE_PROMPTS: Record<SubagentRole, string> = {
	explore:
		"You are neko's exploration subagent. Read and search by default. Bash requires explicit user approval for each call and may have side effects. Respect the assigned constraints. After denial use another approach or report the limitation; do not bypass or repeatedly request denied operations. Return findings with paths and line numbers.",
	plan: "You are neko's read-only planning subagent. Read evidence and propose implementation steps, trade-offs and verification. Do not modify files or execute commands.",
	coder:
		"You are neko's coding subagent. Implement only the assigned scope and verify it. Coordinate through the main agent; do not overwrite unrelated changes. Report changed files and verification results.",
};
export const SUBAGENT_DELIVERY =
	" Work from the assigned task, your own prior conversation context and project resources; you cannot see the main conversation. Do not delegate or ask the user directly. Your final message must be a self-contained delivery to the main agent, including evidence, results and limitations. Skills never expand your allowed tools.";
/** Tools only the main agent may use: a subagent reports to its parent instead of planning for or asking the user. */
export const MAIN_ONLY_TOOLS: ReadonlySet<string> = new Set(["todo", "ask_user", "submit_plan"]);
export const MAIN_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(["neko-todos", "neko-questions", "neko-plan"]);
const READ_TOOLS = new Set(["read", "find_files", "search_text", "web_search", "web_extract"]);

export async function refreshDelegations(tx: Tx, id: ConversationId): Promise<Delegation[]> {
	const doc = await tx.doc(DelegationsDoc, id);
	const identities = await tx.doc(SubagentsDoc, id);
	for (const item of doc.items) {
		item.agentId ??= agentIdFor(item.childId);
		item.round ??= doc.items.filter((d) => d.childId === item.childId && d.taskId <= item.taskId).length;
		if (item.historyThrough !== undefined) continue;
		if (item.inputEntryId === undefined) {
			const submission = await tx.submissionByRequest(item.childId as ConversationId, `subagent:${item.taskId}`);
			if (submission?.type === "input" && submission.entry !== undefined) item.inputEntryId = submission.entry;
		}
		let identity = identities.items.find((a) => a.childId === item.childId);
		if (!identity) {
			const role = await tx.doc(SubagentDoc, item.childId as ConversationId);
			if (role.parentId !== id || role.role !== item.role) continue;
			identity = {
				agentId: item.agentId,
				parentId: id,
				childId: item.childId,
				role: item.role,
				cwd: "",
				title: item.title,
				createdAt: item.createdAt,
				activeRoundId: item.taskId,
			};
			identities.items.push(identity);
			identity = identities.items.at(-1)!;
		}
		const task = await tx.task(item.taskId as TaskId);
		const runner = item.runnerId === undefined ? undefined : await tx.task(item.runnerId as TaskId);
		const live = await tx.doc(LiveDoc, item.childId as ConversationId);
		const idle = live.run === undefined && !live.compactions?.length;
		if (task?.state.status === "terminal") {
			if (item.status === "queued" || item.status === "running") {
				item.status = task.state.outcome.status === "aborted" ? "cancelled" : "failed";
				item.endedAt ??= Date.now();
			}
			if (identity.activeRoundId === item.taskId && idle && (!runner || runner.state.status === "terminal"))
				identity.activeRoundId = null;
		}
	}
	return JSON.parse(JSON.stringify(doc.items));
}
export function summarizeSubagents(
	rounds: readonly Delegation[],
	identities: readonly SubagentIdentity[] = [],
): SubagentSummary[] {
	const groups = new Map<string, Delegation[]>();
	for (const round of rounds) {
		const id = round.agentId ?? agentIdFor(round.childId);
		groups.set(id, [...(groups.get(id) ?? []), round]);
	}
	return [...groups].map(([agentId, entries]) => {
		const first = entries[0]!;
		const last = entries.at(-1)!;
		const identity = identities.find((a) => a.agentId === agentId);
		const active = entries.find((r) =>
			identity ? r.taskId === identity.activeRoundId : r.status === "running" || r.status === "queued",
		);
		return {
			agentId,
			parentId: first.parentId,
			childId: first.childId,
			role: first.role,
			title: identity?.title ?? first.title,
			status: active ? (active.status === "queued" ? "queued" : "running") : "idle",
			activeRoundId: active?.taskId ?? null,
			lastRoundId: last.taskId,
			lastReport: last.report?.slice(0, 512) ?? null,
			roundCount: entries.length,
			taskTitle: (active ?? last).title,
			approvalCount: active?.approvalCount ?? 0,
			createdAt: first.createdAt,
			...(first.historyThrough !== undefined
				? { historyThrough: first.historyThrough, historyUsage: first.historyUsage }
				: {}),
		};
	});
}

async function acquireSlot(tx: Tx, round: Delegation, cwd: string) {
	const slots = await tx.doc(SlotsDoc);
	const live: typeof slots.items = [];
	for (const slot of slots.items) {
		const task = await tx.task(slot.taskId as TaskId);
		if (task && task.state.status !== "terminal") live.push(slot);
	}
	slots.items = live;
	if (live.some((slot) => slot.taskId === round.taskId)) return true;
	if (
		live.filter((slot) => slot.parentId === round.parentId).length >= 3 ||
		(round.role === "coder" && live.some((slot) => slot.coder && slot.cwd === cwd))
	)
		return false;
	slots.items.push({ taskId: round.taskId, parentId: round.parentId, cwd, coder: round.role === "coder" });
	return true;
}

type RoundInput = { parentId: number; childId: number; taskId: number; task: string; cwd: string };
type RoundState = { phase: "admission" | "deliver" | "settle" };
type RoundResult = { status: "completed" | "failed" | "cancelled"; report: string };
const actionParameters = Type.Union([
	Type.Object(
		{
			action: Type.Optional(Type.Literal("create")),
			type: Type.Enum(["explore", "plan", "coder"]),
			title: Type.String({ minLength: 1, maxLength: 80 }),
			task: Type.String({ minLength: 1, maxLength: 32768 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("continue"),
			agentId: Type.String(),
			title: Type.String({ minLength: 1, maxLength: 80 }),
			task: Type.String({ minLength: 1, maxLength: 32768 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("list"),
			cursor: Type.Optional(Type.Integer({ minimum: 0 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		},
		{ additionalProperties: false },
	),
]);

// Providers require an object at the tool-schema root. Keep action-specific
// validation local so invalid combinations cannot reach the admission transaction.
const parameters = Type.Object(
	{
		action: Type.Optional(Type.String({ enum: ["create", "continue", "list"], description: "Defaults to create." })),
		type: Type.Optional(Type.String({ enum: ["explore", "plan", "coder"], description: "Required for create only." })),
		agentId: Type.Optional(
			Type.String({ description: "Required for continue only; use an ID returned by create/list." }),
		),
		title: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Required for create/continue." })),
		task: Type.Optional(Type.String({ minLength: 1, maxLength: 32768, description: "Required for create/continue." })),
		cursor: Type.Optional(Type.Integer({ minimum: 0, description: "List pagination cursor only." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "List page size only." })),
	},
	{ additionalProperties: false },
);

const structuredOutputSchema = Type.Union([
	Type.Object(
		{
			agentId: Type.String(),
			roundId: Type.Integer(),
			status: Type.Enum(["completed", "failed", "cancelled"]),
			report: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			items: Type.Array(
				Type.Object(
					{
						agentId: Type.String(),
						parentId: Type.Integer(),
						childId: Type.Integer(),
						role: Type.Enum(["explore", "plan", "coder"]),
						title: Type.String(),
						status: Type.Enum(["idle", "queued", "running"]),
						activeRoundId: Type.Union([Type.Integer(), Type.Null()]),
						lastRoundId: Type.Integer(),
						lastReport: Type.Optional(Type.Union([Type.String(), Type.Null()])),
						roundCount: Type.Integer(),
						taskTitle: Type.String(),
						approvalCount: Type.Integer(),
						createdAt: Type.Number(),
					},
					{ additionalProperties: false },
				),
			),
			next: Type.Union([Type.Integer(), Type.Null()]),
		},
		{ additionalProperties: false },
	),
]);

const ADMISSION_POLL_MS = 100;

/** Waits inside the phase: a slot frees up in this process, so persisting each poll as a sleep would only add writes. */
function pause(runtime: Pick<TaskRuntime<never, never, never, object>, "signal" | "setTimer">, ms: number) {
	const { signal } = runtime;
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const disarm = runtime.setTimer(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		const abort = () => {
			disarm();
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

export function createSubagentExtension(
	prepare: (id: ConversationId, requestId: string, cwd: string) => Promise<void>,
	discard: (id: ConversationId, requestId: string) => void,
	guard?: (model: { provider: string; modelId: string }) => Promise<void>,
): Extension {
	const finish = async (tx: Tx, input: RoundInput, status: RoundResult["status"], report: string) => {
		const round = (await tx.doc(DelegationsDoc, input.parentId as ConversationId)).items.find(
			(r) => r.taskId === input.taskId,
		)!;
		round.status = status;
		round.report = report;
		round.endedAt ??= Date.now();
		round.usageEnd = JSON.parse(JSON.stringify(await tx.doc(UsageDoc, input.childId as ConversationId)));
		round.roundUsage = round.usageStart
			? subagentUsageTotals(subtractSubagentUsage(round.usageEnd!, round.usageStart))
			: round.startedAt === null
				? subagentUsageTotals(emptySubagentUsage())
				: null;
	};
	const RoundTask = defineTask<RoundInput, RoundState, RoundResult>({
		name: "app.neko.subagent-round",
		version: 1,
		initial: () => ({ phase: "admission" }),
		phases: {
			admission: async (task, runtime, ctx) => {
				const env = await runtime.env(ctx);
				const canonical = env && (await env.canonicalPath(task.input.cwd, ctx));
				const slotCwd = canonical?.ok ? canonical.value : task.input.cwd;
				let admitted = false;
				while (!admitted) {
					await runtime.commit(async (tx) => {
						const round = (await tx.doc(DelegationsDoc, task.input.parentId as ConversationId)).items.find(
							(r) => r.taskId === task.input.taskId,
						)!;
						if (!(await acquireSlot(tx, round, slotCwd))) return;
						admitted = true;
						const duplicate = await tx.submissionByRequest(
							task.input.childId as ConversationId,
							`subagent:${round.taskId}`,
						);
						if (!duplicate && !round.usageStart)
							round.usageStart = JSON.parse(
								JSON.stringify(await tx.doc(UsageDoc, task.input.childId as ConversationId)),
							);
						round.status = "running";
						round.startedAt ??= Date.now();
						return { status: "running", checkpoint: { phase: "deliver" } };
					}, ctx);
					if (!admitted) await pause(runtime, ADMISSION_POLL_MS);
				}
			},
			deliver: async (task, runtime, ctx) => {
				const input = task.input;
				const child = (await runtime.conversation(input.childId as ConversationId, ctx))!;
				const requestId = `subagent:${input.taskId}`;
				try {
					let duplicate = false;
					await runtime.commit(async (tx) => {
						duplicate = !!(await tx.submissionByRequest(input.childId as ConversationId, requestId));
					}, ctx);
					if (!duplicate) await prepare(input.childId as ConversationId, requestId, input.cwd);
					const submission = await child.submit(
						{
							type: "input",
							content: input.task,
							requestId,
							whenBusy: "reject",
							entry: {
								kind: NekoInput.kind,
								data: { at: Date.now(), prompt: input.task, images: [], subagentRoundId: input.taskId },
							},
						},
						ctx,
					);
					const placed = await submission.status(ctx);
					await runtime.commit(async (tx) => {
						if (placed.type === "input" && placed.entry !== undefined)
							(await tx.doc(DelegationsDoc, input.parentId as ConversationId)).items.find(
								(r) => r.taskId === input.taskId,
							)!.inputEntryId = placed.entry;
						return { status: "running", checkpoint: { phase: "settle" } };
					}, ctx);
				} catch (error) {
					discard(input.childId as ConversationId, requestId);
					if (ctx.abortSignal?.aborted) throw error;
					await child.abort(ctx);
					const report = `Subagent failed: ${String(error)}`;
					await runtime.commit(async (tx) => {
						await finish(tx, input, "failed", report);
						return { status: "terminal", outcome: { status: "completed", result: { status: "failed", report } } };
					}, ctx);
				}
			},
			settle: async (task, runtime, ctx) => {
				const input = task.input;
				const child = (await runtime.conversation(input.childId as ConversationId, ctx))!;
				// A repeat returns the same submission without accepting a second input.
				const submission = await child.submit(
					{ type: "input", content: input.task, requestId: `subagent:${input.taskId}` },
					ctx,
				);
				const settled = await submission.wait(ctx);
				await child.waitForIdle(ctx);
				await runtime.commit(async (tx) => {
					let report = "";
					let status: RoundResult["status"] = "failed";
					const round = (await tx.doc(DelegationsDoc, input.parentId as ConversationId)).items.find(
						(r) => r.taskId === input.taskId,
					)!;
					if (settled.type === "input" && settled.entry !== undefined) round.inputEntryId = settled.entry;
					if (settled.status === "done" && settled.type === "input") {
						round.answerEntryId = settled.answer;
						const message = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
						report =
							message?.role === "assistant"
								? message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
								: "";
						status = "completed";
					} else if (settled.status === "unanswered") {
						status = settled.reason === "aborted" ? "cancelled" : "failed";
						report = `Subagent ${status}: ${settled.reason}`;
					}
					await finish(tx, input, status, report);
					return { status: "terminal", outcome: { status: "completed", result: { status, report } } };
				}, ctx);
			},
		},
		abort: async (task, runtime, ctx) => {
			const input = task.input;
			let own = false;
			await runtime.commit(async (tx) => {
				own = (await tx.doc(SubagentsDoc, input.parentId as ConversationId)).items.some(
					(a) => a.childId === input.childId && a.activeRoundId === input.taskId,
				);
			}, ctx);
			if (own) await (await runtime.conversation(input.childId as ConversationId, ctx))?.abort(ctx);
			await runtime.commit(async (tx) => {
				await finish(tx, input, "cancelled", "Subagent cancelled");
				return { status: "terminal", outcome: { status: "aborted" } };
			}, ctx);
		},
	});
	const extension: Extension = defineExtension({
		name: "neko-subagents",
		tasks: [RoundTask],
		tools: [
			defineTool({
				name: "subagent",
				description:
					"Manage persistent foreground subagents. create (default): type explore/plan/coder, title, task. continue: agentId, title, task; reuses its own context, only while idle. list: discover this session's agents, optional cursor/limit. Explore Bash requires per-call user approval. Keep constraints explicit; verify and integrate final reports. Subagents cannot delegate.",
				parameters,
				structuredOutputSchema,
				replay: "safe",
				execute: async (input, api, context) => {
					if (!Value.Check(actionParameters, input))
						throw new Error(
							"Invalid subagent arguments. create requires type/title/task; continue requires agentId/title/task; list accepts only cursor/limit. Do not mix fields from different actions.",
						);
					const args = input;
					if ((await api.snapshot(SubagentDoc, api.conversationId, context))?.role)
						throw new Error("Subagents cannot delegate.");
					if (args.action === "list") {
						const list = await api.commit(async (tx) => {
							const rounds = await refreshDelegations(tx, api.conversationId);
							return summarizeSubagents(rounds, (await tx.doc(SubagentsDoc, api.conversationId)).items).filter(
								(a) => a.historyThrough === undefined,
							);
						}, context);
						const offset = args.cursor ?? 0;
						const items = list.slice(offset, offset + (args.limit ?? 50));
						const result = { items, next: offset + items.length < list.length ? offset + items.length : null };
						return { output: [{ type: "text", text: JSON.stringify(result) }], structuredOutput: result };
					}
					if (!args.task.trim() || !args.title.trim() || Buffer.byteLength(args.task) > 32768)
						throw new Error("Task/title must be nonempty; task limit is 32 KiB.");
					const agent = await api.agent(context);
					if (agent.model) await guard?.(agent.model);
					const round = await api.commit(async (tx) => {
						const rounds = await refreshDelegations(tx, api.conversationId);
						const receipt = rounds.find((r) => r.taskId === api.taskId);
						if (receipt?.runnerId !== undefined) return receipt;
						const identities = await tx.doc(SubagentsDoc, api.conversationId);
						let identity: SubagentIdentity | undefined;
						// A coder writes files, so plan mode must not start or resume one; a started round is not re-checked.
						const planning = !receipt && (await tx.doc(PlanDoc, api.conversationId)).mode === "plan";
						if (planning && args.action !== "continue" && args.type === "coder") throw new Error(PLAN_CODER_BLOCKED);
						if (args.action === "continue") {
							identity = identities.items.find((a) => a.agentId === args.agentId);
							if (!identity) throw new Error("Unknown subagent or it belongs to another conversation.");
							const info = await tx.doc(SubagentDoc, identity.childId as ConversationId);
							if (info.parentId !== api.conversationId || info.role !== identity.role)
								throw new Error("Subagent ownership mismatch.");
							if (planning && identity.role === "coder") throw new Error(PLAN_CODER_BLOCKED);
							if (identity.activeRoundId !== null) throw new Error("Subagent is busy; continue only when idle.");
						} else if (receipt) {
							identity = identities.items.find((a) => a.childId === receipt.childId);
						}
						const existing = identity
							? undefined
							: (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						const child = identity ? await tx.conversation(identity.childId as ConversationId) : existing;
						if (!identity) {
							const created =
								child ?? (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }));
							const role = args.action === "continue" ? "explore" : args.type;
							await configure(tx, created.id, {
								model: agent.model,
								thinkingLevel: agent.thinkingLevel,
								cwd: agent.cwd,
								extensions: agent.extensions.filter(
									(e) => e.name !== extension.name && !MAIN_ONLY_EXTENSIONS.has(e.name),
								),
								tools: agent.tools.filter(
									(t) =>
										t.name !== "subagent" &&
										t.name !== "job" &&
										!MAIN_ONLY_TOOLS.has(t.name) &&
										(role === "coder" || READ_TOOLS.has(t.name) || (role === "explore" && t.name === "bash")),
								),
							});
							Object.assign(await tx.doc(SubagentDoc, created.id), { role, parentId: api.conversationId });
							identity = {
								agentId: agentIdFor(created.id),
								parentId: api.conversationId,
								childId: created.id,
								role,
								cwd: agent.cwd ?? "",
								title: args.title,
								createdAt: Date.now(),
								activeRoundId: null,
							};
							identities.items.push(identity);
						}
						const record: Delegation = receipt ?? {
							parentId: api.conversationId,
							taskId: api.taskId,
							callId: api.callId,
							childId: identity.childId,
							agentId: identity.agentId,
							round: rounds.filter((r) => r.childId === identity!.childId).length + 1,
							role: identity.role,
							title: args.title,
							createdAt: Date.now(),
							startedAt: null,
							endedAt: null,
							status: "queued",
							report: null,
						};
						identities.items.find((a) => a.agentId === identity!.agentId)!.activeRoundId = api.taskId;
						const runner = await tx.createTask(
							RoundTask,
							{
								parentId: api.conversationId,
								childId: identity.childId,
								taskId: api.taskId,
								task: args.task,
								cwd: identity.cwd || agent.cwd || "",
							},
							{ ownership: { kind: "task", taskId: api.taskId } },
						);
						record.runnerId = runner;
						const doc = await tx.doc(DelegationsDoc, api.conversationId);
						if (receipt) Object.assign(doc.items.find((r) => r.taskId === receipt.taskId)!, record);
						else doc.items.push(record);
						return record;
					}, context);
					await api.details(
						{
							conversationId: round.childId,
							agentId: round.agentId!,
							roundId: round.taskId,
							role: round.role,
							title: round.title,
						},
						context,
					);
					const settled = await api.waitForTask(round.runnerId as TaskId<RoundResult>, context);
					const outcome = settled.state.outcome;
					const result =
						outcome.status === "completed"
							? outcome.result
							: { status: outcome.status === "aborted" ? "cancelled" : "failed", report: `Subagent ${outcome.status}` };
					return {
						output: [
							{
								type: "text",
								text: `Agent: ${round.agentId}\nStatus: ${result.status}\n${result.report || "Subagent completed without a text report."}`,
							},
						],
						isError: result.status !== "completed",
						structuredOutput: { agentId: round.agentId!, roundId: round.taskId, ...result },
						details: {
							conversationId: round.childId,
							agentId: round.agentId!,
							roundId: round.taskId,
							role: round.role,
							title: round.title,
							status: result.status,
						},
					};
				},
			}),
		],
	});
	return extension;
}

export async function listDelegations(harness: Harness, parent: ConversationId, context: Context) {
	const rounds = await harness.commit((tx) => refreshDelegations(tx, parent), context);
	// Reconcile an unexpectedly ended driver/legacy invocation before unlocking its reusable conversation.
	for (const round of rounds) {
		if (round.historyThrough !== undefined) continue;
		const task = await harness.getTask(round.taskId as TaskId, context);
		if (task?.state.status !== "terminal") continue;
		const child = await harness.conversation(round.childId as ConversationId, context);
		const live = await harness.snapshot(LiveDoc, round.childId as ConversationId, context);
		const identity = (await harness.snapshot(SubagentsDoc, parent, context))?.items.find(
			(a) => a.childId === round.childId,
		);
		if (identity?.activeRoundId === round.taskId && live?.run !== undefined) await child?.abort(context);
	}
	return harness.commit((tx) => refreshDelegations(tx, parent), context);
}
export async function listSubagents(harness: Harness, parent: ConversationId, context: Context) {
	const rounds = await listDelegations(harness, parent, context);
	return summarizeSubagents(rounds, (await harness.snapshot(SubagentsDoc, parent, context))?.items);
}
/** Startup repair: a subagent that somehow lists a main-only tool loses it, whatever its stored configuration says. */
export async function removeMainOnlyTools(harness: Harness, ids: ConversationId[], context: Context) {
	for (const id of ids) {
		if (!(await harness.snapshot(SubagentDoc, id, context))?.role) continue;
		const agent = await (await harness.conversation(id, context))!.agent(context);
		if (!agent.tools.some((t) => MAIN_ONLY_TOOLS.has(t.name))) continue;
		await harness.commit(
			(tx) => configure(tx, id, { tools: agent.tools.filter((t) => !MAIN_ONLY_TOOLS.has(t.name)) }),
			context,
		);
	}
}
export async function installSubagentCoordinator(harness: Harness, parents: ConversationId[], context: Context) {
	const known = new Set(parents);
	let running = false;
	let dirty = false;
	const reconcile = async () => {
		if (running) {
			dirty = true;
			return;
		}
		running = true;
		try {
			do {
				dirty = false;
				for (const id of known) await listDelegations(harness, id, context);
			} while (dirty);
		} finally {
			running = false;
		}
	};
	for (const parent of parents) {
		await harness.commit((tx) => refreshDelegations(tx, parent), context);
		for (const identity of (await harness.snapshot(SubagentsDoc, parent, context))?.items ?? []) {
			if (identity.cwd) continue;
			const child = await harness.conversation(identity.childId as ConversationId, context);
			const cwd = (await child?.agent(context))?.cwd;
			if (cwd)
				await harness.commit(async (tx) => {
					(await tx.doc(SubagentsDoc, parent)).items.find((a) => a.agentId === identity.agentId)!.cwd = cwd;
				}, context);
		}
	}
	const stop = harness.subscribeCommits(({ changes }) => {
		for (const c of changes)
			if (c.type === "document" && c.record.kind === "app.neko.delegations" && c.conversationId !== undefined)
				known.add(c.conversationId as ConversationId);
		if (changes.some((c) => c.type === "task" && c.value.state.status === "terminal")) void reconcile().catch(() => {});
	});
	harness.closed.finally(stop).catch(() => {});
}
