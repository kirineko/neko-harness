import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatItem } from "@neko-harness/core";
import { rm } from "../../../test/temp-dir.ts";
import { copyLastAnswer } from "../src/clipboard-write.ts";
import { exportToFile, parseExportArgs } from "../src/export-command.ts";
import { helpLines } from "../src/help-ui.ts";
import { commands } from "../src/labels.ts";

const items = [
	{ type: "user", key: "e1", id: 1, text: "question" },
	{
		type: "assistant",
		key: "e2",
		id: 2,
		thinking: "secret reasoning",
		text: "final answer",
		stopReason: "stop",
		errorMessage: null,
		note: null,
	},
] as ChatItem[];
const source = (list: ChatItem[]) => ({
	sessionId: "7",
	title: "Chat: a/b",
	model: "deepseek/chat",
	cwd: "/work",
	exportedAt: new Date(2026, 9, 14, 8, 0, 0),
	items: list,
});
async function inTempDir(run: (dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "neko-export-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

it("lists /copy and /export in completion and help", () => {
	expect(commands().map((c) => c.name)).toEqual(expect.arrayContaining(["copy", "export"]));
	const help = helpLines().join("\n");
	expect(help).toContain("/copy");
	expect(help).toContain("/export");
});

it("parses /export paths, quotes and the thinking flag", () => {
	expect(parseExportArgs("")).toEqual({ path: undefined, includeThinking: false });
	expect(parseExportArgs("  out.md --thinking ")).toEqual({ path: "out.md", includeThinking: true });
	expect(parseExportArgs('"my chats/a.json"')).toEqual({ path: "my chats/a.json", includeThinking: false });
	expect(parseExportArgs(`--thinking 'a b.html'`)).toEqual({ path: "a b.html", includeThinking: true });
	// A quoted --thinking is a path, not the flag.
	expect(parseExportArgs('"--thinking"')).toEqual({ path: "--thinking", includeThinking: false });
	expect(() => parseExportArgs("--bogus")).toThrow("Unknown option --bogus");
	expect(() => parseExportArgs("a.md b.md")).toThrow("Usage");
	expect(() => parseExportArgs('"unfinished.md')).toThrow("Unterminated quote");
});

it("copies the last answer without thinking and reports how it was written", async () => {
	const written: string[] = [];
	const sequences: string[] = [];
	const ok = await copyLastAnswer(items, {
		platform: "darwin",
		env: {},
		native: { setText: async (text) => void written.push(text) },
		osc52: (s) => void sequences.push(s),
	});
	expect(written).toEqual(["final answer"]);
	expect(ok).toEqual({ level: "info", message: "Copied last response (12 chars)" });

	const viaTerminal = await copyLastAnswer(items, {
		platform: "linux",
		env: {},
		native: undefined,
		run: async () => false,
		osc52: (s) => void sequences.push(s),
	});
	expect(viaTerminal.level).toBe("info");
	expect(viaTerminal.message).toContain("OSC 52");
	expect(sequences).toHaveLength(1);

	const untouched: string[] = [];
	const empty = await copyLastAnswer([items[0]!], {
		platform: "darwin",
		env: {},
		native: { setText: async (text) => void untouched.push(text) },
		osc52: () => {},
	});
	expect(empty.level).toBe("warning");
	expect(untouched).toEqual([]);

	// Oversized text cannot use OSC 52, so with no working tool the copy fails with guidance.
	const huge = { ...(items[1] as ChatItem & { type: "assistant" }), text: "x".repeat(200_000) };
	const failed = await copyLastAnswer([huge], {
		platform: "linux",
		env: {},
		native: undefined,
		run: async () => false,
		osc52: () => {},
	});
	expect(failed.level).toBe("error");
	expect(failed.message).toContain("/export");
});

it("writes the default Markdown file into the workspace directory", () =>
	inTempDir(async (dir) => {
		const result = await exportToFile({
			path: undefined,
			includeThinking: false,
			cwd: dir,
			source: source(items),
			loadImage: undefined,
		});
		expect(result.path).toBe(join(dir, "Chat- a-b-20261014-080000.md"));
		const text = await readFile(result.path, "utf8");
		expect(text).toContain("final answer");
		expect(text).not.toContain("secret reasoning");
	}));

it("picks the format from the extension and honours --thinking, quoted paths and relative directories", () =>
	inTempDir(async (dir) => {
		await mkdir(join(dir, "my chats"));
		const html = await exportToFile({
			path: "my chats/a.html",
			includeThinking: true,
			cwd: dir,
			source: source(items),
			loadImage: undefined,
		});
		expect(html.path).toBe(join(dir, "my chats", "a.html"));
		const htmlText = await readFile(html.path, "utf8");
		expect(htmlText).toContain("<!doctype html>");
		expect(htmlText).toContain("secret reasoning");

		const json = await exportToFile({
			path: "b.JSON",
			includeThinking: false,
			cwd: dir,
			source: source(items),
			loadImage: undefined,
		});
		expect(JSON.parse(await readFile(json.path, "utf8")).items).toHaveLength(2);
	}));

it("refuses to overwrite and reports unsupported extensions, missing directories and empty sessions without leaving files", () =>
	inTempDir(async (dir) => {
		const existing = join(dir, "keep.md");
		await writeFile(existing, "original");
		await expect(
			exportToFile({ path: "keep.md", includeThinking: false, cwd: dir, source: source(items), loadImage: undefined }),
		).rejects.toThrow("already exists");
		expect(await readFile(existing, "utf8")).toBe("original");

		await expect(
			exportToFile({ path: "chat.txt", includeThinking: false, cwd: dir, source: source(items), loadImage: undefined }),
		).rejects.toThrow(".md, .html or .json");
		await expect(
			exportToFile({
				path: "missing/dir/x.md",
				includeThinking: false,
				cwd: dir,
				source: source(items),
				loadImage: undefined,
			}),
		).rejects.toThrow("Directory does not exist");
		await expect(
			exportToFile({ path: "empty.md", includeThinking: false, cwd: dir, source: source([]), loadImage: undefined }),
		).rejects.toThrow("Nothing to export");
		expect(await readdir(dir)).toEqual(["keep.md"]);
	}));

it("keeps exporting HTML when an image cannot be read and reports how many were skipped", () =>
	inTempDir(async (dir) => {
		const withImage = [
			{
				type: "user",
				key: "e1",
				id: 1,
				text: "look",
				images: [{ entryId: 1, contentIndex: 0, name: "a.png", mimeType: "image/png", width: 1, height: 1, bytes: 4 }],
			},
		] as ChatItem[];
		const result = await exportToFile({
			path: "pics.html",
			includeThinking: false,
			cwd: dir,
			source: source(withImage),
			loadImage: async () => {
				throw new Error("gone");
			},
		});
		expect(result.skippedImages).toBe(1);
		expect(await readFile(result.path, "utf8")).toContain("image unavailable");
	}));

it("expands ~\\ on win32 and ~/ on POSIX in the export path", () =>
	inTempDir(async (dir) => {
		const { homedir } = await import("node:os");
		const missing = (path: string, platform: string) =>
			exportToFile({ path, includeThinking: false, cwd: dir, source: source(items), loadImage: undefined, platform });
		const target = join(homedir(), "neko-missing-dir", "sub", "a.md");
		await expect(missing("~\\neko-missing-dir/sub/a.md", "win32")).rejects.toThrow(
			`Directory does not exist: ${target}`,
		);
		await expect(missing("~/neko-missing-dir/sub/a.md", "linux")).rejects.toThrow(
			`Directory does not exist: ${target}`,
		);
		await expect(missing("~\\neko-missing-dir/sub/a.md", "linux")).rejects.toThrow("Directory does not exist");
	}));
