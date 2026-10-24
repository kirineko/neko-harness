import { defineDoc, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
	TODO_LIMITS,
	TODO_STATUSES,
	type TodoItem,
	type TodoList,
	todoProgress,
	validateTodoItems,
} from "./interactions.ts";
import { SubagentDoc } from "./subagents.ts";

/**
 * The session's todo list. Rewindable so a fork inherits the list as of its fork point; later edits of parent and
 * fork are independent.
 */
export const TodosDoc = defineDoc<TodoList>({
	kind: "app.neko.todos",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ revision: 0, items: [] }),
});

/**
 * What one `replace` call applied, written in the same commit as the list. A replayed call returns it instead of
 * writing again, so a replay never rolls a newer list back to an older value.
 */
const TodoReceiptDoc = defineDoc<{ applied: boolean; revision: number; items: TodoItem[] }>({
	kind: "app.neko.todo-receipt",
	checkpointWhen: () => false,
	version: 1,
	scope: "task",
	initial: () => ({ applied: false, revision: 0, items: [] }),
});

const itemSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			maxLength: TODO_LIMITS.idChars,
			description: "Stable id; keep it when you update the same task.",
		}),
		text: Type.String({ minLength: 1, maxLength: TODO_LIMITS.textChars }),
		status: Type.String({ enum: [...TODO_STATUSES] }),
	},
	{ additionalProperties: false },
);
const parameters = Type.Object(
	{
		action: Type.String({ enum: ["list", "replace"], description: "list reads the list; replace overwrites it." }),
		items: Type.Optional(
			Type.Array(itemSchema, {
				maxItems: TODO_LIMITS.maxItems,
				description: "Required for replace only: the complete ordered list; [] clears it.",
			}),
		),
	},
	{ additionalProperties: false },
);
const structuredOutputSchema = Type.Object(
	{ revision: Type.Integer({ minimum: 0 }), items: Type.Array(itemSchema) },
	{ additionalProperties: false },
);

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function renderTodos(list: TodoList): string {
	const { completed, total } = todoProgress(list.items);
	if (!total) return `Todo list is empty (revision ${list.revision}).`;
	const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
	return [
		`Todo list, revision ${list.revision}, ${completed}/${total} completed:`,
		...list.items.map((item) => `${mark[item.status]} ${item.id}: ${item.text}`),
	].join("\n");
}

/** The `todo` tool: the model keeps an ordered plan; users only read it. */
export function createTodoTool() {
	return defineTool({
		name: "todo",
		description:
			"Keep a structured todo list for the current multi-step task. list: read the saved list. replace: items [{id, text, status}] overwrites the whole ordered list (status pending, in_progress or completed; [] clears it). Keep ids stable when updating a task and mark completed only after the work is actually done. Users see the list but cannot edit it.",
		parameters,
		structuredOutputSchema,
		replay: "safe",
		executionMode: "sequential",
		callers: ["model"],
		execute: async (input, api, context) => {
			context.abortSignal?.throwIfAborted();
			if ((await api.snapshot(SubagentDoc, api.conversationId, context))?.role)
				throw new Error("Subagents cannot use todo.");
			const args = input as { action: "list" | "replace"; items?: unknown };
			let list: TodoList;
			if (args.action === "list") {
				if (args.items !== undefined) throw new Error("list does not accept items.");
				const saved = await api.snapshot(TodosDoc, api.conversationId, context);
				list = saved ? clone(saved) : { revision: 0, items: [] };
			} else {
				if (args.items === undefined) throw new Error("replace requires items.");
				const items = validateTodoItems(args.items);
				list = await api.commit(async (tx) => {
					const receipt = await tx.doc(TodoReceiptDoc, api.taskId);
					if (receipt.applied) {
						if (JSON.stringify(clone(receipt.items)) !== JSON.stringify(items))
							throw new Error("This todo call was already applied with different items.");
						return { revision: receipt.revision, items: clone(receipt.items) };
					}
					const doc = await tx.doc(TodosDoc, api.conversationId);
					doc.revision += 1;
					doc.items = items;
					receipt.applied = true;
					receipt.revision = doc.revision;
					receipt.items = items;
					return { revision: doc.revision, items: clone(items) };
				}, context);
			}
			const { completed, total } = todoProgress(list.items);
			return {
				output: [{ type: "text", text: renderTodos(list) }],
				structuredOutput: list,
				details: { action: args.action, revision: list.revision, completed, total },
			};
		},
	});
}

export const createTodoExtension = (): Extension => defineExtension({ name: "neko-todos", tools: [createTodoTool()] });
