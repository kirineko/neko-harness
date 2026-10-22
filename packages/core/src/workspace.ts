import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Workspace identity is the physical directory, not the enclosing repository. */
export function normalizeWorkspace(directory: string = process.cwd()): string {
	try {
		const path = realpathSync(resolve(directory));
		if (!statSync(path).isDirectory()) throw new Error("Not a directory");
		return path;
	} catch (cause) {
		throw new Error(`Workspace is not available: ${directory}`, { cause });
	}
}

/** Restoring a session never rebinds its directory or requires it to still exist. */
export function savedWorkspace(directory: string | undefined): string {
	if (!directory || !isAbsolute(directory)) {
		throw new Error("Unsupported session storage: missing absolute workspace. Use a fresh storage file.");
	}
	return directory;
}

/** Validate execution without resolving the saved identity again. */
export function executionWorkspace(directory: string | undefined): string {
	const path = savedWorkspace(directory);
	try {
		if (!statSync(path).isDirectory()) throw new Error("Not a directory");
	} catch (cause) {
		throw new Error(`Workspace is not available: ${path}`, { cause });
	}
	return path;
}

export type NekoWorkspace = { readonly path: string; readonly createdAt: number };

/** Explicit registration requires a readable, traversable directory. */
export function accessibleWorkspace(directory: string): string {
	const path = normalizeWorkspace(directory);
	try {
		accessSync(path, constants.R_OK | constants.X_OK);
	} catch (cause) {
		throw new Error(`Workspace is not accessible: ${directory}`, { cause });
	}
	return path;
}

/** Rejections of `removeWorkspace`; `CODE: text` like the other core errors, mapped to the UI language by the frontends. */
export const WORKSPACE_UNKNOWN = "WORKSPACE_UNKNOWN: This workspace is not in the list.";
export const WORKSPACE_LAST = "WORKSPACE_LAST: Keep at least one workspace.";
export const WORKSPACE_BUSY = "WORKSPACE_BUSY: Stop or finish the running sessions of this workspace first.";
