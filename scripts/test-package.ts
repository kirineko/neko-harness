import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connectNekoGateway } from "../packages/gateway/src/client.ts";
import { removeDir } from "../test/temp-dir.ts";
import { manifest } from "./manifest.ts";

/** Starts `cmd` with piped output that accumulates in `out`; `exited` resolves to the exit code (-1 when signalled). */
function start(cmd: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	const out = { stdout: "", stderr: "" };
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		out.stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		out.stderr += chunk;
	});
	const exited = new Promise<number>((done, reject) => {
		child.once("error", reject);
		child.once("close", (code) => done(code ?? -1));
	});
	return { child, out, exited };
}

async function run(cmd: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const started = start(cmd, cwd, env);
	const code = await started.exited;
	const { stdout, stderr } = started.out;
	if (code !== 0) throw new Error(`${cmd[0]} failed (${code})\n${stdout}\n${stderr}`);
	// Node prints runtime warnings as "(node:<pid>) <Kind>Warning: ..."; the published CLI must start without any.
	if (/\(node:\d+\) \w*Warning/.test(stderr)) throw new Error(`${cmd.join(" ")} printed a runtime warning\n${stderr}`);
	return stdout;
}

/** npm and the installed `neko` are `.cmd` shims on Windows, which only start through the command interpreter. */
const viaShell = (cmd: string[]) =>
	process.platform === "win32" ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", ...cmd] : cmd;

/** Windows has no graceful signal; kill the whole tree so the gateway child does not keep the temp dir locked. */
function killWindowsTree(pid: number): void {
	spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
}

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, "artifacts"), { recursive: true });
// pnpm exposes its own entry point to scripts; going through it avoids a shell and the `.cmd` shim on Windows.
const pnpm = process.env.npm_execpath;
await run([...(pnpm ? [process.execPath, pnpm] : ["pnpm"]), "pack", "--pack-destination", "artifacts"], root);
const archive = join(root, "artifacts", `neko-harness-${manifest.version}.tgz`);
// GNU tar (Git for Windows) reads "D:\..." as host:path; pass a relative name and run inside artifacts/ instead.
const tarCwd = join(root, "artifacts");
const archiveName = `neko-harness-${manifest.version}.tgz`;
const listing = await run(["tar", "-tzf", archiveName], tarCwd);
const files = listing
	.trim()
	.split(/\r?\n/)
	.filter((name) => !name.endsWith("/"));
for (const file of files) {
	if (!/^package\/(dist\/|package\.json$|README\.md$|LICENSE$)/.test(file)) {
		throw new Error(`Unexpected published file: ${file}`);
	}
}
for (const required of [
	"dist/neko.js",
	"dist/cli.js",
	"dist/gateway.js",
	"dist/gateway-main.js",
	"dist/client/index.html",
	"dist/skills/skill-creator/SKILL.md",
	"dist/skills/skill-finder/SKILL.md",
	"LICENSE",
]) {
	if (!files.includes(`package/${required}`)) throw new Error(`Missing ${required}`);
}
const packed = JSON.parse(await run(["tar", "-xOf", archiveName, "package/package.json"], tarCwd));
if (packed.private || packed.name !== "neko-harness" || packed.version !== manifest.version) {
	throw new Error("Invalid published manifest");
}
if (Object.keys(packed.dependencies).some((name) => name.startsWith("@neko-harness/"))) {
	throw new Error("Internal workspace dependency escaped into published package");
}
// The published package is installed with npm and runs on the Node that runs this script.
const node = process.execPath;
// Node cannot listen on a Unix socket path longer than the OS limit (104 bytes on macOS, 108 on Linux), and the
// gateway socket lives under the storage directory. macOS's per-user tmpdir alone is ~50 bytes, so stay under /tmp.
const temp = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "neko-package-"));
let web: ReturnType<typeof start> | undefined;
try {
	const prefix = join(temp, "prefix");
	const installed = start(viaShell(["npm", "install", "-g", "--prefix", prefix, archive]), temp);
	const installCode = await installed.exited;
	const { stdout: installOut, stderr: installErr } = installed.out;
	if (installCode !== 0) throw new Error(`npm install failed (${installCode})\n${installOut}\n${installErr}`);
	if (/ERESOLVE/.test(installOut + installErr)) throw new Error(`npm reported a peer conflict\n${installErr}`);
	const windows = process.platform === "win32";
	const packageRoot = windows
		? join(prefix, "node_modules", "neko-harness")
		: join(prefix, "lib", "node_modules", "neko-harness");
	if (!(await readFile(join(packageRoot, "dist", "neko.js"), "utf8")).startsWith("#!/usr/bin/env node\n"))
		throw new Error("Installed entry must start with the node shebang");
	// The children get this Node first on PATH and no Bun, so nothing can fall back to another runtime.
	const bin = join(temp, "bin");
	await mkdir(bin);
	if (windows) await cp(node, join(bin, "node.exe"));
	else await symlink(node, join(bin, "node"));
	const systemPath = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
	const cli = viaShell([windows ? join(prefix, "neko.cmd") : join(prefix, "bin", "neko")]);
	const home = join(temp, "home");
	// Windows resolves the home directory from USERPROFILE, not HOME.
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		DEEPSEEK_API_KEY: "",
		TAVILY_API_KEY: "",
		PATH: `${bin}${windows ? ";" : ":"}${systemPath}`,
	};
	for (const directory of env.PATH.split(delimiter)) {
		if (["bun", "bun.exe"].some((name) => existsSync(join(directory, name))))
			throw new Error(`Bun must not be reachable from the smoke test PATH, but ${directory} has it`);
	}
	await mkdir(env.HOME, { recursive: true });
	if ((await run([...cli, "--version"], temp, env)).trim() !== manifest.version) throw new Error("Version mismatch");
	for (const command of ["tui", "web", "serve", "update"]) {
		const help = await run([...cli, command, "--help"], temp, env);
		if (!help.includes("--help")) throw new Error(`Missing ${command} help`);
	}
	// Native and wasm dependencies resolve from the package's own node_modules, as they do for the CLI.
	await run(
		[
			node,
			"--input-type=module",
			"-e",
			"import sharp from 'sharp'; await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer();",
		],
		packageRoot,
		env,
	);
	const smoke = join(packageRoot, "smoke");
	await mkdir(smoke);
	await cp(join(root, "scripts/package-sdk-smoke.mjs"), join(smoke, "package-sdk-smoke.mjs"));
	console.log((await run([node, "package-sdk-smoke.mjs"], smoke, env)).trim());
	const port = await new Promise<number>((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing port");
			server.close(() => resolvePort(address.port));
		});
	});
	web = start(
		[
			...cli,
			"web",
			"--no-open",
			"--port",
			"0",
			"--gateway-port",
			String(port),
			"--storage",
			join(temp, "data", "neko.sqlite"),
		],
		temp,
		env,
	);
	const logs = () => `${web?.out.stdout}${web?.out.stderr}`;
	let url: string | undefined;
	for (let i = 0; i < 150; i++) {
		url = logs().match(/neko web 已启动: (http:\/\/[^\s]+)/)?.[1];
		if (url) break;
		if (web.child.exitCode !== null) throw new Error(`Web exited early: ${logs()}`);
		await sleep(200);
	}
	if (!url) throw new Error(`Web startup timed out: ${logs()}`);
	const response = await fetch(url);
	const html = await response.text();
	if (!response.ok || !html.includes('id="root"')) throw new Error("Web HTML unavailable");
	const infoResponse = await fetch(new URL("/api/info", url));
	const info = (await infoResponse.json()) as {
		webVersion: string;
		installedVersion: string;
		gatewayWs: string;
		serverId: string;
	};
	if (
		info.webVersion !== manifest.version ||
		info.installedVersion !== manifest.version ||
		infoResponse.headers.get("cache-control") !== "no-store"
	)
		throw new Error("Web version metadata mismatch");
	const client = await connectNekoGateway({ transport: "ws", url: info.gatewayWs, serverId: info.serverId });
	try {
		if (
			client.application.info.value?.runningVersion !== manifest.version ||
			client.application.info.value?.installedVersion !== manifest.version
		)
			throw new Error("Gateway version mismatch");
	} finally {
		await client.close();
	}
	const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
	if (assets.length < 2) throw new Error("Missing Web assets");
	for (const asset of assets) {
		const assetResponse = await fetch(new URL(asset[1]!, url));
		if (!assetResponse.ok) throw new Error(`Missing asset ${asset[1]}`);
		if (asset[1]!.endsWith(".js") && !(await assetResponse.text()).includes(manifest.version))
			throw new Error("Page version missing");
	}
	const updateResult = start([...cli, "update"], temp, env);
	const updateCode = await updateResult.exited;
	const { stdout: updateOut, stderr: updateError } = updateResult.out;
	if (process.platform === "win32") {
		if (updateCode !== 0 || !updateOut.includes("npm install -g neko-harness@latest"))
			throw new Error("Windows update should print manual upgrade instructions");
	} else if (updateCode === 0 || !updateError.includes("不支持自升级")) {
		throw new Error("Local install update should refuse");
	}
	if (process.platform === "win32") {
		killWindowsTree(web.child.pid!);
		await web.exited;
	} else {
		web.child.kill("SIGTERM");
		const timeout = new AbortController();
		const exit = await Promise.race([
			web.exited,
			sleep(10_000, undefined, { signal: timeout.signal }).then(() => {
				throw new Error("Web shutdown timed out");
			}),
		]);
		timeout.abort();
		if (exit !== 0) throw new Error(`Web failed to shut down: ${logs()}`);
	}
	if (/\(node:\d+\) \w*Warning/.test(logs())) throw new Error(`neko web printed a runtime warning\n${logs()}`);
	console.log(`Package smoke test passed: ${archive} (${files.length} files)`);
} finally {
	if (web && web.child.exitCode === null && web.child.signalCode === null) {
		if (process.platform === "win32") killWindowsTree(web.child.pid!);
		else web.child.kill("SIGKILL");
		await web.exited;
	}
	await removeDir(temp);
}
