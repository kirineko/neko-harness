import { expect, it } from "vitest";
import { INPUT_HISTORY_LIMIT, promptHistory } from "../src/input-history.ts";
import type { ChatItem } from "../src/projection.ts";

let counter = 0;
const user = (text: string, extra: Partial<Extract<ChatItem, { type: "user" }>> = {}): ChatItem => ({
	type: "user",
	key: `e${++counter}`,
	id: counter,
	text,
	...extra,
});
const assistant = (): ChatItem => ({
	type: "assistant",
	key: `e${++counter}`,
	id: counter,
	thinking: "",
	text: "ok",
	stopReason: "stop",
	errorMessage: null,
	note: null,
});
const system = (text: string): ChatItem => ({ type: "system", key: `e${++counter}`, id: counter, text });

it("returns user inputs newest first", () => {
	expect(promptHistory([user("a"), assistant(), user("b"), assistant(), user("c")])).toEqual(["c", "b", "a"]);
});

it("is empty without user inputs", () => {
	expect(promptHistory([])).toEqual([]);
	expect(promptHistory([assistant()])).toEqual([]);
});

it("excludes subagent inputs and blank text such as default image prompts", () => {
	const history = promptHistory([
		user("keep"),
		user("inner", { subagentRoundId: 3 }),
		user("   \n"),
		user("", { defaultImagePrompt: { version: 1, text: "Describe the image" } }),
	]);
	expect(history).toEqual(["keep"]);
});

it("restores skill invocations to what the user typed", () => {
	const skill = { name: "review", location: "/x/SKILL.md", body: "BODY", args: "src/a.ts" };
	expect(promptHistory([user("<skill>BODY</skill>", { skill })])).toEqual(["/skill:review src/a.ts"]);
	expect(promptHistory([user("<skill>BODY</skill>", { skill: { ...skill, args: "" } })])).toEqual(["/skill:review"]);
});

it("collapses consecutive duplicates only", () => {
	expect(promptHistory([user("a"), user("a"), user(" a "), user("b"), user("a")])).toEqual(["a", "b", "a"]);
});

it("keeps inner newlines and trims the edges", () => {
	expect(promptHistory([user("\n line1\nline2 \n")])).toEqual(["line1\nline2"]);
});

it("keeps the most recent entries within the limit", () => {
	const items = Array.from({ length: INPUT_HISTORY_LIMIT + 20 }, (_, i) => user(`m${i}`));
	const history = promptHistory(items);
	expect(history).toHaveLength(INPUT_HISTORY_LIMIT);
	expect(history[0]).toBe(`m${INPUT_HISTORY_LIMIT + 19}`);
	expect(history.at(-1)).toBe("m20");
});

it("keeps inputs from before a compaction marker", () => {
	expect(promptHistory([user("old"), system("[context compacted]"), system("[new context]"), user("new")])).toEqual([
		"new",
		"old",
	]);
});
