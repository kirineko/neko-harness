import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";

export const SEARCH_LIMITS = {
	entries: 10_000,
	fileBytes: 2 * 1024 * 1024,
	scanBytes: 32 * 1024 * 1024,
	outputBytes: 32 * 1024,
	timeoutMs: 10_000,
};
const path = Type.Optional(
	Type.String({ description: "Directory relative to this conversation's cwd, or absolute path." }),
);
const limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum results (default 100)." }));
const text = (value: string) => ({ type: "text" as const, text: value });

async function search<T>(
	api: ToolExecutionApi,
	context: Context,
	run: (env: ExecutionEnv, ctx: Context) => Promise<T>,
) {
	if (!api.env) throw new Error("File environment unavailable");
	const timer = new AbortController();
	const timeout = setTimeout(
		() => timer.abort(new Error("File search timed out; narrow the directory.")),
		SEARCH_LIMITS.timeoutMs,
	);
	const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, timer.signal]) : timer.signal;
	try {
		signal.throwIfAborted();
		return await run(api.env, withAbortSignal(signal, context));
	} finally {
		clearTimeout(timeout);
	}
}
async function listing(env: ExecutionEnv, path: string, ctx: Context) {
	if (!env.listFiles) throw new Error("File discovery unavailable. Retry.");
	const base = getOrThrow(await env.absolutePath(path, ctx));
	const files = getOrThrow(
		await env.listFiles(
			base,
			{
				hidden: true,
				gitignore: true,
				maxEntries: SEARCH_LIMITS.entries,
				maxBytes: 1024 * 1024,
				timeoutMs: SEARCH_LIMITS.timeoutMs,
			},
			ctx,
		),
	);
	return { base, ...files };
}
function output(lines: string[], complete: boolean, skipped = 0) {
	const status = complete
		? "Search complete within Pi listing; unreadable entries may be omitted."
		: "Partial results; narrow the directory or filter and retry.";
	return {
		output: [text(`${lines.join("\n")}\n${status}${skipped ? ` Skipped/unreadable files: ${skipped}.` : ""}`)],
		details: { complete, skipped },
	};
}

export const FindFiles = defineTool({
	name: "find_files",
	description:
		"Discover files and directories without a shell. query is a literal path/name substring (not a glob). Respects gitignore; returns absolute paths usable by read. A partial result is not a complete absence of matches.",
	parameters: Type.Object({ path, query: Type.Optional(Type.String()), limit }),
	replay: "safe",
	execute: (args, api, context) =>
		search(api, context, async (env, ctx) => {
			const files = await listing(env, args.path ?? ".", ctx);
			const lines: string[] = [];
			let bytes = 0;
			let complete = !files.truncated;
			for (const file of files.entries) {
				ctx.abortSignal?.throwIfAborted();
				if (args.query && !file.path.includes(args.query)) continue;
				const absolute = getOrThrow(await env.joinPath([files.base, file.path], ctx)).replace(/\\/g, "/");
				const line = `${file.kind}\t${absolute}`;
				bytes += Buffer.byteLength(line) + 1;
				if (lines.length >= (args.limit ?? 100) || bytes > SEARCH_LIMITS.outputBytes - 256) {
					complete = false;
					break;
				}
				lines.push(line);
			}
			return output(lines, complete);
		}),
});

export const SearchText = defineTool({
	name: "search_text",
	description:
		"Search UTF-8 file contents without a shell. pattern and filePattern are literal substrings, not regex/globs. Returns absolute paths, 1-based line numbers and context for read. Binary/large/unreadable files and exhausted budgets are explicitly reported as partial results.",
	parameters: Type.Object({
		pattern: Type.String({ minLength: 1, maxLength: 4096 }),
		path,
		filePattern: Type.Optional(Type.String()),
		caseSensitive: Type.Optional(Type.Boolean()),
		contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
		limit,
	}),
	replay: "safe",
	execute: (args, api, context) =>
		search(api, context, async (env, ctx) => {
			const files = await listing(env, args.path ?? ".", ctx);
			const results: string[] = [];
			let complete = !files.truncated;
			let skipped = 0;
			let scanned = 0;
			let bytes = 0;
			const needle = args.caseSensitive === false ? args.pattern.toLowerCase() : args.pattern;
			outer: for (const file of files.entries) {
				ctx.abortSignal?.throwIfAborted();
				if (file.kind !== "file" || (args.filePattern && !file.path.includes(args.filePattern))) continue;
				const absolute = getOrThrow(await env.joinPath([files.base, file.path], ctx));
				const opened = await env.openBinaryReader(absolute, { noFollow: true }, ctx);
				if (!opened.ok) {
					ctx.abortSignal?.throwIfAborted();
					skipped++;
					complete = false;
					continue;
				}
				try {
					const info = getOrThrow(await opened.value.info(ctx));
					if (info.size > SEARCH_LIMITS.fileBytes) {
						skipped++;
						complete = false;
						continue;
					}
					if (scanned + info.size > SEARCH_LIMITS.scanBytes) {
						complete = false;
						break;
					}
					const data = getOrThrow(await opened.value.read(0, info.size + 1, ctx));
					scanned += data.length;
					if (data.length !== info.size || data.includes(0)) {
						skipped++;
						complete = false;
						continue;
					}
					const lines = new TextDecoder("utf-8", { fatal: true })
						.decode(data)
						.replace(/^\uFEFF/, "")
						.split(/\r?\n/);
					for (let i = 0; i < lines.length; i++) {
						ctx.abortSignal?.throwIfAborted();
						const value = lines[i]!;
						if (!(args.caseSensitive === false ? value.toLowerCase() : value).includes(needle)) continue;
						const n = args.contextLines ?? 0;
						const block = lines
							.slice(Math.max(0, i - n), i + n + 1)
							.map((line, offset) => `${absolute.replace(/\\/g, "/")}:${Math.max(0, i - n) + offset + 1}:${line}`)
							.join("\n");
						bytes += Buffer.byteLength(block) + 1;
						if (results.length >= (args.limit ?? 100) || bytes > SEARCH_LIMITS.outputBytes - 256) {
							complete = false;
							break outer;
						}
						results.push(block);
					}
				} catch (error) {
					ctx.abortSignal?.throwIfAborted();
					if (!(error instanceof Error)) throw error;
					skipped++;
					complete = false;
				} finally {
					await opened.value.close(BACKGROUND_CONTEXT);
				}
			}
			return output(results, complete, skipped);
		}),
});
export const AgentFileSearch = defineExtension({ name: "neko-file-search", tools: [FindFiles, SearchText] });
