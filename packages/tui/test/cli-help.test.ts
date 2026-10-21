import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, usage } from "../src/cli-options.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let dir = "";
let storage = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "neko-tui-help-"));
	storage = join(dir, "neko.sqlite");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the TUI entry with a private data directory so the user's saved language cannot leak in. */
async function run(args: string[], env: Record<string, string> = {}) {
	const { NEKO_LANG: _lang, ...inherited } = process.env;
	const child = Bun.spawn([process.execPath, "--conditions=neko-source", MAIN, "--storage", storage, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...inherited, ...env },
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { out, err, code };
}

it("documents --lang and NEKO_LANG in both help texts", () => {
	const zh = usage("zh");
	expect(zh).toContain("用法: neko tui [选项]");
	for (const text of ["--lang <zh|en>", "NEKO_LANG", "/language", "/login", "DEEPSEEK_API_KEY", "provider/modelId"])
		expect(zh).toContain(text);
	const en = usage("en");
	expect(en).toContain("Usage: neko tui [options]");
	expect(en).toContain("Options:");
	expect(en).toContain("-h, --help           Show this help");
	for (const text of ["--lang <zh|en>", "NEKO_LANG", "/language", "/login", "DEEPSEEK_API_KEY", "provider/modelId"])
		expect(en).toContain(text);
	expect(en).not.toMatch(/[\u4e00-\u9fff]/);
});

it("records --help without choosing the output, so --lang works before or after it", () => {
	expect(parseArgs(["--help", "--lang", "en"], {})).toMatchObject({ help: true, language: "en" });
	expect(parseArgs(["--lang", "en", "-h"], {})).toMatchObject({ help: true, language: "en" });
	expect(parseArgs(["--help"], { NEKO_LANG: "en" }).language).toBe("en");
	expect(parseArgs(["--help"], {}).language).toBe("zh");
	expect(parseArgs(["--storage", storage], {}).help).toBe(false);
});

it("prints Chinese help by default and by --lang zh", async () => {
	for (const args of [["--help"], ["-h"], ["--lang", "zh", "--help"]]) {
		const { out, code } = await run(args);
		expect(code).toBe(0);
		expect(out).toContain("用法: neko tui [选项]");
		expect(out).toContain("--lang");
		expect(out).toContain("NEKO_LANG");
	}
});

it("prints English help for --lang en, NEKO_LANG=en and a saved en, with --lang taking precedence", async () => {
	for (const [args, env] of [
		[["--lang", "en", "--help"], {}],
		[["--help", "--lang", "en"], {}],
		[["--help"], { NEKO_LANG: "en" }],
	] as const) {
		const { out, code } = await run([...args], { ...env });
		expect(code).toBe(0);
		expect(out).toContain("Usage: neko tui [options]");
		expect(out).toContain("Options:");
		expect(out).toContain("-h, --help           Show this help");
	}
	const flagWins = await run(["--lang", "zh", "--help"], { NEKO_LANG: "en" });
	expect(flagWins.out).toContain("用法: neko tui [选项]");

	writeFileSync(join(dir, "tui.json"), JSON.stringify({ language: "en" }));
	const saved = await run(["--help"]);
	expect(saved.out).toContain("Usage: neko tui [options]");
	const overridden = await run(["--help", "--lang", "zh"]);
	expect(overridden.out).toContain("用法: neko tui [选项]");
	rmSync(join(dir, "tui.json"));
});

it("rejects an unsupported --lang value before starting", async () => {
	const { out, err, code } = await run(["--lang", "fr"]);
	expect(code).toBe(1);
	expect(out).toBe("");
	expect(err).toContain("--lang must be zh or en");
	expect(err).toContain("fr");
	const missing = await run(["--lang"]);
	expect(missing.code).toBe(1);
	expect(missing.err).toContain("--lang requires a value");
});
