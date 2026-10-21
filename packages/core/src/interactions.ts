/** Pure limits, types and validators for the `todo` and `ask_user` tools; shared by core, gateway and frontends. */

export const TODO_LIMITS = {
	maxItems: 100,
	idChars: 64,
	textChars: 256,
	/** UTF-8 bytes of the items JSON. */
	itemsBytes: 65_536,
} as const;

export const QUESTION_LIMITS = {
	questionChars: 2_000,
	maxOptions: 12,
	optionIdChars: 64,
	labelChars: 200,
	descriptionChars: 500,
	textChars: 4_000,
	/** UTF-8 bytes of the normalized question arguments / of a response. */
	questionBytes: 16_384,
	responseBytes: 16_384,
	maxPending: 8,
	/** UTF-16 code units of the question text carried in lists. */
	previewChars: 256,
	/** UTF-8 bytes of one serialized question record. */
	recordBytes: 65_536,
} as const;

export const PLAN_LIMITS = {
	titleChars: 120,
	maxSteps: 30,
	stepChars: 500,
	noteChars: 4_000,
	feedbackChars: 2_000,
} as const;

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoItem = { id: string; text: string; status: TodoStatus };
export type TodoList = { revision: number; items: TodoItem[] };

export type QuestionOption = { id: string; label: string; description?: string; recommended?: boolean };
/** Normalized `ask_user` arguments: omitted options/multiple/recommended equal their empty values. */
export type QuestionArgs = { question: string; multiple: boolean; options: QuestionOption[] };
export type QuestionStatus = "pending" | "answered" | "skipped" | "cancelled";
/** `optionIds` follow the question's option order; `text` is the user's own words, `null` when absent. */
export type QuestionAnswer = { optionIds: string[]; text: string | null };
export type QuestionResponse = { kind: "answer"; optionIds?: string[]; text?: string } | { kind: "skip" };
export type NormalizedResponse = { kind: "answer"; optionIds: string[]; text: string | null } | { kind: "skip" };

/** What frontends hold for one question: identity, version, the full text and the final decision. */
export type QuestionRecord = {
	/** The `ask_user` tool task id; stable across recovery. */
	id: number;
	callId: string;
	/** Fixed when the question is created; a request must carry it. */
	version: string;
	question: string;
	multiple: boolean;
	options: QuestionOption[];
	status: QuestionStatus;
	answer: QuestionAnswer | null;
	createdAt: number;
	settledAt: number | null;
};
/** Bounded entry of the pending list; the full record is read on demand. */
export type QuestionSummary = {
	id: number;
	version: string;
	preview: string;
	multiple: boolean;
	optionCount: number;
	createdAt: number;
};
export type QuestionList = { revision: number; pending: QuestionSummary[] };

export class InteractionInputError extends Error {
	override name = "InteractionInputError";
}

const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
const blank = (text: string) => text.trim() === "";
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => {
	throw new InteractionInputError(message);
};
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${what} has an unknown field "${key}".`);
}
function text(value: unknown, what: string, max: number): string {
	if (typeof value !== "string") return fail(`${what} must be a string.`);
	if (blank(value)) return fail(`${what} must not be blank.`);
	if (value.length > max) return fail(`${what} is too long (limit ${max} characters).`);
	return value;
}

/** Validate a whole todo list; returns detached copies and never truncates. */
export function validateTodoItems(input: unknown): TodoItem[] {
	if (!Array.isArray(input)) return fail("items must be an array.");
	if (input.length > TODO_LIMITS.maxItems) fail(`Too many todo items (limit ${TODO_LIMITS.maxItems}).`);
	const ids = new Set<string>();
	const items = input.map((raw, index): TodoItem => {
		const where = `items[${index}]`;
		if (!isRecord(raw)) return fail(`${where} must be an object.`);
		exactKeys(raw, ["id", "text", "status"], where);
		const id = text(raw.id, `${where}.id`, TODO_LIMITS.idChars);
		const body = text(raw.text, `${where}.text`, TODO_LIMITS.textChars);
		if (!(TODO_STATUSES as readonly unknown[]).includes(raw.status))
			return fail(`${where}.status must be pending, in_progress or completed.`);
		if (ids.has(id)) fail(`Duplicate todo id "${id}".`);
		ids.add(id);
		return { id, text: body, status: raw.status as TodoStatus };
	});
	if (jsonBytes(items) > TODO_LIMITS.itemsBytes)
		fail(`Todo list is too large (limit ${TODO_LIMITS.itemsBytes} bytes).`);
	return items;
}

const canonicalArgs = (args: QuestionArgs) => ({
	question: args.question,
	...(args.multiple ? { multiple: true } : {}),
	...(args.options.length ? { options: args.options } : {}),
});

/** Validate and normalize `ask_user` arguments. */
export function validateQuestionArgs(input: unknown): QuestionArgs {
	if (!isRecord(input)) return fail("Question arguments must be an object.");
	exactKeys(input, ["question", "multiple", "options"], "Question");
	const question = text(input.question, "question", QUESTION_LIMITS.questionChars);
	if (input.multiple !== undefined && typeof input.multiple !== "boolean") fail("multiple must be a boolean.");
	const multiple = input.multiple === true;
	const rawOptions = input.options === undefined ? [] : input.options;
	if (!Array.isArray(rawOptions)) return fail("options must be an array.");
	if (rawOptions.length > QUESTION_LIMITS.maxOptions) fail(`Too many options (limit ${QUESTION_LIMITS.maxOptions}).`);
	const ids = new Set<string>();
	const labels = new Set<string>();
	const options = rawOptions.map((raw, index): QuestionOption => {
		const where = `options[${index}]`;
		if (!isRecord(raw)) return fail(`${where} must be an object.`);
		exactKeys(raw, ["id", "label", "description", "recommended"], where);
		const id = text(raw.id, `${where}.id`, QUESTION_LIMITS.optionIdChars);
		const label = text(raw.label, `${where}.label`, QUESTION_LIMITS.labelChars);
		if (ids.has(id)) fail(`Duplicate option id "${id}".`);
		if (labels.has(label.trim())) fail(`Duplicate option label "${label.trim()}".`);
		ids.add(id);
		labels.add(label.trim());
		const option: QuestionOption = { id, label };
		if (raw.description !== undefined) {
			if (typeof raw.description !== "string") fail(`${where}.description must be a string.`);
			const description = raw.description as string;
			if (description.length > QUESTION_LIMITS.descriptionChars)
				fail(`${where}.description is too long (limit ${QUESTION_LIMITS.descriptionChars} characters).`);
			if (!blank(description)) option.description = description;
		}
		if (raw.recommended !== undefined && typeof raw.recommended !== "boolean")
			fail(`${where}.recommended must be a boolean.`);
		if (raw.recommended === true) option.recommended = true;
		return option;
	});
	if (multiple && options.length < 2) fail("multiple requires at least 2 options.");
	if (!multiple && options.filter((o) => o.recommended).length > 1)
		fail("A single-choice question can recommend at most one option.");
	const args: QuestionArgs = { question, multiple, options };
	if (jsonBytes(canonicalArgs(args)) > QUESTION_LIMITS.questionBytes)
		fail(`Question is too large (limit ${QUESTION_LIMITS.questionBytes} bytes).`);
	return args;
}

/** Whether two normalized questions are the same question, for idempotent recovery. */
export const sameQuestion = (a: QuestionArgs, b: QuestionArgs): boolean =>
	JSON.stringify(canonicalArgs(a)) === JSON.stringify(canonicalArgs(b));

/** Validate a user's response against its question; `optionIds` come back in the question's option order. */
export function validateQuestionResponse(
	question: Pick<QuestionArgs, "multiple" | "options">,
	input: unknown,
): NormalizedResponse {
	if (!isRecord(input)) return fail("Response must be an object.");
	if (jsonBytes(input) > QUESTION_LIMITS.responseBytes)
		fail(`Response is too large (limit ${QUESTION_LIMITS.responseBytes} bytes).`);
	if (input.kind === "skip") {
		exactKeys(input, ["kind"], "Response");
		return { kind: "skip" };
	}
	if (input.kind !== "answer") return fail('Response kind must be "answer" or "skip".');
	exactKeys(input, ["kind", "optionIds", "text"], "Response");
	const rawIds = input.optionIds === undefined ? [] : input.optionIds;
	if (!Array.isArray(rawIds)) return fail("optionIds must be an array.");
	if (rawIds.length > QUESTION_LIMITS.maxOptions)
		fail(`Too many selected options (limit ${QUESTION_LIMITS.maxOptions}).`);
	const chosen = new Set<string>();
	for (const id of rawIds) {
		if (typeof id !== "string" || id === "") fail("optionIds must contain non-empty strings.");
		if (chosen.has(id as string)) fail(`Option "${id}" was selected twice.`);
		if (!question.options.some((o) => o.id === id)) fail(`Unknown option "${id}".`);
		chosen.add(id as string);
	}
	if (!question.options.length && chosen.size) fail("This question has no options.");
	if (!question.multiple && chosen.size > 1) fail("This question accepts only one option.");
	let answerText: string | null = null;
	if (input.text !== undefined) {
		if (typeof input.text !== "string") fail("text must be a string.");
		const value = input.text as string;
		if (value.length > QUESTION_LIMITS.textChars)
			fail(`text is too long (limit ${QUESTION_LIMITS.textChars} characters).`);
		if (!blank(value)) answerText = value;
	}
	if (!chosen.size && answerText === null) fail("Choose an option or enter text.");
	return {
		kind: "answer",
		optionIds: question.options.filter((o) => chosen.has(o.id)).map((o) => o.id),
		text: answerText,
	};
}

/** The question text clipped for lists, without splitting a surrogate pair. */
export function questionPreview(question: string): string {
	let end = QUESTION_LIMITS.previewChars;
	if (question.length <= end) return question;
	const last = question.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return question.slice(0, end);
}

export function summarizeQuestion(record: QuestionRecord): QuestionSummary {
	return {
		id: record.id,
		version: record.version,
		preview: questionPreview(record.question),
		multiple: record.multiple,
		optionCount: record.options.length,
		createdAt: record.createdAt,
	};
}

/** Labels of the options an answer selected; ids the question no longer lists fall back to the id. */
export function answerLabels(record: Pick<QuestionRecord, "options">, answer: QuestionAnswer): string[] {
	return answer.optionIds.map((id) => record.options.find((o) => o.id === id)?.label ?? id);
}

export const todoProgress = (items: readonly TodoItem[]) => ({
	completed: items.filter((i) => i.status === "completed").length,
	total: items.length,
});

/** What a user has entered for one question but not submitted yet; shared by every frontend. */
export type QuestionDraft = { optionIds: string[]; text: string };
export const emptyQuestionDraft = (): QuestionDraft => ({ optionIds: [], text: "" });

/** Pick or unpick an option: a single-choice question swaps its one choice, a multiple one toggles. */
export function toggleDraftOption(
	question: Pick<QuestionArgs, "multiple">,
	draft: QuestionDraft,
	optionId: string,
): QuestionDraft {
	const chosen = draft.optionIds.includes(optionId);
	if (question.multiple)
		return {
			...draft,
			optionIds: chosen ? draft.optionIds.filter((id) => id !== optionId) : [...draft.optionIds, optionId],
		};
	return { ...draft, optionIds: chosen ? [] : [optionId] };
}

/** The response a draft would submit, or `null` while it has neither an option nor non-blank text. */
export function draftResponse(draft: QuestionDraft): QuestionResponse | null {
	const text = blank(draft.text) ? undefined : draft.text;
	if (!draft.optionIds.length && text === undefined) return null;
	return {
		kind: "answer",
		...(draft.optionIds.length ? { optionIds: [...draft.optionIds] } : {}),
		...(text !== undefined ? { text } : {}),
	};
}

/** Why the draft cannot be submitted, or `null` when it can; uses the same rules as the server. */
export function draftProblem(
	question: Pick<QuestionArgs, "multiple" | "options">,
	draft: QuestionDraft,
): string | null {
	const response = draftResponse(draft);
	if (!response) return "Choose an option or enter text.";
	try {
		validateQuestionResponse(question, response);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : "Invalid answer.";
	}
}

/** One line for a settled question, from its persisted record. */
export function describeSettlement(record: QuestionRecord): string {
	if (record.status === "answered" && record.answer) {
		const parts = answerLabels(record, record.answer);
		if (record.answer.text !== null) parts.push(record.answer.text);
		return parts.join(", ");
	}
	return record.status === "skipped"
		? "Skipped"
		: record.status === "cancelled"
			? "Cancelled"
			: "Waiting for your answer";
}

export type PlanMode = "normal" | "plan";
export type PlanStatus = "awaiting_approval" | "approved" | "revision_requested" | "superseded" | "cancelled";
export type PlanArgs = { title: string; steps: string[]; note: string };
export type PlanDecision = { kind: "approve" } | { kind: "revise"; feedback: string };

/** What frontends hold for one submitted plan: identity, version, the full text and the final decision. */
export type PlanRecord = {
	/** Fixed when the plan is submitted; a decision must carry it. */
	version: string;
	title: string;
	steps: string[];
	note: string;
	status: PlanStatus;
	feedback: string | null;
	createdAt: number;
	settledAt: number | null;
};
/** `current` is the newest plan of the session, whatever its status; null before the first submission. */
export type PlanView = { mode: PlanMode; revision: number; current: PlanRecord | null };

/** Validate `submit_plan` arguments; steps are kept verbatim and never truncated. */
export function validatePlanArgs(input: unknown): PlanArgs {
	if (!isRecord(input)) return fail("Plan arguments must be an object.");
	exactKeys(input, ["title", "steps", "note"], "Plan");
	const title = text(input.title, "title", PLAN_LIMITS.titleChars);
	if (!Array.isArray(input.steps)) return fail("steps must be an array.");
	if (input.steps.length < 1) fail("A plan needs at least one step.");
	if (input.steps.length > PLAN_LIMITS.maxSteps) fail(`Too many steps (limit ${PLAN_LIMITS.maxSteps}).`);
	const steps = input.steps.map((step, index) => text(step, `steps[${index}]`, PLAN_LIMITS.stepChars));
	let note = "";
	if (input.note !== undefined) {
		if (typeof input.note !== "string") fail("note must be a string.");
		const value = input.note as string;
		if (value.length > PLAN_LIMITS.noteChars) fail(`note is too long (limit ${PLAN_LIMITS.noteChars} characters).`);
		if (!blank(value)) note = value;
	}
	return { title, steps, note };
}

/** Validate a user's decision on a plan. */
export function validatePlanDecision(input: unknown): PlanDecision {
	if (!isRecord(input)) return fail("Decision must be an object.");
	if (input.kind === "approve") {
		exactKeys(input, ["kind"], "Decision");
		return { kind: "approve" };
	}
	if (input.kind !== "revise") return fail('Decision kind must be "approve" or "revise".');
	exactKeys(input, ["kind", "feedback"], "Decision");
	return { kind: "revise", feedback: text(input.feedback, "feedback", PLAN_LIMITS.feedbackChars) };
}
