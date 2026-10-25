/**
 * Conversation copy and export rules shared by the web and terminal frontends.
 * Browser-safe: pure functions over `ChatItem[]`, no Node built-ins.
 */
import { exportHtml } from "./conversation-export-html.ts";
import {
	codemodeCallLine,
	codemodeOmittedLine,
	type ExportOptions,
	type ExportSource,
	FALLBACK_EXPORT_TITLE,
	formatDuration,
	imageLabel,
	oneLine,
	type ToolItem,
	toolOutput,
	toolStatus,
	userText,
} from "./conversation-items.ts";
import type { ChatItem } from "./projection.ts";

export { MAX_EMBEDDED_IMAGE_BYTES } from "./conversation-export-html.ts";
export type { ExportOptions, ExportSource } from "./conversation-items.ts";

export type ExportFormat = "markdown" | "html" | "json";
export type ExportExtension = "md" | "html" | "json";

export const EXPORT_EXTENSIONS: Record<ExportFormat, ExportExtension> = { markdown: "md", html: "html", json: "json" };
const MIME_TYPES: Record<ExportFormat, string> = {
	markdown: "text/markdown;charset=utf-8",
	html: "text/html;charset=utf-8",
	json: "application/json;charset=utf-8",
};
const MAX_FILE_TITLE_CHARS = 60;

export type ExportResult = {
	content: string;
	mimeType: string;
	extension: ExportExtension;
	/** Images replaced by a placeholder in the HTML export (over budget, unreadable, unsupported). */
	skippedImages: number;
};

/** Text a copy button copies: user input or assistant answer body (never thinking); "" for other items. */
export function copyText(item: ChatItem): string {
	if (item.type === "user") return userText(item);
	if (item.type === "assistant") return item.text.trim();
	return "";
}

/** The last committed assistant answer with a non-empty body, or null. */
export function lastAnswerText(items: readonly ChatItem[]): string | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		if (item.type !== "assistant") continue;
		const text = copyText(item);
		if (text !== "") return text;
	}
	return null;
}

export function exportFormatFromPath(path: string): ExportFormat | null {
	const extension = /\.(md|html|json)$/i.exec(path)?.[1]?.toLowerCase();
	return extension === "md" ? "markdown" : extension === "html" ? "html" : extension === "json" ? "json" : null;
}

/** `<safe title>-<YYYYMMDD-HHmmss>.<ext>`; the title is stripped of path and reserved characters. */
export function exportFileName(title: string, format: ExportFormat, at: Date): string {
	const cleaned = title
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must be removed.
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/-{2,}/g, "-");
	const safe =
		Array.from(cleaned)
			.slice(0, MAX_FILE_TITLE_CHARS)
			.join("")
			.replace(/^[\s.-]+|[\s.-]+$/g, "") || FALLBACK_EXPORT_TITLE;
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	const stamp = `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	return `${safe}-${stamp}.${EXPORT_EXTENSIONS[format]}`;
}

export async function exportConversation(
	format: ExportFormat,
	source: ExportSource,
	options: ExportOptions,
): Promise<ExportResult> {
	if (source.items.length === 0) throw new Error("Nothing to export yet - start a conversation first");
	const extension = EXPORT_EXTENSIONS[format];
	const mimeType = MIME_TYPES[format];
	if (format === "html") {
		const { content, skippedImages } = await exportHtml(source, options);
		return { content, mimeType, extension, skippedImages };
	}
	const content = format === "markdown" ? exportMarkdown(source, options) : exportJson(source, options);
	return { content, mimeType, extension, skippedImages: 0 };
}

/** Fenced block whose fence is longer than any backtick run in the content, so it cannot break out. */
function block(content: string, language = ""): string {
	let longest = 0;
	for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
	const marks = "`".repeat(Math.max(3, longest + 1));
	return `${marks}${language}\n${content}\n${marks}`;
}
const escapeInline = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function exportMarkdown(source: ExportSource, options: ExportOptions): string {
	const out: string[] = [
		`# ${oneLine(source.title) || FALLBACK_EXPORT_TITLE}`,
		"",
		`- **Model:** ${oneLine(source.model)}`,
		`- **Workspace:** ${oneLine(source.cwd)}`,
		`- **Exported:** ${source.exportedAt.toISOString()}`,
		"",
	];
	let role: "user" | "assistant" | null = null;
	const heading = (next: "user" | "assistant") => {
		if (role === next) return;
		role = next;
		out.push("---", "", next === "user" ? "## User" : "## Assistant", "");
	};
	for (const item of source.items) {
		if (item.type === "system") {
			role = null;
			out.push("---", "", `*${escapeInline(oneLine(item.text))}*`, "");
		} else if (item.type === "user") {
			heading("user");
			const text = userText(item);
			if (text !== "") out.push(text, "");
			for (const image of item.images ?? []) out.push(`> [image] ${escapeInline(imageLabel(image))}`, "");
		} else if (item.type === "assistant") {
			heading("assistant");
			if (options.includeThinking && item.thinking.trim() !== "")
				out.push("<details>", "<summary>Thinking</summary>", "", item.thinking.trim(), "", "</details>", "");
			if (item.text.trim() !== "") out.push(item.text.trim(), "");
			if (item.note !== null) out.push(`> ${escapeInline(oneLine(item.note))}`, "");
		} else {
			heading("assistant");
			out.push(...markdownTool(item));
		}
	}
	return `${out.join("\n").trimEnd()}\n`;
}

function markdownTool(item: ToolItem): string[] {
	const status = toolStatus(item);
	const label = [
		`Tool: ${item.name}`,
		item.summary === "" ? "" : `· ${oneLine(item.summary)}`,
		status === "ok" ? "" : `[${status}]`,
		item.durationMs === null ? "" : `(${formatDuration(item.durationMs)})`,
	]
		.filter(Boolean)
		.join(" ");
	const lines = ["<details>", `<summary>${escapeInline(label)}</summary>`, ""];
	if (item.detail !== null && item.detail !== "")
		lines.push(block(item.detail, item.codemode === undefined ? "" : "javascript"), "");
	if (item.codemode !== undefined && item.codemode.calls.length > 0) {
		const calls = item.codemode.calls.map(codemodeCallLine);
		if (item.codemode.omitted > 0) calls.push(codemodeOmittedLine(item.codemode.omitted));
		lines.push("Calls:", "", block(calls.join("\n")), "");
	}
	const output = toolOutput(item);
	if (output !== "") lines.push(status === "running" ? "Output so far:" : "Result:", "", block(output), "");
	if (item.note !== null) lines.push(`> ${escapeInline(oneLine(item.note))}`, "");
	for (const image of item.images ?? []) lines.push(`> [image] ${escapeInline(imageLabel(image))}`, "");
	lines.push("</details>", "");
	return lines;
}

function exportJson(source: ExportSource, options: ExportOptions): string {
	const items = source.items.map((item) => {
		switch (item.type) {
			case "user":
				return {
					type: "user",
					text: userText(item),
					images: (item.images ?? []).map(({ name, mimeType, width, height, bytes }) => ({
						name,
						mimeType,
						width,
						height,
						bytes,
					})),
				};
			case "assistant":
				return {
					type: "assistant",
					text: item.text,
					...(options.includeThinking && item.thinking.trim() !== "" ? { thinking: item.thinking } : {}),
					stopReason: item.stopReason,
					note: item.note,
				};
			case "tool":
				return {
					type: "tool",
					name: item.name,
					summary: item.summary,
					detail: item.detail,
					status: item.phase,
					isError: item.isError,
					result: toolOutput(item),
					...(item.codemode === undefined ? {} : { codemode: item.codemode }),
					durationMs: item.durationMs,
					note: item.note,
					images: (item.images ?? []).map(({ name, mimeType, width, height, bytes }) => ({
						name,
						mimeType,
						width,
						height,
						bytes,
					})),
				};
			default:
				return { type: "system", text: item.text };
		}
	});
	return `${JSON.stringify(
		{
			format: "neko-conversation",
			version: 1,
			session: {
				id: source.sessionId,
				title: source.title,
				model: source.model,
				cwd: source.cwd,
				exportedAt: source.exportedAt.toISOString(),
			},
			items,
		},
		null,
		2,
	)}\n`;
}
