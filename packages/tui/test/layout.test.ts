import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { Container, ScrollView, stripTerminalSequences, Text, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { createAppLayout } from "../src/layout.ts";

const footer = () => {
	const f = new StatusFooter();
	f.setStats({
		cwd: "/projects/项目/neko-harness",
		model: "deepseek/deepseek-flash",
		thinkingLevel: "high",
		busy: undefined,
		usageText: "In: 12k Out: 2k $0.012",
	});
	return f;
};
it("reproduces legacy footer collapse when transcript grows", () => {
	const f = footer();
	const transcript = new ScrollView(new Text("history\n".repeat(1000), 0, 0), { primary: true });
	const dock = new VStack([
		{ component: new Text("input\ninput\ninput", 0, 0), shrink: 1, minSize: 3 },
		{ component: f, shrink: 1, minSize: 0 },
	]);
	const root = new VStack([
		{ component: transcript, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	const frame = renderLayoutFrame(root, 80, 24, () => {});
	const dockBox = frame.root.children[1]!;
	expect(dockBox.rect.height).toBeLessThan(5);
	expect(frame.lines.map(stripTerminalSequences).join("\n")).not.toContain("Ready");
});
it("keeps bottom rows, selection and help visible at supported sizes", async () => {
	for (const [width, height] of [
		[120, 40],
		[80, 24],
		[60, 16],
		[40, 10],
	] as const) {
		const panel = new PickerPanel(
			() => {},
			() => {},
		);
		const editor = new Text("input\ninput\ninput", 0, 0);
		const root = createAppLayout({
			transcript: new ScrollView(new Text("中文输出\n".repeat(500), 0, 0), { primary: true }),
			panel,
			editor,
			footer: footer(),
			notices: new Container(),
			panelOpen: () => panel.open,
		});
		let frame = renderLayoutFrame(root, width, height, () => {});
		expect(frame.lines.map(stripTerminalSequences).join("\n")).toContain("Ready");
		await panel.show(
			"Sessions",
			async () =>
				Array.from({ length: 30 }, (_, i) => ({
					value: String(i),
					label: `Session ${i} 自动命名与工作区排序标题`.repeat(4),
					rightLabel: "2h",
					description: "/very/long/path/".repeat(10),
				})),
			async () => {},
		);
		for (let i = 0; i < 29; i++) panel.handleInput("\x1b[B");
		frame = renderLayoutFrame(root, width, height, () => {});
		const plain = frame.lines.map(stripTerminalSequences).join("\n");
		expect(plain).toContain("❯ Session 29");
		expect(plain).toContain("Esc Close");
		expect(plain).toContain("Ready");
		expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	}
});
it("small window fallback preserves the editor draft", () => {
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	const editor = new Text("draft", 0, 0);
	const root = createAppLayout({
		transcript: new Text("history"),
		panel,
		editor,
		footer: footer(),
		notices: new Container(),
		panelOpen: () => false,
	});
	expect(renderLayoutFrame(root, 30, 8, () => {}).lines.join("\n")).toContain("Terminal too small");
	expect(renderLayoutFrame(root, 80, 24, () => {}).lines.join("\n")).toContain("draft");
});

it("bounds real multiline editing and slash completion without losing cursor or footer", async () => {
	const { TuiAltScreen, CombinedAutocompleteProvider, CURSOR_MARKER } = await import("@earendil-works/pi-tui");
	const { BoundedEditor } = await import("../src/components/editor.ts");
	const { getEditorTheme } = await import("../src/theme/index.ts");
	const terminal = { columns: 80, rows: 24 } as import("@earendil-works/pi-tui").Terminal;
	const ui = new TuiAltScreen(terminal);
	const editor = new BoundedEditor(ui, getEditorTheme(), { autocompleteMaxVisible: 2 });
	editor.focused = true;
	editor.setText(`${"中文 draft\n".repeat(30)}last line`);
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	const root = createAppLayout({
		transcript: new ScrollView(new Text("history\n".repeat(500)), { primary: true }),
		panel,
		editor,
		footer: footer(),
		notices: new Container(),
		panelOpen: () => panel.open,
	});
	let frame = renderLayoutFrame(root, 80, 24, () => {});
	expect(frame.lines.join("\n")).toContain("last line");
	expect(frame.lines.join("\n")).toContain(CURSOR_MARKER);
	expect(frame.lines.join("\n")).toContain("Ready");
	const draft = editor.getText(),
		cursor = editor.getCursor();
	await panel.show(
		"Sessions",
		async () => [{ value: "a", label: "A" }],
		async () => {},
	);
	renderLayoutFrame(root, 40, 10, () => {});
	panel.close();
	expect(editor.getText()).toBe(draft);
	expect(editor.getCursor()).toEqual(cursor);
	editor.setText("");
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Choose a model" },
				{ name: "sessions", description: "Switch sessions" },
			],
			process.cwd(),
		),
	);
	editor.handleInput("/");
	await new Promise((r) => setTimeout(r, 50));
	frame = renderLayoutFrame(root, 80, 24, () => {});
	expect(frame.lines.join("\n")).toContain("Ready");
	expect(frame.lines.join("\n")).toContain("Choose a model");
});
it("preserves image fallback, editor and compaction stop hints at all supported sizes", () => {
	for (const [width, height] of [
		[120, 40],
		[80, 24],
		[60, 16],
	] as const) {
		const f = footer();
		f.setStats({
			cwd: "/workspace",
			model: "Flash",
			thinkingLevel: "high",
			busy: undefined,
			compaction: "Waiting for compaction",
			canAbort: true,
			usageText: "In: 12k Out: 2k $0.001",
		});
		const root = createAppLayout({
			transcript: new ScrollView(new Text("[Image: photo.png · 800x500]\n".repeat(100))),
			panel: { height: 1, render: () => [], invalidate: () => {} },
			editor: new Text("[Image 1: photo.png]\n/compact keep decisions\n"),
			footer: f,
			notices: new Container(),
			panelOpen: () => false,
		});
		const frame = renderLayoutFrame(root, width, height, () => {});
		expect(frame.lines.map(stripTerminalSequences).join("\n")).toContain("Esc Stop");
		expect(frame.lines.every((l) => visibleWidth(l) <= width)).toBe(true);
		expect(frame.lines.length).toBe(height);
	}
});

it("keeps context occupancy visible ahead of cumulative usage at narrow widths", () => {
	const f = new StatusFooter();
	for (const percent of [null, 12.3, 95]) {
		f.setStats({
			cwd: "/projects/neko",
			model: "deepseek/flash",
			thinkingLevel: "high",
			busy: undefined,
			usageText: "In: 100k Out: 20k Cache: 80k $0.1234",
			contextUsage: { tokens: null, window: 1000000, percent },
		});
		for (const width of [40, 60, 80, 120]) {
			const lines = f.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.map(stripTerminalSequences).join("\n")).toContain("$0.1234");
			expect(lines.map(stripTerminalSequences).join("\n")).toContain(
				percent === null ? "Ctx ?/" : `Ctx ${percent.toFixed(1)}%/`,
			);
		}
	}
});
