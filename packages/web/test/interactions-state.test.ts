import { expect, it } from "vitest";
import {
	awaitingTitle,
	interactionAnswer,
	isSameDecision,
	plainText,
	questionState,
	sessionStatusText,
	settlementText,
	todoState,
} from "../src/client/lib/interactions.ts";
import { questionKey, questionUi } from "../src/client/lib/question-ui.ts";
import { getState, storeActions } from "../src/client/lib/store.ts";
import { chatView, question } from "./support/interaction-fixtures.ts";

const base = { phase: "ready", operating: false, currentSessionId: "s1", retained: null } as const;
const todos = {
	revision: 3,
	items: [
		{ id: "a", text: "write tests", status: "completed" },
		{ id: "b", text: "fix bug", status: "in_progress" },
		{ id: "c", text: "ship", status: "pending" },
	],
} as const;

it("derives todo state from the view: supported, empty, unsupported", () => {
	const live = todoState({ ...base, view: chatView({ todos: { revision: 3, items: [...todos.items] } }) });
	expect(live).toMatchObject({ revision: 3, completed: 1, total: 3, offline: false });
	expect(live?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
	expect(todoState({ ...base, view: chatView() })).toMatchObject({ total: 0, completed: 0 });
	expect(todoState({ ...base, view: chatView({ todos: null }) })).toBeNull();
	expect(todoState({ ...base, view: null })).toBeNull();
});

it("keeps the last loaded list for the same session while offline, never for another one", () => {
	const retained = { sessionId: "s1", todos: { revision: 3, items: [...todos.items] }, questions: undefined };
	const offline = todoState({ ...base, view: null, phase: "reconnecting", retained });
	expect(offline).toMatchObject({ total: 3, offline: true });
	expect(todoState({ ...base, view: null, currentSessionId: "s2", retained })).toBeNull();
	const gone = todoState({ ...base, view: chatView({ todos: null }), retained });
	expect(gone).toBeNull();
	expect(
		todoState({ ...base, view: chatView({ todos: { revision: 4, items: [] } }), phase: "reconnecting" })?.offline,
	).toBe(true);
});

it("tracks what the view carried across a dropped connection in the store", () => {
	storeActions.setSession("s1");
	storeActions.setView(chatView({ todos: { revision: 3, items: [...todos.items] }, questions: [question()] }));
	expect(getState().retained?.sessionId).toBe("s1");
	storeActions.setView(null);
	expect(getState().retained?.todos?.items).toHaveLength(3);
	expect(getState().retained?.questions?.pending).toHaveLength(1);
	storeActions.setView(chatView({ todos: null, questions: null }));
	expect(getState().retained).toMatchObject({ todos: undefined, questions: undefined });
	storeActions.setView(null);
	storeActions.setSession(null);
});

it("derives questions: unsupported is null, empty is supported, offline blocks answering", () => {
	expect(questionState({ ...base, view: chatView({ questions: null }) })).toBeNull();
	expect(questionState({ ...base, view: chatView() })).toEqual({ pending: [], online: true });
	const waiting = questionState({ ...base, view: chatView({ questions: [question()] }) });
	expect(waiting?.pending.map((q) => q.id)).toEqual([7]);
	expect(questionState({ ...base, view: chatView({ questions: [question()] }), operating: true })?.online).toBe(false);
	expect(questionState({ ...base, view: chatView({ questions: [question()] }), phase: "reconnecting" })?.online).toBe(
		false,
	);
	const retained = { sessionId: "s1", todos: undefined, questions: { revision: 1, pending: [] } };
	expect(questionState({ ...base, view: null, phase: "reconnecting", retained })).toEqual({
		pending: [],
		online: false,
	});
});

it("prefixes the tab title only while questions wait", () => {
	expect(awaitingTitle("neko", 0)).toBe("neko");
	expect(awaitingTitle("neko", 1)).toBe("(1) 等待回答 · neko");
	expect(awaitingTitle("neko", 3)).toBe("(3) 等待回答 · neko");
});

it("labels sessions: waiting replaces running, unsupported falls back", () => {
	expect(sessionStatusText({ status: "running", awaitingAnswer: true })).toBe(" · 等待回答");
	expect(sessionStatusText({ status: "running", awaitingAnswer: false })).toBe(" · 运行中");
	expect(sessionStatusText({ status: "running" })).toBe(" · 运行中");
	expect(sessionStatusText({ status: "error" })).toBe(" · 出错");
	expect(sessionStatusText({ status: "idle" })).toBe("");
});

it("spells out control and bidi characters but keeps line breaks, markdown and html as text", () => {
	expect(plainText("a\r\nb\tc")).toBe("a\nb\tc");
	expect(plainText("x\u202ey\u2066z\u0007\u009b")).toBe("x\\u202ey\\u2066z\\u0007\\u009b");
	expect(plainText("**b** <script>1</script> [l](http://e)")).toBe("**b** <script>1</script> [l](http://e)");
});

it("describes settled questions and whether a saved record is what was asked for", () => {
	const answered = question({
		status: "answered",
		answer: { optionIds: ["sqlite"], text: "fast please" },
		settledAt: 2,
	});
	expect(settlementText(answered)).toBe("已回答：SQLite, fast please");
	expect(settlementText(question({ status: "skipped" }))).toContain("已跳过");
	expect(settlementText(question({ status: "cancelled" }))).toContain("已取消");
	expect(isSameDecision(answered, { kind: "answer", optionIds: ["sqlite"], text: "fast please" })).toBe(true);
	expect(isSameDecision(answered, { kind: "answer", optionIds: ["pg"], text: "fast please" })).toBe(false);
	expect(isSameDecision(answered, { kind: "answer", optionIds: ["sqlite"] })).toBe(false);
	expect(isSameDecision(answered, { kind: "skip" })).toBe(false);
	expect(isSameDecision(question({ status: "skipped" }), { kind: "skip" })).toBe(true);
	expect(isSameDecision(question({ status: "cancelled" }), { kind: "answer", text: "x" })).toBe(false);
	expect(interactionAnswer({ labels: ["A", "B"], text: "why" })).toBe("A, B, why");
	expect(interactionAnswer({ optionIds: ["a"], text: null })).toBe("a");
});

it("keys drafts and fold state by session, question and version", () => {
	questionUi.reset();
	const key = questionKey("s1", 7, "v1");
	expect(new Set([key, questionKey("s2", 7, "v1"), questionKey("s1", 8, "v1"), questionKey("s1", 7, "v2")]).size).toBe(
		4,
	);
	questionUi.setDraft(key, { optionIds: ["pg"], text: "note" });
	expect(questionUi.draft(key)).toEqual({ optionIds: ["pg"], text: "note" });
	expect(questionUi.draft(questionKey("s1", 7, "v2"))).toEqual({ optionIds: [], text: "" });
	questionUi.clearDraft(key);
	expect(questionUi.draft(key)).toEqual({ optionIds: [], text: "" });
	questionUi.reset();
});
