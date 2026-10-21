import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

const THEMES = ["sakura", "light", "dark"] as const;
type Theme = (typeof THEMES)[number];
type Tokens = Map<string, string>;

function declarations(block: string): Tokens {
	const tokens: Tokens = new Map();
	for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
		const name = match[1];
		const value = match[2];
		if (name !== undefined && value !== undefined) tokens.set(name, value.trim());
	}
	return tokens;
}

function blockAfter(selector: RegExp): string {
	const match = selector.exec(css);
	if (!match) throw new Error(`missing block: ${selector}`);
	const start = css.indexOf("{", match.index);
	let depth = 0;
	for (let index = start; index < css.length; index++) {
		if (css[index] === "{") depth++;
		if (css[index] === "}" && --depth === 0) return css.slice(start + 1, index);
	}
	throw new Error(`unterminated block: ${selector}`);
}

const themeTokens: Record<Theme, Tokens> = {
	sakura: declarations(blockAfter(/:root,\s*\[data-theme="sakura"\]\s*\{/)),
	light: declarations(blockAfter(/^\[data-theme="light"\]\s*\{/m)),
	dark: declarations(blockAfter(/^\[data-theme="dark"\]\s*\{/m)),
};

function channel(value: number): number {
	const unit = value / 255;
	return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const match = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!match?.[1]) throw new Error(`not a #rrggbb color: ${hex}`);
	const [r, g, b] = [0, 2, 4].map((offset) => channel(Number.parseInt(match[1]?.slice(offset, offset + 2) ?? "0", 16)));
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

// [前景, 背景, 最低对比度, 说明]；文本 4.5，焦点环等非文本 3
const PAIRS: readonly (readonly [string, string, number, string])[] = [
	["--color-ink-900", "--color-base", 4.5, "正文 / 页面底"],
	["--color-ink-900", "--color-surface", 4.5, "正文 / 卡片与助手气泡"],
	["--color-ink-500", "--color-surface", 4.5, "次要文字 / 卡片"],
	["--color-ink-500", "--color-base", 4.5, "次要文字 / 页面底"],
	["--color-ink-600", "--color-ink-100", 4.5, "辅助文字 / 浅底"],
	["--color-ink-700", "--color-ink-100", 4.5, "导航文字 / hover 底"],
	["--color-ink-800", "--color-ink-100", 4.5, "行内代码"],
	["--color-sakura-900", "--color-sakura-200", 4.5, "用户气泡文字（渐变深端）"],
	["--color-sakura-900", "--color-sakura-100", 4.5, "用户气泡文字（渐变浅端）"],
	["--color-sakura-800", "--color-surface", 4.5, "强调文字 / 卡片"],
	["--color-sakura-700", "--color-surface", 4.5, "链接与强调 / 卡片"],
	["--color-sakura-800", "--color-sakura-100", 4.5, "选中项文字"],
	["--color-sakura-700", "--color-sakura-50", 4.5, "提示文字 / 浅强调底"],
	["--color-tianyi-800", "--color-surface", 4.5, "辅色文字 / 卡片"],
	["--color-tianyi-700", "--color-surface", 4.5, "辅色链接 / 卡片"],
	["--color-tianyi-900", "--color-tianyi-50", 4.5, "输入区提示 / 浅辅色底"],
	["--color-tianyi-800", "--color-tianyi-100", 4.5, "辅色徽章文字"],
	["--color-on-accent", "--color-tianyi-700", 4.5, "强调徽章文字"],
	["--color-ink-900", "--color-tianyi-50", 4.5, "代码块正文"],
	["--color-sakura-800", "--color-tianyi-50", 4.5, "代码高亮 keyword"],
	["--color-tianyi-800", "--color-tianyi-50", 4.5, "代码高亮 string"],
	["--color-tianyi-700", "--color-tianyi-50", 4.5, "代码高亮 number / built_in"],
	["--color-sakura-700", "--color-tianyi-50", 4.5, "代码高亮 title"],
	["--color-ink-600", "--color-tianyi-50", 4.5, "代码高亮 comment"],
	["--diff-add", "--color-tianyi-50", 4.5, "diff 增"],
	["--diff-del", "--color-tianyi-50", 4.5, "diff 删"],
	["--focus-ring", "--color-surface", 3, "焦点环 / 卡片"],
	["--focus-ring", "--color-base", 3, "焦点环 / 页面底"],
];

function value(theme: Theme, token: string): string {
	const found = themeTokens[theme].get(token);
	if (found === undefined) throw new Error(`${theme} is missing ${token}`);
	return found;
}

for (const theme of THEMES) {
	it(`${theme}: key color pairs meet WCAG contrast`, () => {
		const failures: string[] = [];
		for (const [foreground, background, minimum, label] of PAIRS) {
			const ratio = contrast(value(theme, foreground), value(theme, background));
			if (ratio < minimum) failures.push(`${label}: ${foreground} on ${background} = ${ratio.toFixed(2)} < ${minimum}`);
		}
		expect(failures).toEqual([]);
	});
}

it("keeps the sakura copy of the palette identical to the @theme source", () => {
	const source = declarations(blockAfter(/@theme\s*\{/));
	for (const [name, color] of source) {
		if (name.startsWith("--color-")) expect(themeTokens.sakura.get(name)).toBe(color);
	}
});

it("defines the same tokens in every theme block", () => {
	const names = (theme: Theme) => [...themeTokens[theme].keys()].filter((name) => !name.startsWith("--shadow-"));
	expect(names("light").sort()).toEqual(names("sakura").sort());
	expect(names("dark").sort()).toEqual(names("sakura").sort());
	const shadows = (theme: Theme) => [...themeTokens[theme].keys()].filter((name) => name.startsWith("--shadow-"));
	expect(shadows("dark").sort()).toEqual(shadows("light").sort());
});

it("switches the native color scheme with the theme", () => {
	expect(blockAfter(/:root,\s*\[data-theme="sakura"\]\s*\{/)).toContain("color-scheme: light");
	expect(blockAfter(/^\[data-theme="dark"\]\s*\{/m)).toContain("color-scheme: dark");
	expect(blockAfter(/^\[data-theme="light"\]\s*\{/m)).toContain("color-scheme: light");
});

it("dark: syntax highlight overrides stay readable on the code block background", () => {
	const background = value("dark", "--color-tianyi-50");
	const colors = [...css.matchAll(/\[data-theme="dark"\] \.hljs-[a-z_]+[^{]*\{\s*color:\s*(#[0-9a-f]{6});/gi)].map(
		(match) => match[1] ?? "",
	);
	expect(colors.length).toBeGreaterThanOrEqual(6);
	for (const color of colors) expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
});
