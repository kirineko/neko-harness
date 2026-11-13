import { readFileSync } from "node:fs";

/**
 * The root package manifest. Read from disk instead of imported: Node needs an import attribute for JSON modules,
 * which the repository's `module: Node16` setting does not accept.
 */
export const manifest: {
	version: string;
	engines: { node: string };
	dependencies: Record<string, string>;
} = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
