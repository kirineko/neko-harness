import "./support/lang-en.ts";
import { Container, ScrollView, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { expect, it } from "vitest";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { WelcomeScreen } from "../src/components/welcome.ts";
import { createAppLayout } from "../src/layout.ts";

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");

const footer = () => {
	const f = new StatusFooter();
	f.setStats({
		cwd: "/p",
		model: "deepseek/deepseek-flash",
		thinkingLevel: "high",
		busy: undefined,
		usageText: "In: 0 Out: 0 $0.00",
	});
	return f;
};

const layout = (busyVisible: boolean) =>
	createAppLayout({
		transcript: new ScrollView(new Text("history\n".repeat(200), 0, 0), { primary: true }),
		panel: new PickerPanel(
			() => {},
			() => {},
		),
		editor: new Text("input", 0, 0),
		footer: footer(),
		notices: new Container(),
		busy: new Text("spinner busy-row", 0, 0),
		busyVisible: () => busyVisible,
		panelOpen: () => false,
	});

it("shows the busy row only while busy, keeping editor and footer visible", () => {
	for (const [width, height] of [
		[80, 24],
		[60, 16],
	] as const) {
		const busyFrame = renderLayoutFrame(layout(true), width, height, () => {});
		const busyPlain = plain(busyFrame.lines);
		expect(busyPlain).toContain("busy-row");
		expect(busyPlain).toContain("Ready");
		expect(busyPlain).toContain("input");
		const idleFrame = renderLayoutFrame(layout(false), width, height, () => {});
		expect(plain(idleFrame.lines)).not.toContain("busy-row");
	}
});

it("welcome screen renders the pixel whale banner, fits 80x24, adapts to theme, and falls back on narrow widths", () => {
	const welcome = new WelcomeScreen();
	welcome.setModelLine("deepseek-flash · Think high");

	const wide80 = welcome.render(80);
	expect(wide80.length).toBeLessThanOrEqual(20);
	const first = plain(wide80);
	expect(first).toContain("▀");
	expect(first).toContain("█");
	expect(first).toContain("deepseek-flash · Think high");
	expect(first).toContain("Type a message");

	for (const width of [80, 60, 45]) {
		for (const line of welcome.render(width)) {
			expect(stripTerminalSequences(line).length).toBeLessThanOrEqual(width);
		}
	}

	welcome.setModelLine("deepseek-chat · Think max");
	expect(plain(welcome.render(60))).toContain("deepseek-chat · Think max");

	// 窄宽度下退化为紧凑文本布局且不溢出。
	const narrow = welcome.render(24);
	expect(plain(narrow)).toContain("neko harness");
	for (const line of narrow) expect(stripTerminalSequences(line).length).toBeLessThanOrEqual(24);
});
