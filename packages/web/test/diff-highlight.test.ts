import { expect, it } from "vitest";
import {
	type DiffRow,
	diffPathFromSummary,
	languageFromPath,
	parseDiffLine,
	renderDiffRows,
} from "../src/client/lib/diff-highlight.ts";

const kind = (rows: DiffRow[], i: number): string => rows[i]?.kind ?? "";
const html = (rows: DiffRow[], i: number): string => rows[i]?.html ?? "";
const gutter = (rows: DiffRow[], i: number): string => rows[i]?.gutter ?? "";

// edit 上游格式（带行号）+ 跨行字符串：删除 var/新增 const，字符串跨第 2、3 行。
const TS_DIFF = [
	" 1 const a = 1;",
	'-2 var s = "alpha',
	'-3   beta";',
	'+2 const s = "alpha',
	'+3   beta";',
	" 4 const b = 2;",
].join("\n");

it("parses both diff line formats", () => {
	expect(parseDiffLine("+123 content")).toEqual({ prefix: "+", lineNum: "123", content: "content" });
	expect(parseDiffLine("-45 content")).toEqual({ prefix: "-", lineNum: "45", content: "content" });
	expect(parseDiffLine(" 12 content")).toEqual({ prefix: " ", lineNum: "12", content: "content" });
	expect(parseDiffLine("+ content", "write")).toEqual({ prefix: "+", lineNum: "", content: "content" });
	expect(parseDiffLine("not a diff line")).toBeNull();
	expect(parseDiffLine("")).toBeNull();
});

it("rebuilds new/old documents and maps tokens back to diff rows", () => {
	const { kind: mode, rows } = renderDiffRows(TS_DIFF, "ts");
	expect(mode).toBe("highlighted");
	expect(rows.map((r) => r.kind)).toEqual(["context", "removed", "removed", "added", "added", "context"]);
	expect(rows.map((r) => r.gutter)).toEqual([" 1", "-2", "-3", "+2", "+3", " 4"]);
	// context 行取新文件 token。
	expect(html(rows, 0)).toContain("hljs-keyword");
	expect(html(rows, 0)).toContain("const");
	// 删除行取旧文件 token（旧文档是 var，新文档是 const）。
	expect(html(rows, 1)).toContain("hljs-keyword");
	expect(html(rows, 1)).toContain("var");
	expect(html(rows, 3)).toContain("const");
	// 跨行字符串：新增第 3 行的开标签由标签栈延续（行首重新打开 hljs-string）。
	expect(html(rows, 4).startsWith('<span class="hljs-string">')).toBe(true);
	expect(html(rows, 4)).toContain("beta");
	// hljs 输出已转义，不出现原始脚本标记。
	expect(rows.map((r) => r.html).join("")).not.toContain("<script");
});

it("continues block comment highlighting across context and changed lines", () => {
	const diff = [" 1 /* header", "-2  old tail */ let x = 1;", "+2  new tail */ let x = 2;"].join("\n");
	const { kind: mode, rows } = renderDiffRows(diff, "ts");
	expect(mode).toBe("highlighted");
	expect(html(rows, 2).startsWith('<span class="hljs-comment">')).toBe(true);
	expect(html(rows, 2)).toContain("new tail");
});

it("renders write diffs as fully added highlighted rows", () => {
	const { kind: mode, rows } = renderDiffRows('+ const a = 1;\n+ const b = "x";', "ts", "write");
	expect(mode).toBe("highlighted");
	expect(rows.map((r) => r.kind)).toEqual(["added", "added"]);
	expect(rows.map((r) => r.gutter)).toEqual(["+", "+"]);
	expect(html(rows, 0)).toContain("hljs-keyword");
	expect(html(rows, 1)).toContain("hljs-string");
});

it("preserves write indentation, leading numbers, and empty rows outside the gutter", () => {
	for (const content of ["    return 1", "123 + 4", "  7 padded", "\t123", "", "  "]) {
		expect(parseDiffLine(`+ ${content}`, "write")).toEqual({ prefix: "+", lineNum: "", content });
		for (const lang of ["ts", undefined]) {
			const { rows } = renderDiffRows(`+ ${content}`, lang, "write");
			expect(rows[0]?.gutter).toBe("+");
			expect(rows[0]?.html.replace(/<[^>]*>/g, "")).toBe(content);
		}
	}
	// 相同文本在 edit 中确实含有 padded 行号。
	expect(parseDiffLine("+   7 padded", "edit")).toEqual({ prefix: "+", lineNum: "   7", content: "padded" });
});

it("falls back to add/remove-only coloring for unknown languages", () => {
	expect(languageFromPath("file.weird")).toBeUndefined();
	const { kind: mode, rows } = renderDiffRows(TS_DIFF, undefined);
	expect(mode).toBe("plain");
	expect(rows).toHaveLength(6);
	// 内容不缺失、已转义、无语法类名。
	expect(html(rows, 1)).toBe("var s = &quot;alpha");
	expect(html(rows, 4)).toBe("  beta&quot;;");
	expect(rows.map((r) => r.html).join("")).not.toContain("hljs-");
	expect(rows.map((r) => r.gutter)).toEqual([" 1", "-2", "-3", "+2", "+3", " 4"]);
});

it("keeps unparseable lines without breaking row mapping", () => {
	const { kind: mode, rows } = renderDiffRows("+++ b/foo.ts\n 1 const a = 1;", "ts");
	expect(mode).toBe("highlighted");
	expect(rows).toHaveLength(2);
	expect(kind(rows, 0)).toBe("context");
	expect(html(rows, 0)).toBe("+++ b/foo.ts");
	expect(html(rows, 1)).toContain("hljs-keyword");
});

it("tolerates a trailing newline", () => {
	const { rows } = renderDiffRows("+ const a = 1;\n", "ts", "write");
	expect(rows).toHaveLength(2);
	expect(kind(rows, 1)).toBe("context");
	expect(gutter(rows, 1)).toBe("");
});

it("infers highlight languages from file paths", () => {
	expect(languageFromPath("src/foo.ts")).toBe("ts");
	expect(languageFromPath("a/b/c.py")).toBe("py");
	expect(languageFromPath("x.sh")).toBe("sh");
	expect(languageFromPath("README.md")).toBe("md");
	expect(languageFromPath("noext")).toBeUndefined();
	expect(languageFromPath(".env")).toBeUndefined();
	expect(languageFromPath("file.weird")).toBeUndefined();
	expect(languageFromPath(null)).toBeUndefined();
});

it("extracts the target path from tool summaries", () => {
	expect(diffPathFromSummary("write", "src/a.ts")).toBe("src/a.ts");
	expect(diffPathFromSummary("write", "")).toBeNull();
	expect(diffPathFromSummary("edit", "src/a.ts (3 edits)")).toBe("src/a.ts");
	expect(diffPathFromSummary("edit", "很長的前綴…中間截斷名稱.ts (1 edits)")).toBe("很長的前綴…中間截斷名稱.ts");
	expect(diffPathFromSummary("edit", "no suffix")).toBeNull();
	expect(diffPathFromSummary("bash", "ls -la")).toBeNull();
});
