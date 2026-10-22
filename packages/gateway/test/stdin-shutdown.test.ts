import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayCommand, gatewayPortFilePath, stopGatewayProcess } from "../src/index.ts";

const SERVER_ID = "stdin-test";
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

/** 启动一个独立网关进程：Windows 仅 WS（端口文件），POSIX 仅 Unix socket。 */
async function startChild(extraArgs: readonly string[]) {
	const root = await mkdtemp(join(tmpdir(), "neko-stdin-"));
	dirs.push(root);
	const nekoDir = join(root, "data");
	await mkdir(nekoDir, { recursive: true });
	const socketPath = join(nekoDir, `${SERVER_ID}.sock`);
	const transport = process.platform === "win32" ? ["--no-socket"] : ["--port", "0", "--socket-path", socketPath];
	const command = gatewayCommand([
		...transport,
		"--server-id",
		SERVER_ID,
		"--storage",
		join(nekoDir, "neko.sqlite"),
		"--credentials",
		join(nekoDir, "credentials.json"),
		"--cwd",
		root,
		"--config",
		root,
		...extraArgs,
	]);
	const child = spawn(command.binary, command.args, { stdio: ["pipe", "pipe", "pipe"] });
	children.push(child);
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf8");
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const artifact = process.platform === "win32" ? gatewayPortFilePath(nekoDir, SERVER_ID) : socketPath;
	await until(() => existsSync(artifact) || child.exitCode !== null, `gateway startup\n${output}`);
	expect(child.exitCode).toBeNull();
	return { child, exited, artifact, output: () => output };
}

describe("gateway --stop-on-stdin", () => {
	it("exits 0 and removes its address artifact when stdin closes", async () => {
		const { child, exited, artifact, output } = await startChild(["--stop-on-stdin"]);
		child.stdin?.end();
		const code = await Promise.race([exited, sleep(15_000).then(() => "timeout" as const)]);
		expect(code, output()).toBe(0);
		expect(existsSync(artifact)).toBe(false);
	}, 40_000);

	it("does not exit on stdin close without the flag", async () => {
		const { child, exited, artifact } = await startChild([]);
		child.stdin?.end();
		const code = await Promise.race([exited, sleep(500).then(() => "alive" as const)]);
		expect(code).toBe("alive");
		expect(existsSync(artifact)).toBe(true);
		child.kill("SIGKILL");
		await exited;
	}, 40_000);

	it("stopGatewayProcess({ viaStdin }) stops a --stop-on-stdin gateway gracefully", async () => {
		const { child, exited, artifact } = await startChild(["--stop-on-stdin"]);
		await stopGatewayProcess(child, { viaStdin: true });
		expect(await exited).toBe(0);
		expect(existsSync(artifact)).toBe(false);
	}, 40_000);

	it("stopGatewayProcess({ viaStdin }) force-kills a child that ignores stdin closing", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		children.push(child);
		await sleep(300);
		const started = Date.now();
		await stopGatewayProcess(child, { viaStdin: true, gracefulMs: 300, forcedMs: 2_000 });
		expect(Date.now() - started).toBeLessThan(2_500);
		expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
	}, 20_000);
});
