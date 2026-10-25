import { defineDoc, type ToolRegistration, type Wrap, wrapTool } from "@earendil-works/pi-durable";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { CHANGE_LIMITS, clipDiff } from "./change-limits.ts";
import { countDiffLines, editResultDiff, synthesizedWriteDiff } from "./projection.ts";

/** One successful `edit` / `write` a codemode script made, keyed by its nested call id. */
export type NestedChange = {
	id: string;
	/** The codemode tool call in the transcript that ran the script. */
	parentCallId: string;
	tool: "edit" | "write";
	/** As the script gave it; resolved against the session's cwd when the change index reads it. */
	path: string;
	diff: string;
	added: number;
	removed: number;
	truncated: boolean;
};

export type NestedChangesState = {
	/** Records ever added: grows with every one, so the change index's revision moves when only the oldest are evicted. */
	total: number;
	/** Whether the oldest records were evicted to stay within bounds. */
	dropped: boolean;
	items: NestedChange[];
};

/**
 * Edits and writes made from scripts. A nested call leaves no entry in the transcript and its record retires with its
 * caller, and the arguments in the codemode result are cut, so the change index cannot rebuild them later; each success
 * is recorded here the moment it happens. Rewindable so a fork keeps the records of its fork point.
 */
export const NestedChangesDoc = defineDoc<NestedChangesState>({
	kind: "app.neko.nested-changes",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ total: 0, dropped: false, items: [] }),
});

const bytesOf = (items: readonly NestedChange[]) =>
	items.reduce((sum, item) => sum + Buffer.byteLength(item.diff, "utf8"), 0);

/** Adds a record (replacing one with the same id) and evicts the oldest while over the bounds. */
export function addNestedChange(state: NestedChangesState, change: NestedChange): void {
	const existing = state.items.findIndex((item) => item.id === change.id);
	if (existing !== -1) state.items.splice(existing, 1);
	else state.total += 1;
	state.items.push(change);
	let bytes = bytesOf(state.items);
	while (
		state.items.length > 1 &&
		(state.items.length > CHANGE_LIMITS.nestedRecords || bytes > CHANGE_LIMITS.diffBytes)
	) {
		const evicted = state.items.shift()!;
		bytes -= Buffer.byteLength(evicted.diff, "utf8");
		state.dropped = true;
	}
}

function describe(tool: "edit" | "write", args: unknown, details: unknown) {
	if (tool === "edit") {
		const raw = editResultDiff(details);
		if (raw === null) return { diff: "", added: 0, removed: 0, truncated: false };
		return { ...clipDiff(raw), ...countDiffLines(raw) };
	}
	return synthesizedWriteDiff(args) ?? { diff: "", added: 0, removed: 0, truncated: false };
}

/**
 * Wraps `edit` and `write` so a call made by a script records itself as soon as it succeeds. Direct calls are left
 * alone: their entries already feed the change index.
 */
export function nestedChangeWraps(): Wrap[] {
	const wrap = (reference: ToolRegistration, tool: "edit" | "write"): Wrap =>
		wrapTool(reference, (inner) => ({
			...inner,
			execute: async (args, api, context) => {
				const result = await inner.execute(args as never, api, context);
				const path = (args as { path?: unknown } | undefined)?.path;
				if (result.isError || typeof path !== "string" || path === "") return result;
				const task = await api.getTask(api.taskId, context);
				const input = task?.input as { kind?: string; parentCallId?: unknown } | undefined;
				if (input?.kind !== "nested" || typeof input.parentCallId !== "string") return result;
				const parentCallId = input.parentCallId;
				const change: NestedChange = {
					id: api.callId,
					parentCallId,
					tool,
					path,
					...describe(tool, args, result.details),
				};
				await api.commit(async (tx) => {
					addNestedChange(await tx.doc(NestedChangesDoc, api.conversationId), change);
				}, context);
				return result;
			},
		}));
	return [wrap(createEditTool() as ToolRegistration, "edit"), wrap(createWriteTool() as ToolRegistration, "write")];
}
