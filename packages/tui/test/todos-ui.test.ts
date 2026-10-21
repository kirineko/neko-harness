import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TODOS_UNSUPPORTED } from "@neko-harness/gateway/client-session";
import type { WireTodoList } from "@neko-harness/gateway/contract";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { helpLines } from "../src/help-ui.ts";
import { commands } from "../src/labels.ts";
import { setActiveTheme } from "../src/theme/index.ts";
import { showTodos, TODO_GLYPHS, TodosDetail, todoProgressText, todosEmpty } from "../src/todos-ui.ts";

setActiveTheme("light");

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");
const list = (items: WireTodoList["items"], revision = 1): WireTodoList => ({ revision, items });
const item = (id: string, text: string, status: WireTodoList["items"][number]["status"]) => ({ id, text, status });
const many = (n: number) =>
	list(Array.from({ length: n }, (_, i) => item(`t${i + 1}`, `Task number ${i + 1}`, "pending")));

it("shows the items in order with a distinct glyph per state and a completed/total header", () => {
	const detail = new TodosDetail(() =>
		list([
			item("a", "Write the spec", "completed"),
			item("b", "Implement the parser", "in_progress"),
			item("c", "Add tests", "pending"),
			item("d", "Ship it", "pending"),
		]),
	);
	const text = plain(detail.lines(60, 12));
	expect(text).toContain("1/4 completed");
	expect(text.indexOf("Write the spec")).toBeLessThan(text.indexOf("Implement the parser"));
	expect(text.indexOf("Implement the parser")).toBeLessThan(text.indexOf("Add tests"));
	expect(text.indexOf("Add tests")).toBeLessThan(text.indexOf("Ship it"));
	expect(text).toContain(`${TODO_GLYPHS.completed} 1. Write the spec`);
	expect(text).toContain(`${TODO_GLYPHS.in_progress} 2. Implement the parser`);
	expect(text).toContain(`${TODO_GLYPHS.pending} 3. Add tests`);
	expect(new Set(Object.values(TODO_GLYPHS)).size).toBe(3);
	expect(text).toContain("pending");
	expect(text).toContain("in progress");
});

it("scrolls a long list under a pinned header and clamps at both ends", () => {
	const source = many(40);
	const detail = new TodosDetail(() => source);
	const first = detail.lines(60, 8);
	expect(first).toHaveLength(8);
	expect(plain(first)).toContain("0/40 completed");
	expect(plain(first)).toContain("Task number 1\n");
	expect(plain(first)).not.toContain("Task number 40");
	detail.scroll(-5);
	expect(detail.lines(60, 8)).toEqual(first);
	detail.handleKey("\x1b[B");
	const down = plain(detail.lines(60, 8));
	expect(down).not.toContain("Task number 1\n");
	expect(down).toContain("0/40 completed");
	detail.handleKey("\x1b[6~");
	detail.handleKey("\x1b[6~");
	expect(plain(detail.lines(60, 8))).toContain("rows");
	detail.handleKey("\x1b[F");
	const last = detail.lines(60, 8);
	expect(plain(last)).toContain("Task number 40");
	detail.scroll(100);
	expect(detail.lines(60, 8)).toEqual(last);
	detail.handleKey("\x1b[H");
	expect(detail.lines(60, 8)).toEqual(first);
	expect(detail.handleKey("x")).toBe(false);
	for (const width of [40, 60])
		for (const line of detail.lines(width, 8)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
});

it("wraps a long item completely so every word can be reached by scrolling", () => {
	const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
	const detail = new TodosDetail(() =>
		list([item("long", words.join(" "), "in_progress"), item("next", "Afterwards", "pending")]),
	);
	const seen: string[] = [];
	detail.scroll(-1000);
	for (let page = 0; page < 40; page++) {
		const lines = detail.lines(30, 6);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		seen.push(plain(lines));
		detail.handleKey("\x1b[6~");
	}
	const all = seen.join("\n");
	for (const word of words) expect(all).toContain(word);
	expect(all).toContain("Afterwards");
});

it("has an empty state, an unsupported notice and an offline marker", async () => {
	expect(plain(new TodosDetail(() => list([])).lines(60, 10))).toBe(todosEmpty());
	expect(plain(new TodosDetail(() => undefined).lines(60, 10))).toContain("does not support todos");
	const offline = plain(
		new TodosDetail(
			() => list([item("a", "Kept", "pending")]),
			() => true,
		).lines(60, 10),
	);
	expect(offline).toContain("Offline");
	expect(offline).toContain("Kept");

	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	panel.height = 12;
	const notices: string[] = [];
	const opened = showTodos(panel, () => undefined, { notify: (message) => notices.push(message) });
	expect(opened).toBe(false);
	expect(panel.open).toBe(false);
	expect(notices).toEqual([TODOS_UNSUPPORTED]);

	expect(showTodos(panel, () => list([]), { notify: (message) => notices.push(message) })).toBe(true);
	expect(panel.open).toBe(true);
	expect(plain(panel.render(60))).toContain(todosEmpty());
	expect(notices).toHaveLength(1);
});

it("follows the latest committed list while open and closes with Esc", async () => {
	let current = list([item("a", "First draft", "pending")]);
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	panel.height = 12;
	showTodos(panel, () => current, { notify: () => {} });
	expect(plain(panel.render(60))).toContain("First draft");
	current = list([item("a", "First draft", "completed"), item("b", "Second step", "in_progress")], 2);
	const text = plain(panel.render(60));
	expect(text).toContain("1/2 completed");
	expect(text).toContain("Second step");
	expect(text).toContain("Esc Close");
	panel.handleInput("\x1b[B");
	panel.handleInput("\x1b[5~");
	expect(panel.open).toBe(true);
	panel.handleInput("\x1b");
	expect(panel.open).toBe(false);
});

it("shows todo text as plain text", () => {
	const detail = new TodosDetail(() =>
		list([
			item(
				"x",
				"Fix \x1b[2J\x1b]8;;http://evil.example\x07link\x1b]8;;\x07 \u202egnirts\u202c **bold** <b>tag</b>",
				"pending",
			),
		]),
	);
	const raw = detail.lines(80, 10).join("");
	expect(raw).not.toContain("\x1b[2J");
	expect(raw).not.toContain("\x1b]8");
	expect(raw).not.toContain("evil.example");
	const text = stripTerminalSequences(raw);
	expect(text).toContain("\\u202e");
	expect(text).toContain("**bold** <b>tag</b>");
});

it("offers a compact progress entry only for a non-empty list", () => {
	expect(todoProgressText(undefined)).toBeUndefined();
	expect(todoProgressText(list([]))).toBeUndefined();
	expect(todoProgressText(list([item("a", "A", "completed"), item("b", "B", "pending")]))).toBe("Todos 1/2");
	const footer = new StatusFooter();
	const stats = { cwd: "/p", model: "m", thinkingLevel: null, busy: undefined, usageText: "In: 0" };
	footer.setStats({ ...stats, todoProgress: "Todos 1/2" });
	for (const width of [80, 50, 40]) expect(plain(footer.render(width))).toContain("Todos 1/2");
	footer.setStats(stats);
	expect(plain(footer.render(80))).not.toContain("Todos");
});

it("is a documented command with its keys in the help", () => {
	expect(commands().map((command) => command.name)).toContain("todos");
	const text = plain(helpLines("darwin"));
	expect(text).toContain("/todos");
	expect(text).toContain("read-only");
});
