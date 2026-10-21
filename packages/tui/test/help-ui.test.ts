import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { NekoGatewayClient } from "@neko-harness/gateway";
import { PickerPanel } from "../src/components/picker.ts";
import { shortcutHints } from "../src/components/shortcut-hints.ts";
import { HelpDetail, helpLines } from "../src/help-ui.ts";
import { commands } from "../src/labels.ts";
import { SkillPreviewView } from "../src/skill-market-ui.ts";

it("lists commands and context-specific shortcuts, with platform clipboard keys", () => {
	const text = helpLines("darwin").map(stripTerminalSequences).join("\n");
	for (const command of commands()) expect(text).toContain(`/${command.name}`);
	for (const action of [
		"Alt+↑",
		"Esc Esc",
		"Browse previous inputs",
		"Ctrl+S",
		"Install for user",
		"Install for project",
		"PgUp",
		"Ctrl+V",
		"Undo",
		"Insert newline",
		"Main transcript and search",
	])
		expect(text).toContain(action);
	expect(helpLines("win32").map(stripTerminalSequences).join("\n")).toContain("Alt+V");
	expect(helpLines("linux", true).map(stripTerminalSequences).join("\n")).toContain("Alt+V");
});

it("scrolls help at narrow widths and closes directly to the main view", async () => {
	let closed = 0;
	const panel = new PickerPanel(
		() => {},
		() => {
			closed++;
		},
	);
	await panel.show(
		"Help",
		async () => [],
		async () => {},
	);
	const detail = new HelpDetail();
	panel.showDetail(detail);
	for (const width of [40, 60, 80]) {
		panel.height = 10;
		expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	}
	const first = detail.lines(58, 7);
	detail.scroll(4);
	expect(detail.lines(58, 7)).not.toEqual(first);
	detail.handleKey("\x1b[6~");
	expect(detail.lines(58, 7)).not.toEqual(first);
	panel.handleInput("\x1b");
	expect(panel.open).toBe(false);
	expect(closed).toBe(1);
});

it("scrolls skill previews by wheel and pages and keeps complete install hints visible", async () => {
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	const client = {
		skillMarket: {
			preview: async () => ({
				files: ["SKILL.md"],
				body: Array.from({ length: 100 }, (_, i) => `Line ${i}\n`).join("\n"),
			}),
		},
	} as unknown as NekoGatewayClient;
	const detail = new SkillPreviewView("test", client, panel);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const first = detail.lines(58, 8);
	detail.scroll(3);
	const scrolled = detail.lines(58, 8);
	expect(scrolled).not.toEqual(first);
	detail.handleKey("\x1b[6~");
	expect(detail.lines(58, 8)).not.toEqual(scrolled);
	detail.handleKey("\x1b[5~");
	expect(detail.lines(58, 8)).toEqual(scrolled);
	await panel.show(
		"Skills",
		async () => [],
		async () => {},
	);
	panel.showDetail({
		help: shortcutHints(
			["U", "Install user"],
			["P", "Install project"],
			["D", "Remove"],
			["V", "Preview"],
			["Esc", "Back"],
		),
		lines: () => ["Skill"],
		handleKey: () => false,
	});
	for (const width of [40, 60, 80]) {
		const lines = panel.render(width);
		const text = lines.map(stripTerminalSequences).join("\n");
		for (const label of ["Install user", "Install project", "Esc", "Back"]) expect(text).toContain(label);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	}
});
