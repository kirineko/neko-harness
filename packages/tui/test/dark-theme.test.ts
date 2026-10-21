import "./support/lang-en.ts";
import { afterEach, expect, it } from "bun:test";
import {
	backgroundAnsi,
	foregroundAnsi,
	parseColor,
	resetCapabilitiesCache,
	setCapabilityOverrides,
	stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "../src/components/assistant-message.ts";
import { formatNotice } from "../src/components/notice.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { ThemedText, ThemedTruncatedText } from "../src/components/themed-text.ts";
import { ToolExecutionComponent } from "../src/components/tool-execution.ts";
import { UserMessageComponent } from "../src/components/user-message.ts";
import { DARK_PALETTE, type ThemeSlotName } from "../src/theme/palette.ts";
import { getActiveThemeMode, setActiveTheme, theme } from "../src/theme/slots.ts";

const original = getActiveThemeMode();
afterEach(() => {
	setActiveTheme(original);
	resetCapabilitiesCache();
});
function luminance(hex: string): number {
	const rgb = [1, 3, 5]
		.map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
		.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
it("keeps readable text on the surfaces where components actually use it", () => {
	const matrix: Partial<Record<ThemeSlotName, ThemeSlotName[]>> = {
		panel: ["accent", "muted", "dim", "ok", "warning", "error", "codeFg"],
		userBg: ["userText", "toolTitle", "dim", "accent", "muted"],
		toolPendingBg: ["toolTitle", "dim", "toolOutput", "accent", "error"],
		toolSuccessBg: ["toolTitle", "dim", "toolOutput", "ok", "error"],
		toolErrorBg: ["toolTitle", "dim", "toolOutput", "error"],
		selection: ["selection"],
		codeBg: [
			"codeFg",
			"diffAdded",
			"diffRemoved",
			"diffContext",
			"syntaxComment",
			"syntaxKeyword",
			"syntaxFunction",
			"syntaxVariable",
			"syntaxString",
			"syntaxNumber",
			"syntaxType",
			"syntaxOperator",
			"syntaxPunctuation",
		],
	};
	for (const [surface, text] of Object.entries(matrix)) {
		const bg = DARK_PALETTE[surface as ThemeSlotName];
		for (const name of [surface as ThemeSlotName, ...text]) {
			const fg = DARK_PALETTE[name].fg!;
			expect(fg, `${name} has a foreground`).toBeDefined();
			const levels = [luminance(fg), luminance(bg.bg!)].sort((a, b) => a - b);
			expect((levels[1]! + 0.05) / (levels[0]! + 0.05), `${name}/${surface}`).toBeGreaterThanOrEqual(4.5);
		}
	}
});

it("restores surface defaults after nested resets and respects explicit colors in both modes", () => {
	setActiveTheme("dark");
	for (const trueColor of [true, false]) {
		setCapabilityOverrides({ trueColor });
		const mode = trueColor ? "truecolor" : "256color";
		const fg = foregroundAnsi(parseColor(DARK_PALETTE.panel.fg!), mode);
		const bg = backgroundAnsi(parseColor(DARK_PALETTE.panel.bg!), mode);
		const inner = theme.error("failed");
		const output = theme.panel(`plain ${inner} normal\x1b[0m reset\x1b[0;31m red\x1b[39m default`);
		expect(output).toContain(`${inner}${fg} normal`);
		expect(output).toContain(`\x1b[0m${fg}${bg} reset`);
		expect(output).toContain(`\x1b[0;31m${bg} red`);
		expect(output).toContain(`\x1b[39m${fg} default`);
		expect(stripTerminalSequences(output)).toBe("plain failed normal reset red default");
		expect(theme.panel("\x1b[38;2;0;39;49m rgb")).toContain("\x1b[38;2;0;39;49m rgb");
		if (!trueColor) expect(output).not.toContain(";2;");
	}
});

it("restyles existing history, expanded content, notices and streamed text without resetting content", async () => {
	setCapabilityOverrides({ trueColor: true });
	setActiveTheme("light");
	const assistant = new AssistantMessageComponent(
		{ thinking: "saved thought", text: "```ts\nconst x = 1; // note\n```", note: "interrupted" },
		true,
	);
	assistant.setThinkingExpanded(true);
	const user = new UserMessageComponent("", undefined, { version: 1, text: "saved prompt" });
	user.setExpanded(true);
	const skill = new UserMessageComponent("", { name: "pdf", args: "args", body: "body", location: "/skills/pdf" });
	const cards = ["pending", "running", "done"].flatMap((phase) =>
		[false, true].map((isError) => {
			const card = new ToolExecutionComponent({
				name: "read",
				summary: "file.ts",
				detail: "saved arguments",
				phase: phase as "pending" | "running" | "done",
				isError,
				output: "partial",
				result: "saved output",
				durationMs: 1,
				note: null,
				diff: null,
				diffAdded: null,
				diffRemoved: null,
			});
			card.setExpanded(true);
			return card;
		}),
	);
	const system = new ThemedText("system message", theme.dim);
	const notice = new ThemedTruncatedText(() => formatNotice("saved notice"));
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	await panel.show(
		"Details",
		async () => [{ value: "one", label: "One" }],
		async () => {},
	);
	panel.showDetail({ help: "Esc Back", lines: () => ["saved detail"], handleKey: () => false });
	const components = [assistant, user, skill, ...cards, system, notice, panel];
	const render = () => components.map((c) => c.render(80).join("\n"));
	const light = render();
	setActiveTheme("dark");
	for (const c of components) c.invalidate();
	const dark = render();
	for (let i = 0; i < light.length; i++) {
		expect(stripTerminalSequences(dark[i]!)).toBe(stripTerminalSequences(light[i]!));
		expect(dark[i]).not.toBe(light[i]);
	}
	expect(dark[0]).toContain(theme.thinking("saved thought"));
	expect(stripTerminalSequences(dark[1]!)).toContain("saved prompt");
	expect(panel.open).toBe(true);
	setActiveTheme("light");
	for (const c of components) c.invalidate();
	expect(render()).toEqual(light);
	system.setText("updated message");
	expect(stripTerminalSequences(system.render(80).join(""))).toContain("updated message");
});
