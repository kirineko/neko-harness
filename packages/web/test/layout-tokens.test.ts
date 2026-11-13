import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { COLUMN_TIERS, MESSAGE_COLUMN_REM, MOBILE_BREAKPOINT } from "../src/client/lib/layout.ts";

const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");

// CSS 媒体查询无法引用 TS 常量，这里对拍防止两侧漂移。
it("keeps the mobile breakpoint in sync between styles.css and layout.ts", () => {
	const rem = MOBILE_BREAKPOINT / 16;
	expect(css).toContain(`--breakpoint-mobile: ${rem}rem`);
	expect(css).toContain(`@media (max-width: ${rem}rem)`);
});

it("keeps the base message column width in sync between styles.css and layout.ts", () => {
	expect(css).toMatch(new RegExp(`\\.chat-column\\s*\\{[^}]*--column-w:\\s*${MESSAGE_COLUMN_REM}rem`));
});

it("keeps wide-screen column tiers in sync between styles.css and layout.ts", () => {
	for (const tier of COLUMN_TIERS) {
		const block = new RegExp(
			`@media \\(min-width: ${tier.minViewportRem}rem\\) \\{[^}]*--column-w: ${tier.columnRem}rem`,
		);
		expect(css).toMatch(block);
	}
});
