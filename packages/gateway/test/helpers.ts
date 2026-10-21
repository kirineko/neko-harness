import { afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryLinkPair } from "@earendil-works/chord";
import { type FauxProviderHandle, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDir } from "../../../test/temp-dir.ts";
import {
	connectNekoGateway,
	connectNekoGatewayLink,
	type NekoGateway,
	type NekoGatewayAddress,
	type NekoGatewayClient,
	startGateway,
} from "../src/index.ts";

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

type GatewayTarget = NekoGateway | { readonly gateway: NekoGateway };

const openGateways = new Set<NekoGateway>();
const openClients = new Set<NekoGatewayClient>();

function gatewayOf(target: GatewayTarget): NekoGateway {
	return "gateway" in target ? target.gateway : target;
}

/**
 * 连接进程内网关。Windows 上 Bun 在同一进程内同时作为 WebSocket 服务端与客户端会丢帧或乱序，
 * 故 Windows 用 chord 内存链路直接接入（WS 传输由跨进程启动测试覆盖）；POSIX 仍走 Unix socket。
 */
export async function connectTestClient(target: GatewayTarget): Promise<NekoGatewayClient> {
	const gateway = gatewayOf(target);
	openGateways.add(gateway);
	const client = IS_WINDOWS ? await connectInMemory(gateway) : await connectNekoGateway(testAddress(gateway));
	openClients.add(client);
	return client;
}

/** 显式要求 WebSocket 一侧的用例：POSIX 走真实 WS，Windows 同样改走内存链路。 */
export async function connectTestWsClient(target: GatewayTarget): Promise<NekoGatewayClient> {
	const gateway = gatewayOf(target);
	if (IS_WINDOWS) return connectTestClient(gateway);
	openGateways.add(gateway);
	if (gateway.wsUrl === undefined) throw new Error("测试网关未启用 ws 传输");
	const client = await connectNekoGateway({ transport: "ws", url: gateway.wsUrl, serverId: gateway.serverId });
	openClients.add(client);
	return client;
}

async function connectInMemory(gateway: NekoGateway): Promise<NekoGatewayClient> {
	const [clientEnd, serverEnd] = memoryLinkPair();
	gateway.accept(serverEnd);
	return connectNekoGatewayLink(clientEnd, gateway.serverId);
}

/** 登记由测试自行启动的网关，使其在测试结束时有界关闭。 */
export function trackGateway(gateway: NekoGateway): NekoGateway {
	openGateways.add(gateway);
	return gateway;
}

const CLOSE_LIMIT_MS = 2000;

async function boundedClose(close: () => Promise<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			close().catch(() => {}),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, CLOSE_LIMIT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// Bun 的测试超时不取消测试体，但会运行 afterEach；这里释放仍未关闭的客户端与网关，避免残留 WS 服务使进程挂死。
afterEach(async () => {
	const clients = [...openClients];
	const gateways = [...openGateways];
	openClients.clear();
	openGateways.clear();
	await Promise.all(clients.map((client) => boundedClose(() => client.close())));
	await Promise.all(gateways.map((gateway) => boundedClose(() => gateway.close())));
});

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
		timings: { jobStartWindowMs: 500 },
	});
	trackGateway(gateway);
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
