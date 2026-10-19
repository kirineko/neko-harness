import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NekoModelRef } from "@neko-harness/core";
import { ApplicationProtocolError } from "@neko-harness/core/application-version";
import {
	connectNekoGateway,
	gatewayCommand,
	readGatewayPortFile,
	removeGatewayPortFile,
	stopGatewayProcess,
} from "@neko-harness/gateway";

/**
 * 确保一个 neko gateway 在运行：POSIX 先探活 Unix socket，再验证浏览器所需的 WS 地址与身份，
 * Unix 不通则 spawn gateway 子进程（Bun 源码或构建产物入口）并轮询两种传输直到就绪；
 * socket 文件存在但无响应时直接 spawn——网关的 Unix listener 会识别并接管
 * stale socket。Windows 无 Unix socket：经端口文件（<storageDir>/<serverId>.port）
 * 发现 ws 地址并探活，失败则 spawn ws-only 网关。
 */

export type GatewayEnsureOptions = {
	/** WebSocket 监听地址（默认 127.0.0.1）。 */
	readonly host?: string;
	/** WebSocket 监听端口（默认 8321）。 */
	readonly port?: number;
	/** Unix socket 路径（默认 <storageDir>/<serverId>.sock）。 */
	readonly socketPath?: string;
	/** SQLite 存储文件（决定数据目录与默认 socket 位置）。 */
	readonly storagePath: string;
	readonly credentialsPath?: string;
	readonly cwd?: string;
	readonly model?: NekoModelRef;
	/** 逻辑服务器身份（默认读取/生成 <storageDir>/gateway-server-id）。 */
	readonly serverId?: string;
	readonly spawnTimeoutMs?: number;
	/** 网关子进程 stdout/stderr 行回调（main.ts 用于打印）。 */
	readonly onLog?: (line: string) => void;
	/** 中断启动等待；已拉起的子进程会被终止。 */
	readonly signal?: AbortSignal;
};

export type GatewayHandle = {
	readonly serverId: string;
	/** Unix socket 路径；Windows（无 Unix 传输）为 undefined。 */
	readonly socketPath: string | undefined;
	/** 浏览器连接的网关 WebSocket 地址。 */
	readonly wsUrl: string;
	/** 本进程 spawn 的网关子进程；接入既有网关时为 null。 */
	readonly spawned: ChildProcess | null;
	close(): Promise<void>;
};

const SERVER_ID_FILENAME = "gateway-server-id";
const PROBE_INTERVAL_MS = 400;
const PROBE_TIMEOUT_MS = 5_000;

export async function ensureNekoGateway(options: GatewayEnsureOptions): Promise<GatewayHandle> {
	const timeoutMs = options.spawnTimeoutMs ?? 30_000;
	const timeoutAt = Date.now() + timeoutMs;
	const nekoDir = dirname(options.storagePath);
	const serverId = options.serverId ?? (await loadOrCreateServerId(nekoDir));

	if (process.platform === "win32") {
		// Windows：端口文件发现 + ws 探活；过期文件/连接失败按无活跃网关处理。
		const discovered = await readGatewayPortFile(nekoDir, serverId);
		if (discovered !== undefined && (await probeWs(discovered, serverId, timeoutAt))) {
			return makeHandle(serverId, undefined, discovered, null, nekoDir);
		}
		throwIfAborted(options.signal);
		const child = spawnGatewayProcess(options, null, serverId);
		pipeChildLogs(child, options.onLog);
		let spawnError: Error | undefined;
		child.on("error", (error: Error) => {
			spawnError = error;
		});
		try {
			let lastError: unknown = new Error("gateway 未就绪");
			while (Date.now() < timeoutAt) {
				throwIfAborted(options.signal);
				if (spawnError !== undefined) throw spawnError;
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error(
						`neko gateway 子进程提前退出（code ${child.exitCode}），详见上方日志。端口文件可能被其他实例占用。`,
					);
				}
				const wsUrl = await readGatewayPortFile(nekoDir, serverId);
				if (wsUrl !== undefined) {
					try {
						if (await probeWs(wsUrl, serverId, timeoutAt))
							return makeHandle(serverId, undefined, wsUrl, child, nekoDir);
					} catch (error) {
						if (error instanceof ApplicationProtocolError) throw error;
						lastError = error;
					}
				}
				await sleep(Math.max(0, Math.min(PROBE_INTERVAL_MS, timeoutAt - Date.now())), options.signal);
			}
			throw new Error(
				`等待 neko gateway 就绪超时（${options.spawnTimeoutMs ?? 30_000}ms）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
			);
		} catch (error) {
			await stopSpawnedGateway(child);
			throw error;
		}
	}

	const socketPath = options.socketPath ?? join(nekoDir, `${serverId}.sock`);
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 8321;
	const wsUrl = `ws://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;

	if (await probeGateway(socketPath, serverId, timeoutAt)) {
		if (!(await probeWs(wsUrl, serverId, timeoutAt))) {
			throw new Error(
				`已有 gateway（serverId: ${serverId}，Unix socket: ${socketPath}），但 WebSocket ${wsUrl} 不可用或身份不匹配。请检查 --gateway-port 及 WS 地址配置是否匹配已有网关；若未启用 WS，请正常退出原网关并重新启动双传输 gateway。`,
			);
		}
		return makeHandle(serverId, socketPath, wsUrl, null, nekoDir);
	}

	throwIfAborted(options.signal);
	const child = spawnGatewayProcess(options, socketPath, serverId);
	pipeChildLogs(child, options.onLog);
	let spawnError: Error | undefined;
	child.on("error", (error: Error) => {
		spawnError = error;
	});
	try {
		// 让子进程有机会打印启动错误再报错。
		let lastError: unknown = new Error("gateway 未就绪");
		while (Date.now() < timeoutAt) {
			throwIfAborted(options.signal);
			if (spawnError !== undefined) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(
					`neko gateway 子进程提前退出（code ${child.exitCode}），详见上方日志。地址可能被其他实例占用。`,
				);
			}
			try {
				if ((await probeGateway(socketPath, serverId, timeoutAt)) && (await probeWs(wsUrl, serverId, timeoutAt)))
					return makeHandle(serverId, socketPath, wsUrl, child, nekoDir);
				lastError = new Error(`WebSocket ${wsUrl} 或 Unix socket ${socketPath} 未就绪或身份不匹配`);
			} catch (error) {
				if (error instanceof ApplicationProtocolError) throw error;
				lastError = error;
			}
			await sleep(Math.max(0, Math.min(PROBE_INTERVAL_MS, timeoutAt - Date.now())), options.signal);
		}
		throw new Error(
			`等待 neko gateway 就绪超时（${options.spawnTimeoutMs ?? 30_000}ms）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	} catch (error) {
		await stopSpawnedGateway(child);
		throw error;
	}
}

function stopSpawnedGateway(child: ChildProcess): Promise<void> {
	return stopGatewayProcess(child, { viaStdin: process.platform === "win32" });
}

function spawnGatewayProcess(options: GatewayEnsureOptions, socketPath: string | null, serverId: string): ChildProcess {
	const args = [
		"--host",
		options.host ?? "127.0.0.1",
		...(process.platform === "win32"
			? // Windows：仅 WS，不传 --port 走 win32 默认随机端口，地址经端口文件发现。
				["--no-socket", "--stop-on-stdin"]
			: ["--port", String(options.port ?? 8321), "--socket-path", socketPath ?? ""]),
		"--server-id",
		serverId,
		"--storage",
		options.storagePath,
		...(options.credentialsPath ? ["--credentials", options.credentialsPath] : []),
		...(options.cwd !== undefined ? ["--cwd", options.cwd] : []),
		...(options.model !== undefined ? ["--model", `${options.model.provider}/${options.model.modelId}`] : []),
	];
	const command = gatewayCommand(args);
	return spawn(command.binary, command.args, {
		env: process.env,
		stdio: [process.platform === "win32" ? "pipe" : "ignore", "pipe", "pipe"],
	});
}

function pipeChildLogs(child: ChildProcess, onLog: ((line: string) => void) | undefined): void {
	if (onLog === undefined) return;
	child.stdout?.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (line.trim() !== "") onLog(line);
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (line.trim() !== "") onLog(line);
		}
	});
}

/** 探活：在 Unix socket 上完成 pi 握手 + 服务目录绑定即认为网关存活且身份匹配。 */
async function probeGateway(socketPath: string, serverId: string, timeoutAt: number): Promise<boolean> {
	return probeAddress({ transport: "unix", socketPath, serverId }, timeoutAt);
}

/** 在将发布的 WS 地址上完成握手、身份校验与服务绑定。 */
async function probeWs(wsUrl: string, serverId: string, timeoutAt: number): Promise<boolean> {
	return probeAddress({ transport: "ws", url: wsUrl, serverId }, timeoutAt);
}

async function probeAddress(address: Parameters<typeof connectNekoGateway>[0], timeoutAt: number): Promise<boolean> {
	const remainingMs = timeoutAt - Date.now();
	if (remainingMs <= 0) return false;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("Gateway probe timed out")),
		Math.min(PROBE_TIMEOUT_MS, remainingMs),
	);
	try {
		const probe = await connectNekoGateway(address, controller.signal);
		try {
			return true;
		} finally {
			controller.abort();
			await probe.close();
		}
	} catch (error) {
		if (error instanceof ApplicationProtocolError) throw error;
		return false;
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

function makeHandle(
	serverId: string,
	socketPath: string | undefined,
	wsUrl: string,
	spawned: ChildProcess | null,
	nekoDir: string,
): GatewayHandle {
	return {
		serverId,
		socketPath,
		wsUrl,
		spawned,
		async close() {
			if (spawned !== null) {
				await stopSpawnedGateway(spawned);
				// Windows 的 kill 是 TerminateProcess，网关 close（含端口文件删除）不会执行，这里补删。
				if (process.platform === "win32") await removeGatewayPortFile(nekoDir, serverId).catch(() => {});
			}
		},
	};
}

async function loadOrCreateServerId(nekoDir: string): Promise<string> {
	const file = join(nekoDir, SERVER_ID_FILENAME);
	try {
		const existing = (await readFile(file, "utf8")).trim();
		if (existing !== "") return existing;
	} catch {
		// 首次启动：生成并持久化，与 gateway 的逻辑一致。
	}
	const created = randomUUID();
	await mkdir(nekoDir, { recursive: true, mode: 0o700 });
	await writeFile(file, `${created}\n`, { mode: 0o600 });
	return created;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("neko gateway 启动被中断");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}
