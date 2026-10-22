import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { listSources, scanDirectory } from "./support/cjk-scan.ts";

const ROOT = fileURLToPath(new URL("../src/client", import.meta.url));

/**
 * Chinese text may only live in the dictionaries (and the server-text mapping next to them). Every other literal,
 * template or JSX text containing CJK is a hard-coded string that would ignore the language setting.
 * Entries need a written reason; the list is expected to stay empty.
 */
const WHITELIST: readonly { file: string; text: string; reason: string }[] = [];

const DICTIONARY_DIR = "lib/i18n/";

it("keeps Chinese literals out of the client sources outside the i18n directory", () => {
	const findings = scanDirectory(ROOT)
		.filter((item) => !item.file.startsWith(DICTIONARY_DIR))
		.filter((item) => !WHITELIST.some((entry) => entry.file === item.file && item.text.includes(entry.text)))
		.map((item) => `${item.file}:${item.line} [${item.kind}] ${item.text}`);
	expect(findings).toEqual([]);
});

it("scans the real source tree and every whitelist entry has a reason", () => {
	expect(listSources(ROOT).length).toBeGreaterThan(50);
	expect(listSources(ROOT)).toContain("lib/i18n/zh.ts");
	for (const entry of WHITELIST) expect(entry.reason.trim().length).toBeGreaterThan(0);
});
