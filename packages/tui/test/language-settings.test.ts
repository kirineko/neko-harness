import "./support/lang-en.ts";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { parseArgs } from "../src/cli-options.ts";
import {
	parseLanguageEnv,
	parseLanguageFlag,
	readSavedLanguage,
	resolveLanguage,
	saveLanguage,
	tuiSettingsPath,
} from "../src/language-settings.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "neko-lang-"));
});
afterEach(() => removeDirSync(dir));

it("resolves --lang > NEKO_LANG > saved value > zh and skips invalid values", () => {
	expect(resolveLanguage({})).toBe("zh");
	expect(resolveLanguage({ saved: "en" })).toBe("en");
	expect(resolveLanguage({ env: "zh", saved: "en" })).toBe("zh");
	expect(resolveLanguage({ flag: "en", env: "zh", saved: "zh" })).toBe("en");
	expect(resolveLanguage({ flag: "zh", env: "en", saved: "en" })).toBe("zh");
	expect(resolveLanguage({ env: "fr", saved: "en" })).toBe("en");
	expect(resolveLanguage({ flag: "", env: "", saved: "" })).toBe("zh");
});

it("rejects an invalid --lang with the valid values and ignores an invalid NEKO_LANG", () => {
	expect(parseLanguageFlag("en")).toBe("en");
	expect(parseLanguageFlag("zh")).toBe("zh");
	expect(() => parseLanguageFlag("fr")).toThrow("--lang must be zh or en; received: fr");
	expect(parseLanguageEnv("en")).toBe("en");
	expect(parseLanguageEnv("EN")).toBeUndefined();
	expect(parseLanguageEnv("")).toBeUndefined();
	expect(parseLanguageEnv(undefined)).toBeUndefined();
});

it("falls back to undefined for a missing, corrupted or invalid tui.json", () => {
	expect(readSavedLanguage(dir)).toBeUndefined();
	const path = tuiSettingsPath(dir);
	for (const content of ["", "{", "[]", "null", '"en"', '{"language":"fr"}', '{"language":1}', "{}"]) {
		writeFileSync(path, content);
		expect(readSavedLanguage(dir)).toBeUndefined();
	}
	writeFileSync(path, '{"language":"en"}');
	expect(readSavedLanguage(dir)).toBe("en");
	expect(readSavedLanguage(join(dir, "missing", "deeper"))).toBeUndefined();
});

it("saves the language atomically, creates the directory and keeps unknown fields", () => {
	const nested = join(dir, "nested");
	expect(saveLanguage(nested, "en")).toEqual({ ok: true });
	expect(readSavedLanguage(nested)).toBe("en");
	writeFileSync(tuiSettingsPath(nested), JSON.stringify({ future: { a: 1 }, language: "en", list: [1, 2] }));
	expect(saveLanguage(nested, "zh")).toEqual({ ok: true });
	expect(JSON.parse(readFileSync(tuiSettingsPath(nested), "utf8"))).toEqual({
		future: { a: 1 },
		language: "zh",
		list: [1, 2],
	});
	expect(readdirSync(nested)).toEqual(["tui.json"]);
});

it("replaces a corrupted file instead of failing", () => {
	writeFileSync(tuiSettingsPath(dir), "{not json");
	expect(saveLanguage(dir, "en")).toEqual({ ok: true });
	expect(JSON.parse(readFileSync(tuiSettingsPath(dir), "utf8"))).toEqual({ language: "en" });
});

it("returns the error and leaves no temp file when the data directory cannot be written", () => {
	const blocker = join(dir, "file");
	writeFileSync(blocker, "x");
	const result = saveLanguage(join(blocker, "inside"), "en");
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error).toBeInstanceOf(Error);
	expect(readdirSync(dir)).toEqual(["file"]);

	const target = join(dir, "dir-as-file");
	mkdirSync(join(target, "tui.json"), { recursive: true });
	const second = saveLanguage(target, "en");
	expect(second.ok).toBe(false);
	expect(readdirSync(target)).toEqual(["tui.json"]);
});

it("only /language writes: --lang and NEKO_LANG never touch tui.json", () => {
	const storage = join(dir, "neko.sqlite");
	const flagged = parseArgs(["--storage", storage, "--lang", "en"], {});
	expect(flagged.language).toBe("en");
	const fromEnv = parseArgs(["--storage", storage], { NEKO_LANG: "en" });
	expect(fromEnv.language).toBe("en");
	expect(existsSync(tuiSettingsPath(dir))).toBe(false);

	saveLanguage(dir, "en");
	expect(parseArgs(["--storage", storage], {}).language).toBe("en");
	expect(parseArgs(["--storage", storage, "--lang", "zh"], { NEKO_LANG: "en" }).language).toBe("zh");
	expect(parseArgs(["--storage", storage], { NEKO_LANG: "zh" }).language).toBe("zh");
	expect(readSavedLanguage(dir)).toBe("en");
});

it("starts in zh when the saved file is corrupted and fails on an invalid --lang", () => {
	const storage = join(dir, "neko.sqlite");
	writeFileSync(tuiSettingsPath(dir), "{broken");
	expect(parseArgs(["--storage", storage], {}).language).toBe("zh");
	expect(() => parseArgs(["--lang", "fr"], {})).toThrow("zh or en");
	expect(() => parseArgs(["--lang"], {})).toThrow("--lang requires a value");
	expect(parseArgs(["--storage", storage], { NEKO_LANG: "fr" }).language).toBe("zh");
});
