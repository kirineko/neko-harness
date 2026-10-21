import { expect, it } from "bun:test";
import { findProtectedTerms } from "@neko-harness/core/protected-terms";
import { en } from "../src/i18n/en.ts";
import { zh } from "../src/i18n/zh.ts";

const zhEntries = Object.entries(zh as Record<string, string>);
const enDict = en as Record<string, string>;
const placeholders = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ""))].sort();

it("has the same keys in both languages", () => {
	const zhKeys = Object.keys(zh).sort();
	const enKeys = Object.keys(en).sort();
	expect(enKeys.filter((key) => !(key in zh))).toEqual([]);
	expect(zhKeys.filter((key) => !(key in en))).toEqual([]);
	expect(enKeys).toEqual(zhKeys);
});

it("has no empty values", () => {
	for (const [key, text] of zhEntries) {
		expect(text.trim() === "" ? key : null).toBeNull();
		expect((enDict[key] ?? "").trim() === "" ? key : null).toBeNull();
	}
});

it("uses the same {placeholders} in both languages", () => {
	const mismatched = zhEntries
		.filter(([key, text]) => placeholders(text).join() !== placeholders(enDict[key] ?? "").join())
		.map(([key]) => key);
	expect(mismatched).toEqual([]);
});

it("keeps the same protected terms (commands, flags, env names, tool names) in both languages", () => {
	const mismatched = zhEntries
		.map(([key, text]) => ({
			key,
			zh: findProtectedTerms(text),
			en: findProtectedTerms(enDict[key] ?? ""),
		}))
		.filter((entry) => entry.zh.join("\n") !== entry.en.join("\n"));
	expect(mismatched).toEqual([]);
});

it("keeps English free of CJK characters except the native language name", () => {
	const cjk = Object.entries(enDict)
		.filter(([key]) => key !== "language.name.zh")
		.filter(([, text]) => /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u.test(text))
		.map(([key]) => key);
	expect(cjk).toEqual([]);
});
