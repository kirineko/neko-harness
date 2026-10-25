/** Item-level helpers shared by the Markdown/JSON/HTML exporters; browser-safe. */
import type { ImageFile } from "./image-transfer.ts";
import type { ChatImage, ChatItem, CodemodeCallView } from "./projection.ts";

export type ExportSource = {
	sessionId: string;
	title: string;
	model: string;
	cwd: string;
	exportedAt: Date;
	items: readonly ChatItem[];
};
export type ExportOptions = {
	includeThinking: boolean;
	/** Reads image bytes for HTML embedding; without it every image becomes a placeholder. */
	loadImage?: (image: ChatImage) => Promise<ImageFile>;
};
export type UserItem = Extract<ChatItem, { type: "user" }>;
export type ToolItem = Extract<ChatItem, { type: "tool" }>;

export const FALLBACK_EXPORT_TITLE = "neko-session";

/** User text for a skill invocation is `/skill:<name> <args>`, never the expanded skill body. */
export function userText(item: UserItem): string {
	if (item.skill === undefined) return item.text;
	return item.skill.args === "" ? `/skill:${item.skill.name}` : `/skill:${item.skill.name} ${item.skill.args}`;
}

export function toolStatus(item: ToolItem): "pending" | "running" | "ok" | "error" {
	return item.phase !== "done" ? item.phase : item.isError ? "error" : "ok";
}
/** Final result for finished tools; the partial live output while still running. */
export function toolOutput(item: ToolItem): string {
	return (item.phase === "done" ? item.result : item.output) ?? "";
}
export function imageLabel(image: ChatImage): string {
	const size = image.width > 0 && image.height > 0 ? ` · ${image.width}×${image.height}` : "";
	return `${image.name} · ${image.mimeType}${size}`;
}
/** One line per nested call of a codemode script: tool, argument preview, status, time, error. Never a result body. */
export function codemodeCallLine(call: CodemodeCallView): string {
	return [
		`${call.name}${call.args === "" ? "" : ` ${oneLine(call.args)}`}`,
		call.status,
		call.durationMs === null ? "" : formatDuration(call.durationMs),
		call.error === null ? "" : oneLine(call.error),
	]
		.filter(Boolean)
		.join(" · ");
}
/** Trailing line of a codemode list that was cut at the call limit. */
export const codemodeOmittedLine = (omitted: number): string => `… ${omitted} more calls not listed`;
export function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
/** Collapse whitespace so user-controlled text stays on one line of the document. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
