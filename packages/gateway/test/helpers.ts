import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderHandle, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDir } from "../../../test/temp-dir.ts";
import { type NekoGateway, type NekoGatewayAddress, startGateway } from "../src/index.ts";

export const IS_WINDOWS = process.platform === "win32";

export type TestGateway = {
	readonly gateway: NekoGateway;
	readonly dir: string;
	readonly faux: FauxProviderHandle;
	/** Unix socket 路径；Windows（无 Unix 传输）为 undefined。 */
	readonly socketPath: string | undefined;
	readonly wsUrl: string;
	readonly serverId: string;
};

/** 测试网关的 socket 路径：Windows 返回 null（ws-only），POSIX 返回 <dir>/gateway.sock。 */
export function testSocketPath(dir: string): string | null {
	return IS_WINDOWS ? null : join(dir, "gateway.sock");
}

/** 测试连接地址按平台分叉：POSIX 走 Unix socket（同现状），Windows 走 WebSocket。 */
export function testAddress(target: {
	socketPath?: string | undefined;
	wsUrl?: string | undefined;
	serverId: string;
}): NekoGatewayAddress {
	if (IS_WINDOWS) {
		if (target.wsUrl === undefined || target.wsUrl === "") throw new Error("Windows 测试网关需要 ws 传输");
		return { transport: "ws", url: target.wsUrl, serverId: target.serverId };
	}
	if (target.socketPath === undefined) throw new Error("POSIX 测试网关需要 unix socket");
	return { transport: "unix", socketPath: target.socketPath, serverId: target.serverId };
}

/** 每个测试一个网关实例：memory 存储 + faux provider + 临时 socket（POSIX）+ 随机 WS 端口。 */
export async function makeGateway(): Promise<TestGateway> {
	const dir = await mkdtemp(join(tmpdir(), "neko-gateway-test-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
	const serverId = randomUUID();
	const socketPath = testSocketPath(dir);
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath,
		port: 0,
		serverId,
		mobileNetwork: { wsl: null },
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	return { gateway, dir, faux, socketPath: socketPath ?? undefined, wsUrl: gateway.wsUrl ?? "", serverId };
}

export async function cleanup(target: TestGateway): Promise<void> {
	await target.gateway.close().catch(() => {});
	await removeDir(target.dir);
}

/** 轮询直到 predicate 为真；超时给出生动的错误信息。 */
export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
