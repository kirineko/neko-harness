import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { BoundedEditor } from "../src/components/editor.ts";
import { isClipboardShortcut } from "../src/image-input.ts";
import { getEditorTheme } from "../src/theme/index.ts";

const ref = "[Image 1: Clipboard.png]";
function editor() {
	const e = new BoundedEditor(new TuiAltScreen({ columns: 80, rows: 24 } as Terminal), getEditorTheme());
	e.isImageReference = (text) => text === ref;
	e.render(80);
	return e;
}
it("accepts only the initial clipboard key press, not Kitty release or repeat", () => {
	expect(isClipboardShortcut("\x16", "darwin")).toBe(true);
	expect(isClipboardShortcut("\x1b[118;5u", "darwin")).toBe(true);
	expect(isClipboardShortcut("\x1b[118;5:2u", "darwin")).toBe(false);
	expect(isClipboardShortcut("\x1b[118;5:3u", "darwin")).toBe(false);
	expect(isClipboardShortcut("\x1bv", "win32")).toBe(true);
	expect(isClipboardShortcut("\x1bv", "linux", true)).toBe(true);
	expect(isClipboardShortcut("\x16", "linux", true)).toBe(false);
	expect(isClipboardShortcut("\x16", "linux", false)).toBe(true);
});
it("deletes an image reference as a single undoable operation without eating adjacent text", () => {
	const e = editor();
	e.setText(`hello ${ref} world`);
	for (let n = 0; n < 6; n++) e.handleInput("\x1b[D");
	e.handleInput("\x7f");
	expect(e.getText()).toBe("hello  world");
	expect(e.getCursor().col).toBe(6);
	e.handleInput("\x1f");
	expect(e.getText()).toBe(`hello ${ref} world`);
	e.handleInput("\x01");
	for (let n = 0; n < 6; n++) e.handleInput("\x1b[C");
	e.handleInput("\x1b[3~");
	expect(e.getText()).toBe("hello  world");
	e.setText("[Image 99: plain text]");
	e.handleInput("\x7f");
	expect(e.getText()).toBe("[Image 99: plain text");
});
it("deletes from inside a reference and preserves expanded Pi text pastes", () => {
	const e = editor();
	e.handleInput(`\x1b[200~${"line\n".repeat(15)}\x1b[201~`);
	e.insertTextAtCursor(ref);
	const before = e.getExpandedText();
	e.handleInput("\x1b[D");
	e.handleInput("\x7f");
	expect(e.getExpandedText()).toBe(before.replace(ref, ""));
	e.handleInput("\x1f");
	expect(e.getExpandedText()).toBe(before);
});
it("requires two consecutive Escape presses; release and repeat cannot clear the draft", () => {
	const e = editor();
	let clears = 0;
	e.onClearDraft = () => {
		clears++;
	};
	e.setText(ref);
	e.handleInput("\x1b[27u");
	e.handleInput("\x1b[27;1:3u");
	e.handleInput("\x1b[27;1:2u");
	expect(e.getText()).toBe(ref);
	e.handleInput("\x1b[27u");
	expect(e.getText()).toBe("");
	expect(clears).toBe(1);
	e.handleInput("\x1f");
	expect(e.getText()).toBe(ref);
	e.handleInput("\x1b");
	e.handleInput("x");
	e.handleInput("\x1b");
	expect(e.getText()).toContain("x");
	e.setText("new session");
	e.handleInput("\x1b");
	expect(e.getText()).toBe("new session");
});
