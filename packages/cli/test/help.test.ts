import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

/** NEKO_LANG is cleared unless given, and the TUI help always gets an explicit `--lang`, so the saved language never leaks in. */
async function help(entry: string, args: string[], env: Record<string, string> = {}): Promise<string> {
	const { NEKO_LANG: _lang, ...inherited } = process.env;
	const child = Bun.spawn(
		[process.execPath, "--conditions=neko-source", fileURLToPath(new URL(entry, import.meta.url)), ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...inherited, ...env },
		},
	);
	const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	expect(code).toBe(0);
	return out;
}

it("documents the web search provider selection and credential variables in help", async () => {
	const root = await help("../src/main.ts", ["--help"]);
	for (const text of ["TAVILY_API_KEY", "DEEPSEEK_API_KEY", "/search", "webSearch.provider", "Tavily"])
		expect(root).toContain(text);
	for (const text of ["OPENROUTER_API_KEY", "OPENCODE_API_KEY", "/login", "provider/modelId"])
		expect(root).toContain(text);
	const tui = await help("../../tui/src/main.ts", ["--lang", "zh", "--help"]);
	for (const text of ["DEEPSEEK_API_KEY", "/search", "tavily", "/login", "provider/modelId"])
		expect(tui).toContain(text);
	const serve = await help("../../gateway/src/main.ts", ["--help"]);
	for (const text of ["TAVILY_API_KEY", "webSearch.provider", "tavily", "OPENROUTER_API_KEY", "provider/modelId"])
		expect(serve).toContain(text);
	const web = await help("../../web/src/main.ts", ["--help"]);
	for (const text of ["OPENROUTER_API_KEY", "模型服务", "联网搜索", "provider/modelId"]) expect(web).toContain(text);
});

it("documents the default-model entry points and their precedence in help", async () => {
	for (const entry of [
		"../src/main.ts",
		"../../tui/src/main.ts",
		"../../web/src/main.ts",
		"../../gateway/src/main.ts",
	]) {
		const output = await help(entry, entry.includes("/tui/") ? ["--lang", "zh", "--help"] : ["--help"]);
		for (const text of ["/model", "设为默认", "--model", "defaultModel"]) expect(output).toContain(text);
	}
});

it("forwards the TUI language to `neko tui --help` and leaves the other commands in Chinese", async () => {
	const zh = await help("../src/main.ts", ["tui", "--lang", "zh", "--help"]);
	expect(zh).toContain("用法: neko tui [选项]");
	expect(zh).toContain("NEKO_LANG");
	const flagged = await help("../src/main.ts", ["tui", "--lang", "en", "--help"]);
	expect(flagged).toContain("Usage: neko tui [options]");
	expect(flagged).toContain("--lang <zh|en>");
	expect(flagged).toContain("NEKO_LANG");
	const fromEnv = await help("../src/main.ts", ["tui", "--help"], { NEKO_LANG: "en" });
	expect(fromEnv).toContain("Usage: neko tui [options]");

	for (const [entry, args] of [
		["../src/main.ts", ["--help"]],
		["../src/main.ts", ["web", "--help"]],
		["../src/main.ts", ["serve", "--help"]],
		["../src/main.ts", ["update", "--help"]],
	] as const) {
		const output = await help(entry, [...args], { NEKO_LANG: "en" });
		expect(output).toMatch(/[\u4e00-\u9fff]/);
		expect(output).not.toContain("Usage: neko tui");
	}
	expect(await help("../src/main.ts", ["web", "--help"], { NEKO_LANG: "en" })).toContain("模型服务");
});
