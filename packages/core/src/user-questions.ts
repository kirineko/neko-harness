import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTool,
	type Extension,
	type Harness,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
	answerLabels,
	InteractionInputError,
	QUESTION_LIMITS,
	type QuestionArgs,
	type QuestionList,
	type QuestionRecord,
	type QuestionResponse,
	sameQuestion,
	summarizeQuestion,
	validateQuestionArgs,
	validateQuestionResponse,
} from "./interactions.ts";
import { SubagentDoc } from "./subagents.ts";

/**
 * One question per `ask_user` call, keyed by the call's tool task id. A fork starts without any, so it can neither
 * show nor answer the parent's open questions; settled records stay for receipt retries.
 */
export const QuestionDoc = defineDocFamily<QuestionRecord, QuestionRecord>({
	kind: "app.neko.question",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => seed,
});

/** Light live index: only the ids that still wait for the user, so views never carry the whole history. */
export const QuestionsDoc = defineDoc<{ revision: number; pending: number[] }>({
	kind: "app.neko.questions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ revision: 0, pending: [] }),
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const MISSING: QuestionRecord = {
	id: 0,
	callId: "",
	version: "",
	question: "",
	multiple: false,
	options: [],
	status: "pending",
	answer: null,
	createdAt: 0,
	settledAt: null,
};
const argsOf = (record: Pick<QuestionRecord, "question" | "multiple" | "options">): QuestionArgs => ({
	question: record.question,
	multiple: record.multiple,
	options: clone(record.options),
});

/** A task is live while neither it nor any task above it has an abort mark or has ended. */
export async function live(tx: Tx, id: number): Promise<boolean> {
	let cursor: number | undefined = id;
	for (let depth = 0; cursor !== undefined && depth < 16; depth++) {
		const task = await tx.task(cursor as TaskId);
		if (!task || task.abortRequested || task.state.status === "terminal" || task.state.status === "completing")
			return false;
		cursor = task.owner;
	}
	return true;
}

/** Settle one pending record in a transaction and drop it from the index. */
function settle(
	record: QuestionRecord,
	index: { revision: number; pending: number[] },
	status: Exclude<QuestionRecord["status"], "pending">,
) {
	record.status = status;
	record.settledAt = Date.now();
	index.pending = index.pending.filter((id) => id !== record.id);
	index.revision += 1;
}

/** Durable questions of every conversation: creation, waiting, first-settle answers and cancellation. */
export class UserQuestions {
	readonly harness: Harness;
	#tracked = new Set<ConversationId>();
	#context: Context;
	#running = false;
	#dirty = false;
	constructor(harness: Harness, context: Context) {
		this.harness = harness;
		this.#context = context;
		const stop = harness.subscribeCommits(({ changes }) => {
			if (!changes.some((c) => c.type === "task" && (c.value.abortRequested || c.value.state.status === "terminal")))
				return;
			void this.reconcileAll();
		});
		harness.closed.finally(stop).catch(() => {});
	}

	/** Remember conversations whose open questions must be reconciled when tasks stop. */
	track(...ids: ConversationId[]) {
		for (const id of ids) this.#tracked.add(id);
	}

	async reconcileAll(): Promise<void> {
		if (this.#running) {
			this.#dirty = true;
			return;
		}
		this.#running = true;
		try {
			do {
				this.#dirty = false;
				for (const id of [...this.#tracked]) await this.reconcile(id, this.#context).catch(() => {});
			} while (this.#dirty);
		} finally {
			this.#running = false;
		}
	}

	/** Cancel open questions whose call or run has stopped, so late answers cannot restart anything. */
	async reconcile(conversationId: ConversationId, context: Context): Promise<void> {
		const index = await this.harness.snapshot(QuestionsDoc, conversationId, context);
		if (!index?.pending.length) return;
		await this.harness.commit((tx) => this.#reconcile(tx, conversationId), context);
	}

	async #reconcile(tx: Tx, conversationId: ConversationId) {
		const index = await tx.doc(QuestionsDoc, conversationId);
		const stale: number[] = [];
		for (const id of index.pending) {
			const record = await tx.doc(QuestionDoc, conversationId, String(id), MISSING);
			if (record.version === "" || record.status !== "pending") stale.push(id);
			else if (!(await live(tx, id))) {
				record.status = "cancelled";
				record.settledAt = Date.now();
				stale.push(id);
			}
		}
		if (!stale.length) return;
		index.pending = index.pending.filter((id) => !stale.includes(id));
		index.revision += 1;
	}

	/** Create the question for this call, or return the one an earlier attempt of the same call created. */
	async ensure(
		conversationId: ConversationId,
		taskId: number,
		callId: string,
		args: QuestionArgs,
		context: Context,
	): Promise<QuestionRecord> {
		this.track(conversationId);
		return this.harness.commit(async (tx) => {
			if (!(await live(tx, taskId))) throw new Error("Task stopped");
			const seed: QuestionRecord = {
				id: taskId,
				callId,
				version: randomUUID(),
				question: args.question,
				multiple: args.multiple,
				options: clone(args.options),
				status: "pending",
				answer: null,
				createdAt: Date.now(),
				settledAt: null,
			};
			const record = await tx.doc(QuestionDoc, conversationId, String(taskId), seed);
			if (record.version !== seed.version) {
				if (record.callId !== callId || !sameQuestion(argsOf(record), args))
					throw new Error("Question operation changed; a new call is required.");
				return clone(record) as QuestionRecord;
			}
			const index = await tx.doc(QuestionsDoc, conversationId);
			if (index.pending.length >= QUESTION_LIMITS.maxPending)
				throw new Error(
					`Too many unanswered questions (limit ${QUESTION_LIMITS.maxPending}). Wait for answers before asking more.`,
				);
			index.pending.push(taskId);
			index.revision += 1;
			return clone(record) as QuestionRecord;
		}, context);
	}

	/**
	 * Wait until the record leaves `pending`. The watch is taken first and its current value checked before any
	 * listener runs, so an answer committed in between cannot be missed; ending the watch rejects the wait.
	 */
	async wait(conversationId: ConversationId, id: number, context: Context): Promise<QuestionRecord> {
		const watch = await this.harness.watchDoc(QuestionDoc, conversationId, String(id), context);
		if (!watch) throw new Error("Question unavailable");
		const signal = context.abortSignal;
		let onAbort = () => {};
		try {
			return await new Promise<QuestionRecord>((resolve, reject) => {
				let done = false;
				const finish = (action: () => void) => {
					if (done) return;
					done = true;
					action();
				};
				const check = (value: Readonly<QuestionRecord> | null) => {
					if (value && value.status !== "pending") finish(() => resolve(clone(value) as QuestionRecord));
				};
				onAbort = () => finish(() => reject(signal?.reason ?? new Error("Cancelled")));
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) return onAbort();
				void watch.closed.then((end) => {
					if (end.reason === "stopped") return;
					finish(() =>
						reject(
							signal?.aborted
								? signal.reason
								: end.reason === "listener_error" || end.reason === "session_failed"
									? end.error
									: new Error(`Question watch ended: ${end.reason}`),
						),
					);
				});
				check(watch.value);
				if (!done) watch.start(async (value) => check(value));
			});
		} finally {
			signal?.removeEventListener("abort", onAbort);
			await watch.stop();
		}
	}

	/** Open questions of a conversation; stopped ones are cancelled first. */
	async list(conversationId: ConversationId, context: Context): Promise<QuestionList> {
		this.track(conversationId);
		const index = await this.harness.snapshot(QuestionsDoc, conversationId, context);
		if (!index?.pending.length) return { revision: index?.revision ?? 0, pending: [] };
		return this.harness.commit(async (tx) => {
			await this.#reconcile(tx, conversationId);
			const doc = await tx.doc(QuestionsDoc, conversationId);
			const pending = [];
			for (const id of doc.pending) {
				const record = await tx.doc(QuestionDoc, conversationId, String(id), MISSING);
				if (record.status === "pending") pending.push(summarizeQuestion(clone(record) as QuestionRecord));
			}
			return { revision: doc.revision, pending };
		}, context);
	}

	/** One full record, or `undefined` when this conversation has no such question. */
	async get(conversationId: ConversationId, id: number, context: Context): Promise<QuestionRecord | undefined> {
		await this.reconcile(conversationId, context);
		const record = await this.harness.snapshot(QuestionDoc, conversationId, String(id), context);
		return record ? (clone(record) as QuestionRecord) : undefined;
	}

	/**
	 * The first valid decision wins. Identity, version and the response are checked before any effect; a settled
	 * record returns as it is; a record whose call or run has stopped settles as cancelled instead of accepting.
	 */
	async respond(
		conversationId: ConversationId,
		id: number,
		version: string,
		response: QuestionResponse,
		context: Context,
	): Promise<QuestionRecord> {
		return this.harness.commit(async (tx) => {
			const record = await tx.doc(QuestionDoc, conversationId, String(id), MISSING);
			if (record.version === "") throw new Error("Question not found.");
			if (record.version !== version) throw new Error("Question has changed.");
			const decision = validateQuestionResponse(record, response);
			if (record.status !== "pending") return clone(record) as QuestionRecord;
			const index = await tx.doc(QuestionsDoc, conversationId);
			if (!(await live(tx, id))) {
				settle(record as QuestionRecord, index, "cancelled");
				return clone(record) as QuestionRecord;
			}
			if (decision.kind === "skip") settle(record as QuestionRecord, index, "skipped");
			else {
				record.answer = { optionIds: decision.optionIds, text: decision.text };
				settle(record as QuestionRecord, index, "answered");
			}
			return clone(record) as QuestionRecord;
		}, context);
	}
}

const optionSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			maxLength: QUESTION_LIMITS.optionIdChars,
			description: "Unique within the question.",
		}),
		label: Type.String({
			minLength: 1,
			maxLength: QUESTION_LIMITS.labelChars,
			description: "Short, unique, readable alone.",
		}),
		description: Type.Optional(Type.String({ maxLength: QUESTION_LIMITS.descriptionChars })),
		recommended: Type.Optional(
			Type.Boolean({ description: "Your suggested choice; shown as a hint, never preselected." }),
		),
	},
	{ additionalProperties: false },
);
const parameters = Type.Object(
	{
		question: Type.String({ minLength: 1, maxLength: QUESTION_LIMITS.questionChars }),
		multiple: Type.Optional(
			Type.Boolean({ description: "Let the user pick several options; needs at least 2 options. Default false." }),
		),
		options: Type.Optional(Type.Array(optionSchema, { maxItems: QUESTION_LIMITS.maxOptions })),
	},
	{ additionalProperties: false },
);
const structuredOutputSchema = Type.Object(
	{
		status: Type.String({ enum: ["answered", "skipped", "cancelled"] }),
		optionIds: Type.Optional(Type.Array(Type.String())),
		labels: Type.Optional(Type.Array(Type.String())),
		text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	{ additionalProperties: false },
);

/** What the model reads back; labels as well as ids, so an answer never needs decoding. */
export function questionOutput(record: QuestionRecord): string {
	if (record.status === "answered" && record.answer) {
		const labels = answerLabels(record, record.answer);
		const lines = ["The user answered the question."];
		if (record.answer.optionIds.length) {
			lines.push("Selected options:");
			for (const [i, id] of record.answer.optionIds.entries()) lines.push(`- "${labels[i]}" (id: ${id})`);
		}
		if (record.answer.text !== null) lines.push("The user's own words:", record.answer.text);
		return lines.join("\n");
	}
	if (record.status === "skipped")
		return "The user skipped this question without answering. This is not approval, rejection or a preference. Continue with your best judgment and state the assumptions you make, or continue without this information. Do not ask the same question again unless circumstances change.";
	return "The question was cancelled because the run was stopped. No answer was given.";
}

export type QuestionOutcome =
	| { status: "answered"; optionIds: string[]; labels: string[]; text: string | null }
	| { status: "skipped" | "cancelled" };

/** Structured outcome shared by `structuredOutput` and UI `details`. */
function outcomeOf(record: QuestionRecord): QuestionOutcome {
	if (record.status === "answered" && record.answer)
		return {
			status: "answered",
			optionIds: record.answer.optionIds,
			labels: answerLabels(record, record.answer),
			text: record.answer.text,
		};
	return { status: record.status === "skipped" ? "skipped" : "cancelled" };
}

export type QuestionDetails = {
	id: number;
	question: string;
	multiple: boolean;
	options: { id: string; label: string; recommended?: true }[];
} & ({ status: "pending" } | QuestionOutcome);

/** UI details persisted with the tool result: the question and its final settlement. */
export function questionDetails(record: QuestionRecord): QuestionDetails {
	const base = {
		id: record.id,
		question: record.question,
		multiple: record.multiple,
		options: record.options.map((o) => ({
			id: o.id,
			label: o.label,
			...(o.recommended ? { recommended: true as const } : {}),
		})),
	};
	return record.status === "pending" ? { ...base, status: "pending" } : { ...base, ...outcomeOf(record) };
}

/** The `ask_user` tool: durable, one question at a time, answered through a dedicated path. */
export function createAskUserTool(service: () => UserQuestions) {
	return defineTool({
		name: "ask_user",
		description:
			"Ask the user one question and wait for the answer. question: the text. options: optional [{id, label, description?, recommended?}]; multiple: true lets the user pick several (needs 2+ options). The user can always type text instead of or in addition to choosing, or skip. Use only when you need a decision or information you cannot determine yourself. The call returns when the user answers or skips; do not poll.",
		parameters,
		structuredOutputSchema,
		replay: "safe",
		executionMode: "sequential",
		callers: ["model"],
		execute: async (input, api, context) => {
			context.abortSignal?.throwIfAborted();
			if ((await api.snapshot(SubagentDoc, api.conversationId, context))?.role)
				throw new Error("Subagents cannot ask the user; report the missing information to the main agent.");
			let args: QuestionArgs;
			try {
				args = validateQuestionArgs(input);
			} catch (error) {
				if (error instanceof InteractionInputError) throw new Error(`Invalid ask_user arguments: ${error.message}`);
				throw error;
			}
			const questions = service();
			const created = await questions.ensure(api.conversationId, api.taskId, api.callId, args, context);
			await api.details(questionDetails(created), context);
			const record =
				created.status === "pending" ? await questions.wait(api.conversationId, api.taskId, context) : created;
			return {
				output: [{ type: "text", text: questionOutput(record) }],
				structuredOutput: outcomeOf(record),
				details: questionDetails(record),
				isError: record.status === "cancelled",
			};
		},
	});
}

export const createQuestionExtension = (service: () => UserQuestions): Extension =>
	defineExtension({ name: "neko-questions", tools: [createAskUserTool(service)] });
