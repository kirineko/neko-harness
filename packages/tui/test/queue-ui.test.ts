import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { Container, ScrollView, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { WireQueuedInput } from "@neko-harness/gateway/contract";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { createAppLayout } from "../src/layout.ts";
import {
	QUEUE_BLOCK_LINES,
	QueueRow,
	queueKeyAction,
	restoreText,
	steerNotice,
	withdrawNotice,
} from "../src/queue-ui.ts";
import { setActiveTheme } from "../src/theme/index.ts";

setActiveTheme("light");
const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");
const item = (id: number, preview: string, extra: Partial<WireQueuedInput> = {}): WireQueuedInput => ({
	id,
	mode: "followUp",
	preview,
	images: 0,
	...extra,
});
const row = (...items: WireQueuedInput[]) => {
	const r = new QueueRow();
	r.setItems(items);
	return r;
};
const ALT_UP = "\x1b[1;3A";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

it("shows the newest queued messages next to the editor with a hint to select them", () => {
	const r = row(item(1, "one"), item(2, "two", { mode: "steer" }));
	expect(plain(r.render(60))).toBe("   Queued · one\n   Steer · two\n Alt+↑ Select queued");
	const many = row(...[1, 2, 3, 4, 5].map((n) => item(n, `m${n}`)));
	const text = plain(many.render(60));
	expect(text).toContain("Queued · m4");
	expect(text).toContain("Queued · m5");
	expect(text).not.toContain("m3");
	expect(text).toContain("3 earlier");
	expect(many.render(60)).toHaveLength(QUEUE_BLOCK_LINES);
	expect(row().render(60)).toEqual([]);
});

it("marks the selected message and shows the action keys while selecting", () => {
	const r = row(item(1, "one"), item(2, "two"), item(3, "three"));
	expect(r.select()).toBe(true);
	expect(r.current?.id).toBe(3);
	let text = plain(r.render(70));
	expect(text).toContain("› Queued · three");
	expect(text).not.toContain("› Queued · two");
	expect(text).toContain("Enter Steer · Esc Withdraw · ↑/↓ Move");
	r.move(-1);
	r.move(-1);
	expect(r.current?.id).toBe(1);
	text = plain(r.render(70));
	expect(text).toContain("› Queued · one");
	expect(text).toContain("1 newer");
	r.move(-1);
	expect(r.current?.id).toBe(1);
	r.move(1);
	r.move(1);
	r.move(1);
	expect(r.selecting).toBe(false);
	expect(r.current).toBeUndefined();
});

it("keeps the selection valid when the queue shrinks and ends it when the queue is empty", () => {
	const r = row(item(1, "one"), item(2, "two"), item(3, "three"));
	r.select();
	r.setItems([item(1, "one")]);
	expect(r.current?.id).toBe(1);
	r.setItems([]);
	expect(r.selecting).toBe(false);
	expect(r.visible).toBe(false);
	expect(r.select()).toBe(false);
});

it("truncates rows to the width, collapses whitespace and describes image-only messages", () => {
	const r = row(item(1, `${"long ".repeat(40)}`), item(2, "", { images: 2 }), item(3, "a\n\n  b"));
	r.select();
	for (const line of r.render(30)) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	expect(plain(r.render(70))).toContain("Queued · a b");
	expect(plain(row(item(1, ""), item(2, "", { images: 2 })).render(60))).toContain("[2 images]");
});

it("maps keys: Alt+Up selects, Enter steers, Esc only withdraws, others leave the selection", () => {
	const r = row(item(1, "one"), item(2, "two"));
	expect(queueKeyAction(r, ALT_UP, false)).toBe("select");
	expect(queueKeyAction(r, ALT_UP, true)).toBeUndefined();
	expect(queueKeyAction(r, UP, false)).toBeUndefined();
	expect(queueKeyAction(r, ESC, false)).toBeUndefined();
	expect(queueKeyAction(row(), ALT_UP, false)).toBeUndefined();
	r.select();
	expect(queueKeyAction(r, UP, false)).toBe("up");
	expect(queueKeyAction(r, DOWN, false)).toBe("down");
	expect(queueKeyAction(r, ENTER, false)).toBe("steer");
	expect(queueKeyAction(r, ESC, false)).toBe("withdraw");
	expect(queueKeyAction(r, "x", false)).toBe("leave");
});

it("keeps editor and footer visible next to the queue block, and hides the slot when empty", () => {
	const queue = new QueueRow();
	const footer = new StatusFooter();
	footer.setStats({ cwd: "/p", model: "m", thinkingLevel: "high", busy: undefined, usageText: "In: 0" });
	const layout = () =>
		createAppLayout({
			transcript: new ScrollView(new Text("history\n".repeat(200), 0, 0), { primary: true }),
			panel: new PickerPanel(
				() => {},
				() => {},
			),
			editor: new Text("input", 0, 0),
			footer,
			notices: new Container(),
			queue,
			queueVisible: () => queue.visible,
			panelOpen: () => false,
		});
	for (const [width, height] of [
		[80, 24],
		[45, 11],
	] as const) {
		queue.setItems([item(1, "first"), item(2, "second"), item(3, "third"), item(4, "fourth")]);
		queue.select();
		const text = plain(renderLayoutFrame(layout(), width, height, () => {}).lines);
		expect(text).toContain("› Queued · fourth");
		expect(text).toContain("Esc Withdraw");
		expect(text).toContain("input");
		expect(text).toContain("Ready");
		queue.setItems([]);
		expect(plain(renderLayoutFrame(layout(), width, height, () => {}).lines)).not.toContain("Queued");
	}
});

it("restores withdrawn text without losing what was typed and reports outcomes in English", () => {
	expect(restoreText("", "orig")).toBe("orig");
	expect(restoreText("  ", "orig")).toBe("orig");
	expect(restoreText("typed", "orig")).toBe("typed\norig");
	expect(withdrawNotice({ result: "withdrawn" })).toEqual({
		message: "Message withdrawn into the editor.",
		level: "info",
	});
	expect(withdrawNotice({ result: "withdrawn", images: 1 }).message).toContain("Images are not restored");
	expect(withdrawNotice({ result: "placed" }).message).toContain("already sent");
	expect(withdrawNotice({ result: "unknown" }).message).toContain("no longer queued");
	expect(steerNotice({ result: "steered" }).message).toContain("steer the current run");
	expect(steerNotice({ result: "withdrawn" })).toMatchObject({ level: "warning" });
	expect(steerNotice({ result: "placed" }).message).toContain("already sent");
});
