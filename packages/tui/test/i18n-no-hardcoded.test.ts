import { expect, it } from "bun:test";
import { listSources, scanDirectory, scanLiterals } from "./support/literal-scan.ts";

const ROOT = new URL("../src", import.meta.url).pathname;
const DICTIONARY_DIR = "i18n/";

type Allowed = { file: string; text?: string; reason: string };

/**
 * User-visible wording must come from the dictionaries through `t()`. A literal is allowed here only when it is not
 * interface text of the running TUI; `text` narrows an entry to one literal (prefix match), otherwise it covers the file.
 */
const WHITELIST: readonly Allowed[] = [
	{
		file: "cli-options.ts",
		reason: "Help text and argument errors are printed before the language is known and are chosen by hand (zh / en)",
	},
	{
		file: "language-settings.ts",
		text: "--lang must be",
		reason: "Argument error raised before the language is known",
	},
	{
		file: "gateway.ts",
		reason: "Startup diagnostics for the gateway child process and its files; developer-facing, not part of the UI",
	},
	{ file: "clipboard-write.ts", reason: "Shell and PowerShell scripts sent to clipboard tools" },
	{ file: "image-input.ts", reason: "AppleScript and PowerShell scripts sent to clipboard tools" },
	{ file: "components/welcome.ts", text: "neko harness", reason: "Product name" },
	{ file: "help-ui.ts", text: "Esc Esc", reason: "Key chord label, not translatable" },
];

const allowed = (file: string, text: string) =>
	WHITELIST.some((entry) => entry.file === file && (entry.text === undefined || text.startsWith(entry.text)));

it("keeps Chinese and English interface literals out of the TUI sources outside the i18n directory", () => {
	const findings = scanDirectory(ROOT)
		.filter((item) => !item.file.startsWith(DICTIONARY_DIR))
		.filter((item) => !allowed(item.file, item.text))
		.map((item) => `${item.file}:${item.line} [${item.kind}] ${item.text}`);
	expect(findings).toEqual([]);
});

it("detects CJK and prose-like English literals but not identifiers, keys or comments", () => {
	const source = [
		"// 注释 and a comment line",
		'import { x } from "some module name.ts";',
		'const a = "中文";',
		'const b = "Hello world";',
		"const c = `Press ` + x + ` to continue`;",
		'const d = "job-report";',
		'const e = "core.status.thinking";',
	].join("\n");
	expect(scanLiterals("sample.ts", source).map((item) => [item.line, item.kind])).toEqual([
		[3, "cjk"],
		[4, "english"],
		[5, "english"],
	]);
});

it("scans the real source tree and every whitelist entry has a reason and still matches a file", () => {
	const sources = listSources(ROOT);
	expect(sources.length).toBeGreaterThan(30);
	expect(sources).toContain("i18n/zh.ts");
	for (const entry of WHITELIST) {
		expect(entry.reason.trim().length).toBeGreaterThan(0);
		expect(sources).toContain(entry.file);
	}
});
