import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { Container, ScrollView, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { WelcomeScreen } from "../src/components/welcome.ts";
import { createAppLayout } from "../src/layout.ts";

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

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

it("welcome screen renders the brand block with a live model line", () => {
	const welcome = new WelcomeScreen();
	welcome.setModelLine("deepseek-flash · Think high");
	const first = plain(welcome.render(60));
	expect(first).toContain("neko harness");
	expect(first).toContain("deepseek-flash · Think high");
	expect(first).toContain("Type a message");
	expect(first).toContain("|\\___/|");
	welcome.setModelLine("deepseek-chat · Think max");
	expect(plain(welcome.render(60))).toContain("deepseek-chat · Think max");
	// 窄宽度下不溢出。
	for (const line of welcome.render(24)) expect(stripTerminalSequences(line).length).toBeLessThanOrEqual(24);
});
