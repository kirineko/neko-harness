import { expect, it } from "bun:test";
import {
	InteractionInputError,
	PLAN_LIMITS,
	QUESTION_LIMITS,
	questionPreview,
	sameQuestion,
	TODO_LIMITS,
	validatePlanArgs,
	validatePlanDecision,
	validateQuestionArgs,
	validateQuestionResponse,
	validateTodoItems,
} from "../src/interactions.ts";

const item = (id: string, text = "t", status = "pending") => ({ id, text, status });
const bad = (fn: () => unknown, pattern?: RegExp) => {
	let error: unknown;
	try {
		fn();
	} catch (e) {
		error = e;
	}
	expect(error).toBeInstanceOf(InteractionInputError);
	if (pattern) expect((error as Error).message).toMatch(pattern);
};

it("accepts the exact todo boundaries and rejects one past them", () => {
	const many = Array.from({ length: TODO_LIMITS.maxItems }, (_, i) => item(`id-${i}`));
	expect(validateTodoItems(many)).toHaveLength(100);
	bad(() => validateTodoItems([...many, item("extra")]), /Too many/);
	expect(validateTodoItems([item("i".repeat(64), "t".repeat(256))])).toHaveLength(1);
	bad(() => validateTodoItems([item("i".repeat(65))]), /too long/);
	bad(() => validateTodoItems([item("a", "t".repeat(257))]), /too long/);
	expect(validateTodoItems([])).toEqual([]);
});

it("rejects invalid todo shapes without truncating", () => {
	bad(() => validateTodoItems([item("a"), item("a")]), /Duplicate/);
	bad(() => validateTodoItems([item(" ")]), /blank/);
	bad(() => validateTodoItems([item("a", "  ")]), /blank/);
	bad(() => validateTodoItems([item("a", "t", "done")]), /status/);
	bad(() => validateTodoItems([{ ...item("a"), extra: 1 }]), /unknown field/);
	bad(() => validateTodoItems("nope"), /array/);
});

it("counts todo bytes in UTF-8 after JSON encoding, not characters", () => {
	// 100 items of 256 three-byte characters exceed 65,536 bytes although each item is within its limits.
	const heavy = Array.from({ length: 100 }, (_, i) => item(`id-${i}`, "界".repeat(256)));
	bad(() => validateTodoItems(heavy), /too large/);
	const fits = Array.from({ length: 100 }, (_, i) => item(`id-${i}`, "界".repeat(100)));
	expect(validateTodoItems(fits)).toHaveLength(100);
});

it("normalizes equivalent question arguments", () => {
	const a = validateQuestionArgs({ question: "Pick", options: [] });
	const b = validateQuestionArgs({ question: "Pick", multiple: false });
	expect(a).toEqual({ question: "Pick", multiple: false, options: [] });
	expect(sameQuestion(a, b)).toBe(true);
	const c = validateQuestionArgs({
		question: "Pick",
		options: [
			{ id: "a", label: "A", recommended: false },
			{ id: "b", label: "B", description: " " },
		],
	});
	expect(c.options).toEqual([
		{ id: "a", label: "A" },
		{ id: "b", label: "B" },
	]);
	expect(sameQuestion(validateQuestionArgs({ question: "Pick" }), validateQuestionArgs({ question: "Other" }))).toBe(
		false,
	);
});

it("accepts option-less, single and multiple questions and rejects invalid combinations", () => {
	expect(validateQuestionArgs({ question: "Why?" }).options).toEqual([]);
	const two = [
		{ id: "a", label: "A", recommended: true },
		{ id: "b", label: "B" },
	];
	expect(validateQuestionArgs({ question: "Q", options: two }).options[0]!.recommended).toBe(true);
	expect(validateQuestionArgs({ question: "Q", multiple: true, options: two }).multiple).toBe(true);
	bad(() => validateQuestionArgs({ question: " " }), /blank/);
	bad(() => validateQuestionArgs({ question: "Q", extra: true }), /unknown field/);
	bad(() => validateQuestionArgs({ question: "Q", options: [two[0], { id: "a", label: "B" }] }), /Duplicate option id/);
	bad(
		() => validateQuestionArgs({ question: "Q", options: [two[0], { id: "b", label: " A " }] }),
		/Duplicate option label/,
	);
	bad(() => validateQuestionArgs({ question: "Q", options: [{ id: "a", label: " " }] }), /blank/);
	bad(() => validateQuestionArgs({ question: "Q", multiple: true, options: [two[0]] }), /at least 2/);
	bad(() => validateQuestionArgs({ question: "Q", multiple: true }), /at least 2/);
	bad(
		() =>
			validateQuestionArgs({
				question: "Q",
				options: [
					{ id: "a", label: "A", recommended: true },
					{ id: "b", label: "B", recommended: true },
				],
			}),
		/at most one/,
	);
	expect(
		validateQuestionArgs({
			question: "Q",
			multiple: true,
			options: [
				{ id: "a", label: "A", recommended: true },
				{ id: "b", label: "B", recommended: true },
			],
		}).options,
	).toHaveLength(2);
});

it("enforces exact question length, count and byte limits", () => {
	expect(validateQuestionArgs({ question: "q".repeat(QUESTION_LIMITS.questionChars) }).question).toHaveLength(2000);
	bad(() => validateQuestionArgs({ question: "q".repeat(2001) }), /too long/);
	const option = (i: number) => ({
		id: `${i}`.padStart(64, "i"),
		label: `L${i}`.padEnd(200, "l"),
		description: "d".repeat(500),
	});
	const twelve = Array.from({ length: 12 }, (_, i) => option(i));
	expect(validateQuestionArgs({ question: "Q", options: twelve }).options).toHaveLength(12);
	bad(() => validateQuestionArgs({ question: "Q", options: [...twelve, option(12)] }), /Too many options/);
	bad(() => validateQuestionArgs({ question: "Q", options: [{ id: "i".repeat(65), label: "A" }] }), /too long/);
	bad(() => validateQuestionArgs({ question: "Q", options: [{ id: "a", label: "l".repeat(201) }] }), /too long/);
	bad(
		() => validateQuestionArgs({ question: "Q", options: [{ id: "a", label: "A", description: "d".repeat(501) }] }),
		/too long/,
	);
	// Multibyte characters within every per-field limit can still exceed the byte budget.
	const wide = Array.from({ length: 12 }, (_, i) => ({
		id: `i${i}`,
		label: `界${i}`.padEnd(200, "界"),
		description: "界".repeat(500),
	}));
	bad(() => validateQuestionArgs({ question: "界".repeat(2000), options: wide }), /too large/);
});

it("validates responses against the question and orders option ids", () => {
	const single = validateQuestionArgs({
		question: "Q",
		options: [
			{ id: "a", label: "A" },
			{ id: "b", label: "B" },
		],
	});
	const multi = validateQuestionArgs({ question: "Q", multiple: true, options: single.options });
	const free = validateQuestionArgs({ question: "Q" });
	expect(validateQuestionResponse(single, { kind: "skip" })).toEqual({ kind: "skip" });
	expect(validateQuestionResponse(single, { kind: "answer", optionIds: ["b"] })).toEqual({
		kind: "answer",
		optionIds: ["b"],
		text: null,
	});
	expect(validateQuestionResponse(single, { kind: "answer", optionIds: ["a"], text: " note " })).toEqual({
		kind: "answer",
		optionIds: ["a"],
		text: " note ",
	});
	expect(validateQuestionResponse(multi, { kind: "answer", optionIds: ["b", "a"] })).toMatchObject({
		optionIds: ["a", "b"],
	});
	expect(validateQuestionResponse(free, { kind: "answer", text: "hello" })).toMatchObject({
		optionIds: [],
		text: "hello",
	});
	expect(validateQuestionResponse(single, { kind: "answer", optionIds: ["a"], text: "  " })).toMatchObject({
		text: null,
	});
	bad(() => validateQuestionResponse(single, { kind: "answer", optionIds: ["a", "b"] }), /only one/);
	bad(() => validateQuestionResponse(multi, { kind: "answer", optionIds: ["a", "a"] }), /twice/);
	bad(() => validateQuestionResponse(single, { kind: "answer", optionIds: ["z"] }), /Unknown option/);
	bad(() => validateQuestionResponse(free, { kind: "answer", optionIds: ["a"] }), /Unknown option|no options/);
	bad(() => validateQuestionResponse(single, { kind: "answer" }), /Choose an option or enter text/);
	bad(() => validateQuestionResponse(free, { kind: "answer", text: "   " }), /Choose an option or enter text/);
	bad(() => validateQuestionResponse(single, { kind: "answer", text: "t".repeat(4001) }), /too long/);
	expect(validateQuestionResponse(free, { kind: "answer", text: "t".repeat(4000) })).toMatchObject({ kind: "answer" });
	bad(() => validateQuestionResponse(single, { kind: "skip", text: "x" }), /unknown field/);
	bad(() => validateQuestionResponse(single, { kind: "option", optionId: "a" }), /kind/);
	bad(() => validateQuestionResponse(single, null), /object/);
	bad(() => validateQuestionResponse(free, { kind: "answer", text: "\u0000".repeat(4000) }), /too large/);
});

it("clips previews without splitting a surrogate pair", () => {
	expect(questionPreview("short")).toBe("short");
	const text = `${"a".repeat(255)}😀tail`;
	const preview = questionPreview(text);
	expect(preview.length).toBe(255);
	expect(preview.endsWith("a")).toBe(true);
	expect(questionPreview("b".repeat(300))).toHaveLength(256);
});

it("accepts the exact plan boundaries and rejects one past them", () => {
	const steps = Array.from({ length: PLAN_LIMITS.maxSteps }, (_, i) => `step ${i}`);
	expect(validatePlanArgs({ title: "t".repeat(120), steps })).toEqual({ title: "t".repeat(120), steps, note: "" });
	bad(() => validatePlanArgs({ title: "t".repeat(121), steps: ["a"] }), /too long/);
	bad(() => validatePlanArgs({ title: "t", steps: [...steps, "extra"] }), /Too many/);
	bad(() => validatePlanArgs({ title: "t", steps: [] }), /at least one/);
	expect(validatePlanArgs({ title: "t", steps: ["s".repeat(500)] }).steps[0]).toHaveLength(500);
	bad(() => validatePlanArgs({ title: "t", steps: ["s".repeat(501)] }), /too long/);
	expect(validatePlanArgs({ title: "t", steps: ["a"], note: "n".repeat(4000) }).note).toHaveLength(4000);
	bad(() => validatePlanArgs({ title: "t", steps: ["a"], note: "n".repeat(4001) }), /too long/);
});

it("normalizes plan notes and rejects malformed plan arguments", () => {
	expect(validatePlanArgs({ title: "t", steps: ["a"], note: "  " }).note).toBe("");
	bad(() => validatePlanArgs({ title: " ", steps: ["a"] }), /blank/);
	bad(() => validatePlanArgs({ title: "t", steps: ["a", " "] }), /blank/);
	bad(() => validatePlanArgs({ title: "t", steps: "a" }), /array/);
	bad(() => validatePlanArgs({ title: "t", steps: ["a"], extra: 1 }), /unknown field/);
	bad(() => validatePlanArgs({ title: "t", steps: ["a"], note: 1 }), /string/);
	bad(() => validatePlanArgs("plan"), /object/);
});

it("validates plan decisions", () => {
	expect(validatePlanDecision({ kind: "approve" })).toEqual({ kind: "approve" });
	expect(validatePlanDecision({ kind: "revise", feedback: "split step 2" })).toEqual({
		kind: "revise",
		feedback: "split step 2",
	});
	expect(validatePlanDecision({ kind: "revise", feedback: "f".repeat(2000) }).kind).toBe("revise");
	bad(() => validatePlanDecision({ kind: "revise", feedback: "f".repeat(2001) }), /too long/);
	bad(() => validatePlanDecision({ kind: "revise", feedback: "  " }), /blank/);
	bad(() => validatePlanDecision({ kind: "revise" }), /string/);
	bad(() => validatePlanDecision({ kind: "approve", feedback: "x" }), /unknown field/);
	bad(() => validatePlanDecision({ kind: "reject" }), /approve/);
});
