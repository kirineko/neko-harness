import "./support/lang-en.ts";
import { afterEach, expect, it } from "bun:test";
import { SLOT_NAMES } from "../src/theme/palette.ts";
import { darkTheme, getActiveThemeMode, lightTheme, setActiveTheme, style, theme } from "../src/theme/slots.ts";

const originalMode = getActiveThemeMode();
afterEach(() => {
	setActiveTheme(originalMode);
});

it("covers every slot in both themes and the dynamic delegate", () => {
	expect(SLOT_NAMES.length).toBe(33);
	for (const name of SLOT_NAMES) {
		expect(typeof darkTheme[name]).toBe("function");
		expect(typeof lightTheme[name]).toBe("function");
		expect(typeof theme[name]).toBe("function");
		expect(theme[name]("x")).toContain("x");
	}
});

it("delegates to the active theme and follows setActiveTheme", () => {
	setActiveTheme("dark");
	const darkAccent = theme.accent("accent");
	const darkUserBg = theme.userBg("bubble");
	setActiveTheme("light");
	expect(getActiveThemeMode()).toBe("light");
	// 明暗主题的 accent/userBg 配色不同,委托输出必须随切换改变。
	expect(theme.accent("accent")).not.toBe(darkAccent);
	expect(theme.userBg("bubble")).not.toBe(darkUserBg);
	expect(theme.accent("accent")).toBe(lightTheme.accent("accent"));
	setActiveTheme("dark");
	expect(theme.accent("accent")).toBe(darkAccent);
});

it("setActiveTheme reports whether the mode changed", () => {
	setActiveTheme("dark");
	expect(setActiveTheme("dark")).toBe(false);
	expect(setActiveTheme("light")).toBe(true);
});

it("keeps SGR attribute helpers theme-independent", () => {
	setActiveTheme("dark");
	const dark = style.bold("b");
	setActiveTheme("light");
	expect(style.bold("b")).toBe(dark);
	expect(style.italic("i")).toContain("i");
	expect(style.underline("u")).toContain("u");
	expect(style.strikethrough("s")).toContain("s");
});
