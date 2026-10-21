import { afterEach, expect, it } from "bun:test";
import { dateLocale, formatDateTime, relativeTime } from "../src/i18n/format.ts";
import { setLanguage } from "../src/i18n/index.ts";
import "./support/lang-en.ts";

afterEach(() => setLanguage("en"));

const AT = Date.UTC(2025, 2, 4, 15, 30, 0);
const MINUTE = 60_000;

it("uses zh-CN for Chinese and en-GB for English", () => {
	expect(dateLocale("zh")).toBe("zh-CN");
	expect(dateLocale("en")).toBe("en-GB");
	expect(formatDateTime(AT, "zh")).toBe(new Date(AT).toLocaleString("zh-CN"));
	expect(formatDateTime(AT, "en")).toBe(new Date(AT).toLocaleString("en-GB"));
});

it("follows the current language when none is passed", () => {
	expect(formatDateTime(AT)).toBe(formatDateTime(AT, "en"));
	setLanguage("zh");
	expect(formatDateTime(AT)).toBe(formatDateTime(AT, "zh"));
	expect(formatDateTime(AT)).not.toBe(formatDateTime(AT, "en"));
});

it("renders relative time per language and a locale date after 30 days", () => {
	const now = Date.UTC(2025, 5, 1, 12, 0, 0);
	expect(relativeTime(now - 10_000, now, "zh")).toBe("刚刚");
	expect(relativeTime(now - 10_000, now, "en")).toBe("now");
	expect(relativeTime(now - 5 * MINUTE, now, "zh")).toBe("5 分钟前");
	expect(relativeTime(now - 5 * MINUTE, now, "en")).toBe("5m");
	expect(relativeTime(now - 3 * 60 * MINUTE, now, "zh")).toBe("3 小时前");
	expect(relativeTime(now - 2 * 24 * 60 * MINUTE, now, "en")).toBe("2d");
	const old = now - 40 * 24 * 60 * MINUTE;
	expect(relativeTime(old, now, "zh")).toBe(new Date(old).toLocaleDateString("zh-CN"));
	expect(relativeTime(old, now, "en")).toBe(new Date(old).toLocaleDateString("en-GB"));
	expect(relativeTime(now - 5 * MINUTE, now)).toBe("5m");
	setLanguage("zh");
	expect(relativeTime(now - 5 * MINUTE, now)).toBe("5 分钟前");
});
