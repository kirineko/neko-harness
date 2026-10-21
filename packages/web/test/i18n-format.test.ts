import { afterEach, expect, it } from "bun:test";
import { formatDate, formatDateTime, formatRelative, LOCALES } from "../src/client/lib/i18n/format.ts";
import { languageStore } from "../src/client/lib/language.ts";

afterEach(() => languageStore().reset());

const AT = Date.UTC(2025, 2, 4, 15, 30, 0);

it("uses zh-CN for Chinese and en-GB for English", () => {
	expect(LOCALES).toEqual({ zh: "zh-CN", en: "en-GB" });
	expect(formatDateTime(AT, "zh")).toBe(new Date(AT).toLocaleString("zh-CN"));
	expect(formatDateTime(AT, "en")).toBe(new Date(AT).toLocaleString("en-GB"));
	expect(formatDate(AT, "zh")).toBe(new Date(AT).toLocaleDateString("zh-CN"));
	expect(formatDate(AT, "en")).toBe(new Date(AT).toLocaleDateString("en-GB"));
});

it("never mixes locales: the two languages render differently and en-GB is day first", () => {
	const noon = new Date(2025, 2, 4, 12, 0, 0).getTime();
	expect(formatDate(noon, "zh")).not.toBe(formatDate(noon, "en"));
	expect(formatDate(noon, "en")).toBe("04/03/2025");
	expect(formatDate(noon, "zh")).toMatch(/^2025\/3\/4$/);
	expect(formatDateTime(noon, "zh")).not.toMatch(/[ap]m/i);
});

it("follows the current language when none is passed", () => {
	expect(formatDate(AT)).toBe(formatDate(AT, "zh"));
	languageStore().set("en");
	expect(formatDate(AT)).toBe(formatDate(AT, "en"));
	expect(formatDateTime(AT)).toBe(formatDateTime(AT, "en"));
});

it("renders relative time per language and falls back to an absolute date after 30 days", () => {
	const now = Date.UTC(2025, 5, 1, 12, 0, 0);
	const minute = 60_000;
	expect(formatRelative(now - 10_000, now, "zh")).toBe("刚刚");
	expect(formatRelative(now - 10_000, now, "en")).toBe("now");
	expect(formatRelative(now - 5 * minute, now, "zh")).toBe("5 分钟前");
	expect(formatRelative(now - 5 * minute, now, "en")).toBe("5m");
	expect(formatRelative(now - 3 * 60 * minute, now, "zh")).toBe("3 小时前");
	expect(formatRelative(now - 3 * 60 * minute, now, "en")).toBe("3h");
	expect(formatRelative(now - 2 * 24 * 60 * minute, now, "zh")).toBe("2 天前");
	expect(formatRelative(now - 2 * 24 * 60 * minute, now, "en")).toBe("2d");
	const old = now - 40 * 24 * 60 * minute;
	expect(formatRelative(old, now, "zh")).toBe(formatDate(old, "zh"));
	expect(formatRelative(old, now, "en")).toBe(formatDate(old, "en"));
	languageStore().set("en");
	expect(formatRelative(now - 5 * minute, now)).toBe("5m");
});
