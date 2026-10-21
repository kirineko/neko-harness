import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { BoundedEditor } from "../src/components/editor.ts";
import { getEditorTheme } from "../src/theme/index.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
function editor(history: string[] = []) {
	const e = new BoundedEditor(new TuiAltScreen({ columns: 80, rows: 24 } as Terminal), getEditorTheme());
	e.render(80);
	e.setHistory(history);
	return e;
}

it("recalls newest first on up and stops at the oldest entry", () => {
	const e = editor(["c", "b", "a"]);
	e.handleInput(UP);
	expect(e.getText()).toBe("c");
	e.handleInput(UP);
	expect(e.getText()).toBe("b");
	e.handleInput(UP);
	e.handleInput(UP);
	expect(e.getText()).toBe("a");
});

it("restores the draft after moving down past the newest entry", () => {
	const e = editor(["b", "a"]);
	e.setText("draft");
	e.handleInput("\x01");
	e.handleInput(UP);
	expect(e.getText()).toBe("b");
	e.handleInput(DOWN);
	expect(e.getText()).toBe("draft");
});

it("leaves up/down untouched without history", () => {
	const e = editor();
	e.setText("one\ntwo");
	e.handleInput(UP);
	expect(e.getText()).toBe("one\ntwo");
	expect(e.getCursor().line).toBe(0);
});

it("moves the cursor within multiline text before browsing history", () => {
	const e = editor(["old"]);
	e.setText("one\ntwo");
	e.handleInput(UP);
	expect(e.getText()).toBe("one\ntwo");
	expect(e.getCursor().line).toBe(0);
});

it("editing a recalled entry exits browsing", () => {
	const e = editor(["b", "a"]);
	e.handleInput(UP);
	e.handleInput("x");
	expect(e.getText()).toContain("x");
	e.handleInput(DOWN);
	expect(e.getText()).toContain("x");
});

it("keeps the visible entry while browsing and applies updates afterwards", () => {
	const e = editor(["b", "a"]);
	e.handleInput(UP);
	e.handleInput(UP);
	expect(e.getText()).toBe("a");
	e.setHistory(["new", "b", "a"]);
	e.handleInput(DOWN);
	expect(e.getText()).toBe("b");
	e.handleInput(DOWN);
	e.setText("");
	e.handleInput(UP);
	expect(e.getText()).toBe("new");
});

it("replacing history on a session switch does not leak the previous session", () => {
	const e = editor(["a1"]);
	e.handleInput(UP);
	e.setText("");
	e.setHistory(["b1"]);
	e.handleInput(UP);
	expect(e.getText()).toBe("b1");
	e.setText("");
	e.setHistory([]);
	e.handleInput(UP);
	expect(e.getText()).toBe("");
});

it("does not trigger history while the completion list is showing", async () => {
	const e = editor(["old"]);
	e.setAutocompleteProvider({
		triggerCharacters: ["@"],
		getSuggestions: async () => ({
			items: [
				{ value: "@a", label: "a" },
				{ value: "@b", label: "b" },
			],
			prefix: "@",
		}),
		applyCompletion: (lines, line, col) => ({ lines, cursorLine: line, cursorCol: col }),
	});
	e.handleInput("@");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(e.isShowingAutocomplete()).toBe(true);
	e.handleInput(UP);
	expect(e.getText()).toBe("@");
});

it("round-trips an image-reference draft through history", () => {
	const ref = "[Image 1: Clipboard.png]";
	const e = editor(["old"]);
	e.setText(`see ${ref}`);
	e.handleInput("\x01");
	e.handleInput(UP);
	expect(e.getText()).toBe("old");
	e.handleInput(DOWN);
	expect(e.getText()).toBe(`see ${ref}`);
});
