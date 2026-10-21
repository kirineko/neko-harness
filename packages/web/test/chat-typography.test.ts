import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_APPEARANCE, FONTS, LEADINGS, SIZES, WEIGHTS } from "../src/client/lib/appearance.ts";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const composer = readFileSync(new URL("../src/client/components/composer.tsx", import.meta.url), "utf8");

function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
	if (!match?.[1]) throw new Error(`missing rule: ${selector}`);
	return match[1];
}

function declaration(block: string, property: string): string | undefined {
	return new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

it("defaults reproduce the layout from before chat typography was configurable", () => {
	const root = css.slice(
		css.indexOf("--chat-font-family: var(--font-sans)") - 10,
		css.indexOf('[data-chat-font="serif"]'),
	);
	expect(declaration(root, "--chat-font-family")).toBe("var(--font-sans)");
	expect(declaration(root, "--chat-font-size")).toBe("0.875rem");
	expect(declaration(root, "--chat-font-weight")).toBe("400");
	expect(declaration(root, "--chat-leading")).toBe("1.5");
	expect(declaration(root, "--chat-leading-md")).toBe("1.75");
	expect(DEFAULT_APPEARANCE).toMatchObject({ font: "sans", size: "14", weight: "regular", leading: "normal" });
});

it("has a selector for every non-default choice and none for the defaults", () => {
	for (const font of FONTS.filter((value) => value !== DEFAULT_APPEARANCE.font)) {
		expect(css).toContain(`[data-chat-font="${font}"]`);
	}
	for (const size of SIZES.filter((value) => value !== DEFAULT_APPEARANCE.size)) {
		expect(declaration(rule(`[data-chat-size="${size}"]`), "--chat-font-size")).toBe(`${Number(size) / 16}rem`);
	}
	for (const weight of WEIGHTS.filter((value) => value !== DEFAULT_APPEARANCE.weight)) {
		expect(css).toContain(`[data-chat-weight="${weight}"]`);
	}
	for (const leading of LEADINGS.filter((value) => value !== DEFAULT_APPEARANCE.leading)) {
		expect(css).toContain(`[data-chat-leading="${leading}"]`);
	}
	for (const attribute of ["font", "size", "weight", "leading"]) {
		const [, defaultValue] = Object.entries(DEFAULT_APPEARANCE).find(([key]) => key === attribute) ?? [];
		expect(css).not.toContain(`[data-chat-${attribute}="${defaultValue}"]`);
	}
});

it("keeps the serif and mono stacks as system fonts only", () => {
	expect(css).not.toMatch(/@font-face|fonts\.googleapis/);
	expect(declaration(rule('[data-chat-font="serif"]'), "--chat-font-family")).toContain("serif");
	expect(declaration(rule('[data-chat-font="mono"]'), "--chat-font-family")).toBe("var(--font-mono)");
});

it("applies the variables to bubbles, markdown body and the composer only", () => {
	for (const selector of [".bubble-user", ".bubble-assistant", ".composer-input"]) {
		const block = rule(selector);
		expect(declaration(block, "font-family")).toBe("var(--chat-font-family)");
		expect(declaration(block, "font-size")).toBe("var(--chat-font-size)");
		expect(declaration(block, "font-weight")).toBe("var(--chat-font-weight)");
		expect(declaration(block, "line-height")).toBe("var(--chat-leading)");
	}
	expect(declaration(rule(".md"), "line-height")).toBe("var(--chat-leading-md)");
	expect(composer).toContain("composer-input");
});

it("scales markdown headings relative to the chat size and keeps code blocks fixed", () => {
	const base = 14;
	const em = (selector: string) => Number.parseFloat(declaration(rule(selector), "font-size") ?? "0");
	expect(declaration(rule(".md h1"), "font-size")).toMatch(/em$/);
	// 默认 14px 下与此前的 1.25rem / 1.125rem / 1rem（20 / 18 / 16px）一致
	expect(Math.round(em(".md h1") * base)).toBe(20);
	expect(Math.round(em(".md h2") * base)).toBe(18);
	expect(declaration(rule(".md pre"), "font-size")).toBe("0.85rem");
	expect(declaration(rule(".md pre"), "font-weight")).toBe("400");
	expect(declaration(rule(".md code"), "font-family")).toBe("var(--font-mono)");
	expect(declaration(rule(".md code"), "font-weight")).toBe("400");
	expect(declaration(rule(".md strong,\n.md b"), "font-weight")).toBe("700");
});
