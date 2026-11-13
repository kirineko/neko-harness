import { chmod, cp, readFile, rm } from "node:fs/promises";
import manifest from "../package.json";

// The ordinary workspace build labels the client as development. Build the published client with the same release marker as the Bun bundles.
const clientBuild = Bun.spawn([process.execPath, "run", "--cwd", "packages/web", "build"], {
	env: { ...process.env, NEKO_RELEASE_BUILD: "1" },
	stdout: "inherit",
	stderr: "inherit",
});
if ((await clientBuild.exited) !== 0) throw new Error("Release client build failed");
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
	const result = await Bun.build({
		entrypoints: [entry],
		outdir: "dist",
		naming: `${name}.js`,
		target: "node",
		format: "esm",
		conditions: ["neko-source"],
		external: Object.keys(manifest.dependencies),
		define: {
			"process.env.NEKO_RELEASE_BUILD": JSON.stringify("1"),
			"process.env.NEKO_RELEASE_VERSION": JSON.stringify(manifest.version),
			NEKO_BUILD_VERSION: JSON.stringify(manifest.version),
			NEKO_MIN_NODE: JSON.stringify(minimumNode),
		},
	});
	if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`);
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
