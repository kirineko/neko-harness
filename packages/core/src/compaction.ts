import type { Context } from "@earendil-works/chord/context";
import {
	type CompactionResult,
	CompactionTask,
	type ConversationId,
	type Harness,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
export type CompactionResultState = "applied" | "nothing" | "skipped" | "cancelled" | "failed";
export type CompactionRecord = {
	taskId: number;
	phase: "summarizing" | "waiting-to-apply" | CompactionResultState;
	at: number;
};
/** Read native receipts, without persisting a second copy of scheduler state. */
export async function readCompaction(
	harness: Harness,
	storage: Storage,
	id: ConversationId,
	context: Context,
): Promise<CompactionRecord | null> {
	const tasks = await harness.commit(
		(tx) => tx.scanTasks({ conversationId: id, kind: CompactionTask.definition.name, order: "descending" }, 1),
		context,
	);
	const latest = tasks.items[0];
	if (!latest) return null;
	const task = await harness.getTask(latest.id as TaskId<CompactionResult>, context);
	if (!task) return null;
	let phase: CompactionRecord["phase"] = "summarizing";
	if (task.state.status === "terminal") {
		const outcome = task.state.outcome;
		if (outcome.status !== "completed")
			phase = outcome.status === "aborted" || task.abortRequested ? "cancelled" : "failed";
		else {
			const result = outcome.result;
			if (result.entryId !== undefined) phase = "applied";
			else if (result.submissionId !== undefined) {
				const s = await storage.submission(result.submissionId, context);
				phase =
					s?.status === "done"
						? "applied"
						: s?.status === "unanswered"
							? s.reason === "aborted"
								? "cancelled"
								: "skipped"
							: "waiting-to-apply";
			} else phase = task.abortRequested ? "cancelled" : "nothing";
		}
	}
	return { taskId: task.id, phase, at: task.endedAt ?? task.startedAt ?? 0 };
}
