#!/usr/bin/env node

import { silenceSqliteWarning } from "@neko-harness/core/runtime-warnings";
import { unsupportedNode } from "./node-version.ts";

/** Release builds inject the floor from the root package's `engines.node`; source runs skip the check. */
declare const NEKO_MIN_NODE: string;

// Everything imported here must be free of third-party imports: an old Node fails on them before any check can run.
const problem =
	typeof NEKO_MIN_NODE === "undefined" ? undefined : unsupportedNode(process.versions.node, NEKO_MIN_NODE);
if (problem) {
	console.error(problem);
	process.exitCode = 1;
} else {
	silenceSqliteWarning();
	// A computed specifier keeps the CLI bundle out of the launcher.
	await import(new URL(process.env.NEKO_RELEASE_BUILD === "1" ? "./cli.js" : "./main.ts", import.meta.url).href);
}
