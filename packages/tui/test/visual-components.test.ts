import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "../src/components/assistant-message.ts";
import { StatusFooter, usageText } from "../src/components/footer.ts";
import { formatNotice } from "../src/components/notice.ts";
import { shortcutHints } from "../src/components/shortcut-hints.ts";
import { UserMessageComponent } from "../src/components/user-message.ts";
import { labels } from "../src/labels.ts";
import { setActiveTheme, theme } from "../src/theme/index.ts";

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

it("user bubble carries a sakura left bar on every line, content inset by two cells", () => {
	const bubble = new UserMessageComponent("first line\nsecond line");
	const lines = plain(bubble.render(40));
	expect(lines[0]).toBe("▍ first line");
	expect(lines[1]).toBe("▍ second line");
	// 左缘条为 accent 色、底色 userBg。
	const raw = bubble.render(40)[0]!;
	expect(raw.startsWith(theme.userBg(theme.accent("▍")))).toBe(true);
});

it("skill invocation rows share the same left bar", () => {
	const bubble = new UserMessageComponent("/skill:pdf args", {
		name: "pdf",
		args: "args",
		body: "<skill>body</skill>",
		location: "~/.agents/skills/pdf/SKILL.md",
	});
	const lines = plain(bubble.render(60));
	expect(lines[0]).toContain("▍ ");
	expect(lines[0]).toContain("✦ skill:pdf");
});

it("collapsed thinking shows the ✧ label and expands on demand", () => {
	const message = new AssistantMessageComponent({ thinking: "deep thought", text: "answer", note: null });
	expect(plain(message.render(60)).join("\n")).toContain("✧ Thinking… (click to expand)");
	message.setThinkingExpanded(true);
	expect(plain(message.render(60)).join("\n")).toContain("deep thought");
});

it("footer splits identity (left) and status (right) on the main line", () => {
	const footer = new StatusFooter();
	footer.setStats({
		cwd: "/projects/neko-harness",
		model: "deepseek/deepseek-flash",
		thinkingLevel: "high",
		busy: undefined,
		usageText: usageText(1200, 3400, 500, 0.0123),
		contextUsage: { tokens: 10000, window: 64000, percent: 15.6 },
	});
	const [main, second] = plain(footer.render(100));
	expect(main).toContain("neko-harness · deepseek-flash · Think high");
	expect(main!.endsWith("Ready")).toBe(true);
	expect(second).toContain("Ctx 15.6%/64.0k");
	expect(second).toContain("·");
});

it("footer colors context usage by threshold", () => {
	const footer = new StatusFooter();
	const stats = (percent: number) => ({
		cwd: "/p",
		model: "deepseek/deepseek-flash",
		thinkingLevel: null,
		busy: undefined,
		usageText: usageText(0, 0, 0, 0),
		contextUsage: { tokens: 1, window: 100, percent },
	});
	footer.setStats(stats(95));
	expect(footer.render(100)[1]).toContain(theme.error("Ctx 95.0%/100"));
	footer.setStats(stats(80));
	expect(footer.render(100)[1]).toContain(theme.warning("Ctx 80.0%/100"));
	footer.setStats(stats(10));
	expect(footer.render(100)[1]).toContain(theme.muted("Ctx 10.0%/100"));
});

it("formats notices in three levels with glyph prefixes", () => {
	expect(formatNotice("saved")).toBe(theme.muted("i saved"));
	expect(formatNotice("careful", "warning")).toBe(theme.warning("! careful"));
	expect(formatNotice("broken", "error")).toBe(theme.error("✗ broken"));
});

it("assistant code block background spans the full content width", () => {
	const message = new AssistantMessageComponent({
		thinking: "",
		text: "```ts\nconst a = 1;\n\nreturn a;\n```",
		note: null,
	});
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 SGR 转义序列
	const codeLines = message.render(50).filter((line) => /\x1b\[48;/.test(line));
	expect(codeLines.length).toBe(3);
	for (const line of codeLines) {
		// 底色直达内容区右缘(仅余 Markdown 右边距 1 格),整块铺满内容宽度。
		expect(line.endsWith("\x1b[49m ") || line.endsWith("\x1b[49m\x1b[39m ")).toBe(true);
	}
});

it("uses shared title-case actions and uppercase letter keys across menu hints in both themes", () => {
	try {
		for (const mode of ["light", "dark"] as const) {
			setActiveTheme(mode);
			const skills = shortcutHints(["u", "User"], ["v", "Preview"], ["Esc", "Back"]);
			expect(stripTerminalSequences(skills)).toBe("U User · V Preview · Esc Back");
			expect(skills).toContain(theme.accent("U"));
			expect(skills).toContain(theme.dim("Preview"));
			expect(labels.select).toContain(theme.accent("Enter"));
			expect(labels.close).toContain(theme.accent("Esc"));
		}
	} finally {
		setActiveTheme("light");
	}
});
