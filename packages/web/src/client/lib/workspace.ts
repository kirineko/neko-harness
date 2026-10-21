/** DOM-free helpers shared by the workspace sidebar components. */

import { getT } from "./i18n/index.ts";

export const MAIN_AGENT = "main";

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The server reports a missing file as `File not found.`; that gets its own, friendlier state. */
export const isNotFound = (message: string | undefined): boolean =>
	message !== undefined && /not found|ENOENT|不存在/i.test(message);

export function splitPath(path: string): { name: string; dir: string } {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export const agentLabel = (agent: string): string => (agent === MAIN_AGENT ? getT()("agent.main") : agent);

/** Number of displayed lines: a trailing newline does not add an empty last line. */
export function lineCount(text: string): number {
	if (text === "") return 1;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

export function ancestorDirs(path: string): string[] {
	const parts = path.split("/").slice(0, -1);
	return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}
