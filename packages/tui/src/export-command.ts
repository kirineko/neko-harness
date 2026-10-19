import { type FileHandle, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
	type ExportFormat,
	type ExportOptions,
	type ExportSource,
	exportConversation,
	exportFileName,
	exportFormatFromPath,
} from "@neko-harness/core/conversation-export";
import { expandHome } from "./image-input.ts";

export const EXPORT_USAGE = "Usage: /export [path.md|path.html|path.json] [--thinking]";

export type ExportArgs = { path: string | undefined; includeThinking: boolean };

/** Parses `/export` arguments: one optional path (quotes allow spaces) and the `--thinking` flag. */
export function parseExportArgs(input: string): ExportArgs {
	const words: { text: string; quoted: boolean }[] = [];
	let word = "";
	let quote = "";
	let quoted = false;
	let active = false;
	for (const c of input) {
		if (quote !== "") {
			if (c === quote) quote = "";
			else word += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			quoted = true;
			active = true;
		} else if (/\s/.test(c)) {
			if (active) words.push({ text: word, quoted });
			word = "";
			quoted = false;
			active = false;
		} else {
			word += c;
			active = true;
		}
	}
	if (quote !== "") throw new Error(`Unterminated quote. ${EXPORT_USAGE}`);
	if (active) words.push({ text: word, quoted });

	let includeThinking = false;
	let path: string | undefined;
	for (const { text, quoted: wasQuoted } of words) {
		if (!wasQuoted && text === "--thinking") includeThinking = true;
		else if (!wasQuoted && text.startsWith("--")) throw new Error(`Unknown option ${text}. ${EXPORT_USAGE}`);
		else if (path === undefined && text !== "") path = text;
		else throw new Error(EXPORT_USAGE);
	}
	return { path, includeThinking };
}

export type ExportToFileInput = ExportArgs & {
	/** Workspace directory: relative paths resolve against it and it receives default file names. */
	cwd: string;
	source: ExportSource;
	loadImage: ExportOptions["loadImage"];
	platform?: string;
};

/**
 * Writes the export without overwriting an existing file; a failed export leaves no partial file.
 * The target is created first so a conflicting path fails before any image is downloaded.
 */
export async function exportToFile(input: ExportToFileInput): Promise<{ path: string; skippedImages: number }> {
	const format: ExportFormat | null = input.path === undefined ? "markdown" : exportFormatFromPath(input.path);
	if (format === null) throw new Error("Unsupported export format: use a .md, .html or .json path");
	const target = resolve(
		input.cwd,
		input.path === undefined
			? exportFileName(input.source.title, format, input.source.exportedAt)
			: expandHome(input.path, input.platform),
	);
	let handle: FileHandle;
	try {
		handle = await open(target, "wx");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") throw new Error(`File already exists: ${target}. Choose another path.`);
		if (code === "ENOENT") throw new Error(`Directory does not exist: ${target}`);
		throw error;
	}
	try {
		const result = await exportConversation(format, input.source, {
			includeThinking: input.includeThinking,
			...(input.loadImage ? { loadImage: input.loadImage } : {}),
		});
		await handle.writeFile(result.content, "utf8");
		return { path: target, skippedImages: result.skippedImages };
	} catch (error) {
		await unlink(target).catch(() => {});
		throw error;
	} finally {
		await handle.close().catch(() => {});
	}
}
