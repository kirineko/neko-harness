import "./support/lang-en.ts";
import { afterEach, expect, it } from "bun:test";
import { getActiveThemeMode, setActiveTheme, theme } from "../src/theme/slots.ts";
import { highlightCodeToAnsiLines, loadAllHighlightLanguages } from "../src/theme/syntax.ts";

const originalMode = getActiveThemeMode();
afterEach(() => {
	setActiveTheme(originalMode);
});

it("highlights known languages with scope colors and follows the active theme", () => {
	setActiveTheme("dark");
	const code = 'const s = "hi"; // note';
	const dark = highlightCodeToAnsiLines(code, "ts");
	expect(dark).toHaveLength(1);
	const line = dark[0]!;
	// 文本内容完整保留(实体解码后)。
	expect(line).toContain("const");
	expect(line).toContain('"hi"');
	expect(line).toContain("// note");
	// 多种 scope 着色:keyword 与 string 的着色不同。
	expect(line).toContain(theme.syntaxKeyword("const"));
	expect(line).toContain(theme.syntaxString('"hi"'));
	setActiveTheme("light");
	expect(highlightCodeToAnsiLines(code, "ts")[0]).not.toBe(line);
});

it("falls back to flat code styling for unknown or missing languages", () => {
	const code = "line one\nline two";
	// 平涂路径同样补齐为等宽矩形(两行同宽,无需 padding)。
	const expected = code.split("\n").map((line) => theme.codeBg(theme.codeFg(line)));
	expect(highlightCodeToAnsiLines(code, undefined)).toEqual(expected);
	expect(highlightCodeToAnsiLines(code, "not-a-language")).toEqual(expected);
	expect(highlightCodeToAnsiLines(code, "  ")).toEqual(expected);
});

it("pads every line to a uniform background rectangle, including blank lines", () => {
	const lines = highlightCodeToAnsiLines("x\n", undefined);
	// 两行都铺底色且同宽(宽行 1 格,空行也补齐到 1 格)。
	expect(lines[0]).toBe(theme.codeBg(theme.codeFg("x")));
	expect(lines[1]).toBe(theme.codeBg(`${theme.codeFg("")} `));
	const ragged = highlightCodeToAnsiLines("x\nlonger line", undefined);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 SGR 转义序列
	const widths = ragged.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length);
	expect(widths[0]).toBe(widths[1]);
});

it("decodes HTML entities in highlighted output", () => {
	const [line] = highlightCodeToAnsiLines("if (a < b && c > d) {}", "js");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: 匹配 SGR 转义序列
	const plain = line!.replace(/\x1b\[[0-9;]*m/g, "");
	expect(plain).toBe("if (a < b && c > d) {}");
});

it("routes diff additions and deletions to diff slots", () => {
	const [added, removed] = highlightCodeToAnsiLines("+new line\n-old line", "diff");
	expect(added).toBe(theme.codeBg(theme.diffAdded("+new line")));
	expect(removed).toBe(theme.codeBg(theme.diffRemoved("-old line")));
});

it("normalizes the shell alias to bash", () => {
	const viaAlias = highlightCodeToAnsiLines("echo hi", "shell");
	const flat = highlightCodeToAnsiLines("echo hi", undefined);
	expect(viaAlias).not.toEqual(flat);
});

it("lazily registers the full language set without breaking highlighting", async () => {
	await loadAllHighlightLanguages();
	// 懒加载后 eager 语言仍可高亮,且非 eager 语言(如 ini)也可用。
	expect(highlightCodeToAnsiLines("x = 1", "python")[0]).toContain("x");
	expect(highlightCodeToAnsiLines("[s]\nk=v", "ini")[0]).not.toBe(theme.codeFg(theme.codeBg("[s]")));
});
