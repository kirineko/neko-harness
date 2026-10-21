import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "../src/components/assistant-message.ts";
import { UserMessageComponent } from "../src/components/user-message.ts";

const render = (text: string, width = 60): string =>
	new AssistantMessageComponent({ thinking: "", text, note: null })
		.render(width)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.join("\n");

it("行内公式渲染为 Unicode，不残留定界符", () => {
	const out = render("质能方程 $E=mc^2$ 成立");
	expect(out).toContain("E = mc²");
	expect(out).not.toContain("$");
});

it("块级分式带分数线", () => {
	const out = render("$$\n\\frac{a+b}{c}\n$$");
	expect(out).toContain("a+b");
	expect(out).toContain("───");
	expect(out).not.toContain("$$");
});

it("括号定界符与 $ 效果一致", () => {
	const out = render("行内 \\(\\alpha+\\beta\\) 与块级\n\n\\[ x^2 \\]");
	expect(out).toContain("α+β");
	expect(out).toContain("x²");
	expect(out).not.toContain("\\(");
	expect(out).not.toContain("\\[");
});

it("表格单元格与列表中的公式正常渲染", () => {
	const table = render("| 公式 | 值 |\n|---|---|\n| $x^2$ | $\\frac{1}{2}$ |");
	expect(table).toContain("│ x²");
	expect(table).toContain("1/2");
	const list = render("- 列表 $a_1$\n> 引用 $\\alpha$");
	expect(list).toContain("列表 a₁");
	expect(list).toContain("引用 α");
});

it("用户消息中的公式同样渲染", () => {
	const lines = new UserMessageComponent("求 $x^2$").render(40).map((line) => stripTerminalSequences(line));
	expect(lines.join("\n")).toContain("x²");
});

it("货币、变量与代码中的 $ 保持原文", () => {
	const out = render("价格 $5 到 $10，变量 $HOME 和 $PATH，行内 `$x$`\n\n```sh\necho $x$\n```");
	expect(out).toContain("价格 $5 到 $10，变量 $HOME 和 $PATH");
	expect(out).toContain("$x$");
	expect(out).toContain("echo $x$");
	expect(out).not.toContain("echo x");
});

it("不支持的公式降级为原文，其余内容正常", () => {
	const out = render("$$\\textcolor{red}{x}$$\n\n之后 $x^2$ 与 $\\foo$");
	expect(out).toContain("$$\\textcolor{red}{x}$$");
	expect(out).toContain("x²");
	expect(out).toContain("$\\foo$");
});

it("流式未闭合保持原文，闭合后转为公式", () => {
	expect(render("$$\n\\frac{a+b")).toContain("\\frac{a+b");
	expect(render("流式中: $x^2 + \\frac{a")).toContain("$x^2 + \\frac{a");
	const closed = render("$$\n\\frac{a+b}{c}\n$$");
	expect(closed).toContain("a+b");
	expect(closed).not.toContain("\\frac");
});
