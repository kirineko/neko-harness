import { cp, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json";
import { connectNekoGateway } from "../packages/gateway/src/client.ts";
import { removeDir } from "../test/temp-dir.ts";

async function run(cmd: string[], cwd: string, env = process.env) {
	const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${cmd[0]} failed (${code})\n${stdout}\n${stderr}`);
	return stdout;
}

/** Windows has no graceful signal; kill the whole tree so the gateway child does not keep the temp dir locked. */
function killWindowsTree(pid: number): void {
	Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
}

const root = resolve(import.meta.dir, "..");
await mkdir(join(root, "artifacts"), { recursive: true });
await run([process.execPath, "pm", "pack", "--destination", "artifacts"], root);
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
	"dist/gateway.js",
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
const temp = await mkdtemp(join(tmpdir(), "neko-package-"));
let web: ReturnType<typeof Bun.spawn> | undefined;
try {
	await Bun.write(
		join(temp, "package.json"),
		JSON.stringify({ private: true, dependencies: { "neko-harness": archive } }),
	);
	await run([process.execPath, "install", "--production", "--ignore-scripts"], temp);
	const bin = join(temp, "bin");
	await mkdir(bin);
	if (process.platform === "win32") await cp(process.execPath, join(bin, "bun.exe"));
	else await symlink(process.execPath, join(bin, "bun"));
	await cp(join(root, "scripts/package-sdk-smoke.mjs"), join(temp, "package-sdk-smoke.mjs"));
	const cli = join(temp, "node_modules", ".bin", process.platform === "win32" ? "neko.exe" : "neko");
	const home = join(temp, "home");
	// Windows resolves the home directory from USERPROFILE, not HOME.
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		DEEPSEEK_API_KEY: "",
		TAVILY_API_KEY: "",
		PATH: bin,
	};
	await mkdir(env.HOME, { recursive: true });
	if ((await run([cli, "--version"], temp, env)).trim() !== manifest.version) throw new Error("Version mismatch");
	for (const command of ["tui", "web", "serve", "update"]) {
		const help = await run([cli, command, "--help"], temp, env);
		if (!help.includes("--help")) throw new Error(`Missing ${command} help`);
	}
	await run(
		[
			process.execPath,
			"-e",
			`const p = Bun.resolveSync('sharp', './node_modules/neko-harness/dist/neko.js'); const {default: sharp} = await import(p); await sharp({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer();`,
		],
		temp,
		env,
	);
	console.log((await run([process.execPath, "package-sdk-smoke.mjs"], temp, env)).trim());
	const port = await new Promise<number>((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing port");
			server.close(() => resolvePort(address.port));
		});
	});
	web = Bun.spawn(
		[
			cli,
			"web",
			"--no-open",
			"--port",
			"0",
			"--gateway-port",
			String(port),
			"--storage",
			join(temp, "data", "neko.sqlite"),
		],
		{ cwd: temp, env, stdout: "pipe", stderr: "pipe" },
	);
	let logs = "";
	const collect = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
	};
	const readers = Promise.all([
		collect(web.stdout as ReadableStream<Uint8Array>),
		collect(web.stderr as ReadableStream<Uint8Array>),
	]);
	let url: string | undefined;
	for (let i = 0; i < 150; i++) {
		url = logs.match(/neko web 已启动: (http:\/\/[^\s]+)/)?.[1];
		if (url) break;
		if (web.exitCode !== null) throw new Error(`Web exited early: ${logs}`);
		await Bun.sleep(200);
	}
	if (!url) throw new Error(`Web startup timed out: ${logs}`);
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
	const updateResult = Bun.spawn([cli, "update"], { cwd: temp, env, stdout: "pipe", stderr: "pipe" });
	const [updateOut, updateError, updateCode] = await Promise.all([
		new Response(updateResult.stdout as ReadableStream).text(),
		new Response(updateResult.stderr as ReadableStream).text(),
		updateResult.exited,
	]);
	if (process.platform === "win32") {
		if (updateCode !== 0 || !updateOut.includes("bun add --global neko-harness@latest"))
			throw new Error("Windows update should print manual upgrade instructions");
	} else if (updateCode === 0 || !updateError.includes("不支持自升级")) {
		throw new Error("Local install update should refuse");
	}
	if (process.platform === "win32") {
		killWindowsTree(web.pid);
		await web.exited;
	} else {
		web.kill("SIGTERM");
		const exit = await Promise.race([
			web.exited,
			Bun.sleep(10_000).then(() => {
				throw new Error("Web shutdown timed out");
			}),
		]);
		await readers;
		if (exit !== 0) throw new Error(`Web failed to shut down: ${logs}`);
	}
	console.log(`Package smoke test passed: ${archive} (${files.length} files)`);
} finally {
	if (web && web.exitCode === null) {
		if (process.platform === "win32") killWindowsTree(web.pid);
		else web.kill("SIGKILL");
		await web.exited;
	}
	await removeDir(temp);
}
