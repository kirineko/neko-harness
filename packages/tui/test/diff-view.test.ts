import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { diffTargetPath, highlightDiffLines, parseDiffLine, parseDiffLines } from "../src/components/diff-view.ts";
import { diffBackgroundAnsi, theme } from "../src/theme/slots.ts";
import { highlightCodeToAnsiLines, languageForPath } from "../src/theme/syntax.ts";

it("parses edit lines with line numbers and write lines without", () => {
	expect(parseDiffLine("+123 added")).toEqual({ prefix: "+", lineNum: "123", content: "added" });
	expect(parseDiffLine("-45 removed")).toEqual({ prefix: "-", lineNum: "45", content: "removed" });
	expect(parseDiffLine(" 12 context")).toEqual({ prefix: " ", lineNum: "12", content: "context" });
	// write 合成 diff:加号空格前缀、无行号。
	expect(parseDiffLine("+ fresh line", "write")).toEqual({ prefix: "+", lineNum: "", content: "fresh line" });
	// 上游行号按宽度 padding,文本原样保留。
	expect(parseDiffLine("+  7 padded")).toEqual({ prefix: "+", lineNum: "  7", content: "padded" });
	// 空内容行与无法解析的行。
	expect(parseDiffLine("+12 ")).toEqual({ prefix: "+", lineNum: "12", content: "" });
	expect(parseDiffLine("*** Begin Patch")).toBeNull();
	expect(parseDiffLine("")).toBeNull();
});

it("keeps unparseable lines as raw without losing content", () => {
	const parsed = parseDiffLines("*** Begin Patch\n+  1 a\n*** End Patch");
	expect(parsed[0]).toEqual({ kind: "raw", text: "*** Begin Patch" });
	expect(parsed[1]).toEqual({ kind: "add", lineNum: "  1", content: "a" });
	expect(parsed[2]).toEqual({ kind: "raw", text: "*** End Patch" });
});

it("extracts the target path from edit summaries and write details", () => {
	expect(diffTargetPath("edit", "src/foo.ts (3 edits)", null)).toBe("src/foo.ts");
	expect(diffTargetPath("edit", "foo.ts (1 edits)", null)).toBe("foo.ts");
	expect(diffTargetPath("edit", "no-count", null)).toBe("no-count");
	expect(diffTargetPath("write", "foo.ts", "foo.ts\ncontent")).toBe("foo.ts");
	expect(diffTargetPath("write", "foo.ts", null)).toBe("foo.ts");
	expect(diffTargetPath("write", "", null)).toBeUndefined();
	expect(diffTargetPath("bash", "npm test", null)).toBeUndefined();
});

it("maps path extensions to registered languages", () => {
	expect(languageForPath("src/a.ts")).toBe("ts");
	expect(languageForPath("x/Y.PY")).toBe("py");
	expect(languageForPath("noext")).toBeUndefined();
	expect(languageForPath(".env")).toBeUndefined();
	expect(languageForPath("x.unknownext")).toBeUndefined();
	expect(languageForPath(undefined)).toBeUndefined();
});

it("keeps syntax coloring continuous across a multi-line string", () => {
	const diff = ['  1 const s = "start', "+  2 middle", '  3 end";'].join("\n");
	const [ctx1, added, ctx2] = highlightDiffLines(diff, "ts");
	expect(ctx1!).toContain(theme.syntaxString('"start'));
	expect(added!).toContain(theme.syntaxString("middle"));
	expect(ctx2!).toContain(theme.syntaxString('end"'));
	// 新增行:语法色 + 行底色 + 弱化 gutter(保留原行号)。
	expect(added!).toContain(diffBackgroundAnsi("added"));
	expect(added!).toContain(theme.dim("+  2 "));
	expect(stripTerminalSequences(added!)).toBe("+  2 middle");
});

it("maps removed lines to the old document so block comments stay continuous", () => {
	const diff = ["  1 /* header", "-  2 old mid", "+  2 new mid", "  3 footer */"].join("\n");
	const [, removed, added, ctx] = highlightDiffLines(diff, "ts");
	expect(removed!).toContain(theme.syntaxComment("old mid"));
	expect(added!).toContain(theme.syntaxComment("new mid"));
	expect(ctx!).toContain(theme.syntaxComment("footer */"));
	expect(removed!).toContain(diffBackgroundAnsi("removed"));
	expect(removed!).toContain(theme.dim("-  2 "));
});

it("renders write diffs as fully-added highlighted content", () => {
	const diff = ["+ const a = 1;", "+ const b = 2;"].join("\n");
	const [first, second] = highlightDiffLines(diff, "ts", "write");
	expect(first!).toContain(theme.syntaxKeyword("const"));
	expect(first!).toContain(diffBackgroundAnsi("added"));
	expect(stripTerminalSequences(second!)).toBe("+ const b = 2;");
});

it("keeps write indentation and leading numbers in highlighted code rather than the gutter", () => {
	for (const content of ["    return 1", "123 + 4", "  7 padded", "", "  "]) {
		expect(parseDiffLine(`+ ${content}`, "write")).toEqual({ prefix: "+", lineNum: "", content });
		const [line] = highlightDiffLines(`+ ${content}`, "ts", "write");
		expect(stripTerminalSequences(line!)).toBe(`+ ${content}`);
		expect(line).toContain(theme.dim("+ "));
	}
	const [numeric] = highlightDiffLines("+ 123 + 4", "ts", "write");
	expect(numeric).toContain(theme.syntaxNumber("123"));
});

it("falls back to addition/deletion-only coloring for unknown languages", () => {
	const diff = "+ added line\n- removed line";
	expect(highlightDiffLines(diff, "not-a-language")).toEqual(highlightCodeToAnsiLines(diff, "diff"));
	expect(highlightDiffLines(diff, undefined)).toEqual(highlightCodeToAnsiLines(diff, "diff"));
	// 回退不丢内容。
	const stripped = highlightDiffLines(diff, "weird").map(stripTerminalSequences);
	expect(stripped[0]).toContain("+ added line");
	expect(stripped[1]).toContain("- removed line");
});
