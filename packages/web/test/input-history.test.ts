import { expect, it } from "vitest";
import { type HistoryBrowse, type HistoryKeyEvent, stepHistory } from "../src/client/lib/input-history.ts";

const key = (name: string, extra: Partial<HistoryKeyEvent> = {}): HistoryKeyEvent => ({
	key: name,
	shiftKey: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	...extra,
});
const at = (start: number, end = start) => ({ start, end });
const entries = ["c", "b", "a"];

it("recalls the newest entry on up in an empty input and saves the draft", () => {
	const step = stepHistory(null, entries, key("ArrowUp"), "", at(0));
	expect(step).toEqual({ browse: { index: 0, draft: "", entries }, text: "c", caret: "start" });
});

it("recalls from a draft only when the caret is at the start", () => {
	expect(stepHistory(null, entries, key("ArrowUp"), "draft", at(3))).toBeNull();
	const step = stepHistory(null, entries, key("ArrowUp"), "draft", at(0));
	expect(step?.browse?.draft).toBe("draft");
	expect(step?.text).toBe("c");
});

it("walks older, stops at the oldest, and walks back to the draft", () => {
	let text = "draft";
	let browse: HistoryBrowse | null = null;
	const press = (name: string, caret: number) => {
		const step = stepHistory(browse, entries, key(name), text, at(caret));
		if (step) {
			browse = step.browse;
			text = step.text;
		}
		return step;
	};
	press("ArrowUp", 0);
	press("ArrowUp", 0);
	press("ArrowUp", 0);
	expect(text).toBe("a");
	expect(press("ArrowUp", 0)).toBeNull();
	press("ArrowDown", text.length);
	expect(text).toBe("b");
	press("ArrowDown", text.length);
	press("ArrowDown", text.length);
	expect(text).toBe("draft");
	expect(browse).toBeNull();
	expect(press("ArrowDown", text.length)).toBeNull();
});

it("down needs browsing and the caret at the end", () => {
	expect(stepHistory(null, entries, key("ArrowDown"), "x", at(1))).toBeNull();
	const browse = { index: 1, draft: "", entries };
	expect(stepHistory(browse, entries, key("ArrowDown"), "b", at(0))).toBeNull();
	expect(stepHistory(browse, entries, key("ArrowDown"), "b", at(1))?.text).toBe("c");
});

it("leaves multi-line entries to default caret movement until the caret reaches the edge", () => {
	const lines = ["l1\nl2", "old"];
	const first = stepHistory(null, lines, key("ArrowUp"), "", at(0));
	expect(first?.text).toBe("l1\nl2");
	expect(stepHistory(first?.browse ?? null, lines, key("ArrowDown"), "l1\nl2", at(2))).toBeNull();
	expect(stepHistory(first?.browse ?? null, lines, key("ArrowDown"), "l1\nl2", at(5))?.text).toBe("");
});

it("ignores selections and modified keys", () => {
	expect(stepHistory(null, entries, key("ArrowUp"), "abc", at(0, 3))).toBeNull();
	for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const)
		expect(stepHistory(null, entries, key("ArrowUp", { [modifier]: true }), "", at(0))).toBeNull();
	expect(stepHistory(null, entries, key("Enter"), "", at(0))).toBeNull();
});

it("exits browsing once the text no longer matches the recalled entry", () => {
	const browse = { index: 0, draft: "mine", entries };
	expect(stepHistory(browse, entries, key("ArrowDown"), "cx", at(2))).toBeNull();
	const step = stepHistory(browse, entries, key("ArrowUp"), "edited", at(0));
	expect(step?.browse?.index).toBe(0);
	expect(step?.browse?.draft).toBe("edited");
});

it("keeps the entries a browse started with, and uses fresh ones after leaving", () => {
	const first = stepHistory(null, entries, key("ArrowUp"), "", at(0));
	const fresh = ["new", ...entries];
	const older = stepHistory(first?.browse ?? null, fresh, key("ArrowUp"), "c", at(0));
	expect(older?.text).toBe("b");
	expect(stepHistory(null, fresh, key("ArrowUp"), "", at(0))?.text).toBe("new");
});

it("does nothing without history", () => {
	expect(stepHistory(null, [], key("ArrowUp"), "", at(0))).toBeNull();
});
