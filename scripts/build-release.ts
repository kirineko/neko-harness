import { spawnSync } from "node:child_process";
import { chmod, cp, readFile, rm } from "node:fs/promises";
import { rolldown } from "rolldown";
import { manifest } from "./manifest.ts";

// The ordinary workspace build labels the client as development. Build the published client with the same release marker as the bundles.
// pnpm exposes its own entry point to scripts; going through it avoids a shell and the `.cmd` shim on Windows.
const pnpm = process.env.npm_execpath;
const clientBuild = spawnSync(
	pnpm ? process.execPath : "pnpm",
	[...(pnpm ? [pnpm] : []), "--filter", "@neko-harness/web", "run", "build"],
	{ env: { ...process.env, NEKO_RELEASE_BUILD: "1" }, stdio: "inherit" },
);
if (clientBuild.status !== 0) throw new Error("Release client build failed");
await rm("dist", { recursive: true, force: true });
// The published runtime is Node. `engines.node` is the only source of the minimum version the launcher enforces.
const minimumNode = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines.node)?.[1];
if (!minimumNode) throw new Error(`Unsupported engines.node range: ${manifest.engines.node}`);
// dist/neko.js and dist/gateway.js are dependency-free launchers (Node version check, warning filter) that load
// dist/cli.js and dist/gateway-main.js: bundled dependencies would otherwise load before any entry code runs.
for (const [name, entry] of Object.entries({
	neko: "packages/cli/src/bin.ts",
	cli: "packages/cli/src/main.ts",
	gateway: "packages/gateway/src/bin.ts",
	"gateway-main": "packages/gateway/src/main.ts",
})) {
	// Runtime dependencies stay external (the published package installs them); everything else is bundled.
	const external = Object.keys(manifest.dependencies);
	const bundle = await rolldown({
		input: entry,
		platform: "node",
		external: (id) => id.startsWith("node:") || external.some((name) => id === name || id.startsWith(`${name}/`)),
		resolve: { conditionNames: ["neko-source", "import", "node", "default"] },
		transform: {
			define: {
				"process.env.NEKO_RELEASE_BUILD": JSON.stringify("1"),
				"process.env.NEKO_RELEASE_VERSION": JSON.stringify(manifest.version),
				NEKO_BUILD_VERSION: JSON.stringify(manifest.version),
				NEKO_MIN_NODE: JSON.stringify(minimumNode),
			},
		},
		logLevel: "warn",
	});
	// One file per entry: the launchers import their bundle by a computed path, nothing else may be split off.
	await bundle.write({ file: `dist/${name}.js`, format: "esm", codeSplitting: false });
	await bundle.close();
	const output = await readFile(`dist/${name}.js`, "utf8");
	for (const marker of ["// @bun", "import.meta.require", "Bun."]) {
		if (output.includes(marker)) throw new Error(`dist/${name}.js is not a Node bundle: found ${marker}`);
	}
}
for (const launcher of ["dist/neko.js", "dist/gateway.js"]) {
	const source = await readFile(launcher, "utf8");
	if (!source.startsWith("#!/usr/bin/env node\n")) throw new Error(`${launcher} must start with the node shebang`);
	// A launcher that pulled in a dependency would fail on an old Node before it can report anything.
	if (/^import\s/m.test(source)) throw new Error(`${launcher} must not have static imports`);
}
await cp("packages/web/dist/client", "dist/client", { recursive: true });
// Builtin skills ship as runtime files next to the bundled binaries (dist/skills/),
// resolved by core's BUILTIN_SKILLS_DIR probe from dist/neko.js / dist/gateway.js.
await cp("packages/core/skills", "dist/skills", { recursive: true });
await chmod("dist/neko.js", 0o755);
console.log(`Built neko-harness ${manifest.version}`);
