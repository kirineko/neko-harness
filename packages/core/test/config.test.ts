// 2.4 配置层：查找（向上递归 + ~/.neko 兜底）、$ENV/${ENV} 插值、校验、
// 优先级合并（CLI > 配置文件 > 默认值）。

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "../../../test/temp-dir.ts";
import {
	DEFAULT_NEKO_CONFIG,
	findNekoConfigFile,
	loadNekoConfig,
	mergeNekoConfig,
	parseNekoConfig,
} from "../src/index.ts";

let directories: string[] = [];

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories = [];
});

async function makeDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "neko-config-"));
	directories.push(directory);
	return directory;
}

describe("neko.config.json (2.4)", () => {
	it("walks up from startDir to find neko.config.json", async () => {
		const root = await makeDir();
		await mkdir(join(root, "a", "b"), { recursive: true });
		await writeFile(join(root, "neko.config.json"), JSON.stringify({ theme: "dark" }));
		expect(findNekoConfigFile(join(root, "a", "b"))).toBe(join(root, "neko.config.json"));
		const config = loadNekoConfig(join(root, "a", "b"));
		expect(config.theme).toBe("dark");
	});

	it("falls back to ~/.neko/neko.config.json and returns {} when nothing is found", async () => {
		const root = await makeDir();
		// Bun isolates process.env per test file; os.homedir reads the process-level HOME.
		// A fresh process verifies the real startup environment without changing the parent.
		const readConfig = () => {
			const child = Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`
				import { findNekoConfigFile, loadNekoConfig } from ${JSON.stringify(fileURLToPath(new URL("../src/config.ts", import.meta.url)))};
				console.log(JSON.stringify({ file: findNekoConfigFile(${JSON.stringify(join(root, "nowhere"))}), config: loadNekoConfig(${JSON.stringify(join(root, "nowhere"))}) }));
			`,
				],
				// Windows 上 os.homedir 读 USERPROFILE 而非 HOME，两个都指到临时目录。
				{ env: { ...process.env, HOME: root, USERPROFILE: root } },
			);
			expect(child.exitCode).toBe(0);
			return JSON.parse(child.stdout.toString());
		};
		expect(readConfig()).toEqual({ config: {} });
		await mkdir(join(root, ".neko"), { recursive: true });
		await writeFile(join(root, ".neko", "neko.config.json"), JSON.stringify({ storagePath: "/tmp/x.sqlite" }));
		expect(readConfig()).toEqual({
			file: join(root, ".neko", "neko.config.json"),
			config: { storagePath: "/tmp/x.sqlite" },
		});
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: naming the interpolation syntax under test
	it("interpolates $ENV and ${ENV} references", () => {
		const config = parseNekoConfig(
			JSON.stringify({
				apiKey: "$MY_KEY",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: testing ${ENV} interpolation syntax
				storagePath: "${MY_DIR}/neko.sqlite",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: testing ${ENV} interpolation syntax
				nested: { modelId: "${MY_MODEL}" },
			}),
			"test.json",
			{ MY_KEY: "secret", MY_DIR: "/data", MY_MODEL: "deepseek-flash" },
		);
		expect<unknown>(config).toEqual({
			apiKey: "secret",
			storagePath: "/data/neko.sqlite",
			nested: { modelId: "deepseek-flash" },
		});
	});

	it("throws when a referenced environment variable is unset", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: testing ${ENV} interpolation syntax
		expect(() => parseNekoConfig('{"storagePath": "${NOPE}/x"}', "test.json", {})).toThrow(/NOPE/);
	});

	it("throws a clear error on bad JSON, naming the file", async () => {
		const root = await makeDir();
		await writeFile(join(root, "neko.config.json"), "{ oops");
		expect(() => loadNekoConfig(root)).toThrow(new RegExp(`${root.replace(/[/\\]/g, ".")}.*not valid JSON`));
	});

	it("rejects values of the wrong shape", () => {
		expect(() => parseNekoConfig('{"theme": "rainbow"}', "test.json", {})).toThrow(/theme/);
		expect(() => parseNekoConfig('{"defaultModel": {"provider": "x"}}', "test.json", {})).toThrow(/defaultModel/);
		expect(() => parseNekoConfig('{"gateway": {"port": "no"}}', "test.json", {})).toThrow(/gateway\.port/);
		expect(() => parseNekoConfig('{"gateway": {"socketPath": 1}}', "test.json", {})).toThrow(/gateway\.socketPath/);
	});

	it("accepts gateway.socketPath null as disabling the Unix transport", () => {
		const file = parseNekoConfig('{"gateway": {"socketPath": null}}', "test.json", {});
		expect(file.gateway?.socketPath).toBeNull();
		// null 是显式取值：合并时不被 base 覆盖。
		const merged = mergeNekoConfig({ gateway: { socketPath: "/base.sock" } }, file);
		expect(merged.gateway?.socketPath).toBeNull();
	});

	it("merges with CLI > config file > default priority", () => {
		const file = parseNekoConfig(
			JSON.stringify({
				defaultModel: { provider: "deepseek", modelId: "deepseek-v4-pro" },
				storagePath: "/file/x.sqlite",
				theme: "dark",
				gateway: { host: "127.0.0.1", port: 9000 },
			}),
			"test.json",
			{},
		);
		const cli = {
			storagePath: "/cli/y.sqlite",
			gateway: { port: 8321 },
		};
		const merged = mergeNekoConfig(mergeNekoConfig(DEFAULT_NEKO_CONFIG, file), cli);
		// CLI wins where given; the file fills the rest; defaults only where neither has a value.
		expect(merged.defaultModel).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
		expect(merged.storagePath).toBe("/cli/y.sqlite");
		expect(merged.theme).toBe("dark");
		// gateway merges field by field: port from CLI, host from the file.
		expect(merged.gateway).toEqual({ host: "127.0.0.1", port: 8321 });
		// Defaults show through when nothing overrides them.
		expect(mergeNekoConfig(DEFAULT_NEKO_CONFIG, {}).defaultModel).toEqual(DEFAULT_NEKO_CONFIG.defaultModel);
		expect(mergeNekoConfig(DEFAULT_NEKO_CONFIG, {}).theme).toBe("auto");
	});
});

it("parses, validates, and merges skills.marketUrl", () => {
	const parsed = parseNekoConfig('{"skills": {"marketUrl": "https://market.example.com"}}', "test.json", {});
	expect(parsed.skills?.marketUrl).toBe("https://market.example.com");
	expect(() => parseNekoConfig('{"skills": {"marketUrl": 42}}', "test.json", {})).toThrow(/marketUrl/);
	expect(() => parseNekoConfig('{"skills": "nope"}', "test.json", {})).toThrow(/skills/);
	const merged = mergeNekoConfig({ skills: { marketUrl: "https://a.example.com" } }, { skills: {} });
	expect(merged.skills?.marketUrl).toBe("https://a.example.com");
	expect(mergeNekoConfig({}, {}).skills).toBeUndefined();
});

it("parses, validates, and merges webSearch.provider", () => {
	for (const provider of ["deepseek", "tavily"] as const) {
		expect(parseNekoConfig(`{"webSearch": {"provider": "${provider}"}}`, "test.json", {}).webSearch?.provider).toBe(
			provider,
		);
	}
	for (const invalid of ["auto", "bing"])
		expect(() => parseNekoConfig(`{"webSearch": {"provider": "${invalid}"}}`, "test.json", {})).toThrow(
			/webSearch\.provider/,
		);
	expect(() => parseNekoConfig('{"webSearch": "tavily"}', "test.json", {})).toThrow(/webSearch/);
	expect(mergeNekoConfig({ webSearch: { provider: "tavily" } }, { webSearch: {} }).webSearch?.provider).toBe("tavily");
	expect(
		mergeNekoConfig({ webSearch: { provider: "tavily" } }, { webSearch: { provider: "deepseek" } }).webSearch?.provider,
	).toBe("deepseek");
	expect(mergeNekoConfig({}, {}).webSearch).toBeUndefined();
});

it("parses, validates, and merges shell.path", () => {
	const parsed = parseNekoConfig('{"shell": {"path": "D:\\\\tools\\\\Git\\\\bin\\\\bash.exe"}}', "test.json", {});
	expect(parsed.shell?.path).toBe("D:\\tools\\Git\\bin\\bash.exe");
	expect(() => parseNekoConfig('{"shell": {"path": 42}}', "test.json", {})).toThrow(/"shell\.path" must be a string/);
	expect(() => parseNekoConfig('{"shell": "bash"}', "test.json", {})).toThrow(/"shell" must be an object/);
	expect(mergeNekoConfig({ shell: { path: "a" } }, { shell: {} }).shell?.path).toBe("a");
	expect(mergeNekoConfig({ shell: { path: "a" } }, { shell: { path: "b" } }).shell?.path).toBe("b");
	expect(mergeNekoConfig({}, {}).shell).toBeUndefined();
});

it("parses, validates, and merges context settings", () => {
	const parsed = parseNekoConfig(
		'{"context": {"compaction": {"triggerPercent": 50, "keepRecentTokens": 40000, "enabled": false}, "pruning": {"enabled": true, "keepRecent": 0}}}',
		"test.json",
		{},
	);
	expect(parsed.context?.compaction).toEqual({ triggerPercent: 50, keepRecentTokens: 40000, enabled: false });
	expect(parsed.context?.pruning).toEqual({ enabled: true, keepRecent: 0 });
	for (const bad of [
		'{"context": 5}',
		'{"context": {"other": {}}}',
		'{"context": {"compaction": {"triggerPercent": 100}}}',
		'{"context": {"compaction": {"triggerPercent": 0}}}',
		'{"context": {"compaction": {"triggerPercent": 12.5}}}',
		'{"context": {"compaction": {"keepRecentTokens": 0}}}',
		'{"context": {"compaction": {"enabled": "yes"}}}',
		'{"context": {"compaction": {"nope": 1}}}',
		'{"context": {"pruning": {"minChars": -1}}}',
		'{"context": {"pruning": {"minSavePercent": 0}}}',
		'{"context": {"pruning": {"enabled": null}}}',
	])
		expect(() => parseNekoConfig(bad, "test.json", {})).toThrow(/test\.json.*context/);
	const merged = mergeNekoConfig(
		{ context: { compaction: { triggerPercent: 50 }, pruning: { enabled: true } } },
		{ context: { compaction: { enabled: false }, pruning: { enabled: false } } },
	);
	expect(merged.context).toEqual({
		compaction: { triggerPercent: 50, enabled: false },
		pruning: { enabled: false },
	});
	expect(mergeNekoConfig({}, {}).context).toBeUndefined();
});

it("parses, validates, and merges codemode settings", () => {
	expect(parseNekoConfig('{"codemode": {"mode": "only"}}', "test.json", {}).codemode).toEqual({ mode: "only" });
	expect(parseNekoConfig('{"codemode": {}}', "test.json", {}).codemode).toEqual({});
	for (const bad of [
		'{"codemode": 5}',
		'{"codemode": {"mode": "auto"}}',
		'{"codemode": {"mode": null}}',
		'{"codemode": {"x": 1}}',
	])
		expect(() => parseNekoConfig(bad, "test.json", {})).toThrow(/test\.json.*codemode/);
	expect(() => parseNekoConfig('{"codemode": {"mode": "auto"}}', "test.json", {})).toThrow(/off, on, only/);
	expect(mergeNekoConfig({ codemode: { mode: "on" } }, { codemode: { mode: "only" } }).codemode).toEqual({
		mode: "only",
	});
	expect(mergeNekoConfig({ codemode: { mode: "on" } }, {}).codemode).toEqual({ mode: "on" });
	expect(mergeNekoConfig({}, {}).codemode).toBeUndefined();
});
