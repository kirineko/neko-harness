import { expect } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../../test/faux.ts";
import { rm } from "../../../../test/temp-dir.ts";
import type { NekoGatewayConnection } from "../../src/client-session.ts";
import { type NekoGateway, startGateway } from "../../src/index.ts";
import { connectTestClient, testSocketPath } from "../helpers.ts";
import { connectMobileWs, type MobileWsClient } from "./ws-client.ts";

/** 端到端移动 API 测试夹具：真实 gateway + faux provider + 已开启的移动入口。 */
export type MobileHarness = {
	readonly gateway: NekoGateway;
	/** 以同一数据目录重启 gateway（sqlite 存储时会话与回执保留）。 */
	restart(): Promise<void>;
	readonly faux: FauxProviderHandle;
	readonly port: number;
	readonly dir: string;
	desktop(): Promise<NekoGatewayConnection>;
	pair(): Promise<MobileDevice>;
	connect(device: MobileDevice): Promise<MobileRpc>;
	close(): Promise<void>;
};

export type MobileDevice = { readonly deviceId: string; readonly credential: string };

export type RpcError = Error & { readonly code: string };

export type MobileRpc = {
	readonly ws: MobileWsClient;
	call<T = Record<string, unknown>>(method: string, params: unknown): Promise<T>;
	notification(
		method: string,
		predicate?: (params: Record<string, unknown>) => boolean,
	): Promise<Record<string, unknown>>;
	/** 已收到但尚未被消费的通知。 */
	readonly notifications: Array<{ method: string; params: Record<string, unknown> }>;
	close(): Promise<void>;
};

async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no address assigned");
	const { port } = address;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; body: string }> {
	const payload = Buffer.from(JSON.stringify(body), "utf8");
	return new Promise((resolve, reject) => {
		const request = httpsRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				rejectUnauthorized: false,
				headers: { "content-type": "application/json", "content-length": payload.byteLength },
			},
			(response) => {
				let text = "";
				response.on("data", (chunk: Buffer) => {
					text += chunk.toString("utf8");
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
			},
		);
		request.on("error", reject);
		request.end(payload);
	});
}

export async function startMobileHarness(
	options: { readonly models?: Parameters<typeof fauxProvider>[0]; readonly storage?: "memory" | "sqlite" } = {},
): Promise<MobileHarness> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "neko-mobile-chat-")));
	const faux = fauxProvider(options.models);
	const launch = () =>
		startGateway({
			storage: options.storage ?? "memory",
			storagePath: join(dir, "neko.sqlite"),
			socketPath: testSocketPath(dir),
			port: 0,
			mobileServerName: "TestPC",
			mobileNetwork: { wsl: null },
			model: { provider: "faux", modelId: options.models?.models?.[0]?.id ?? "faux-1" },
			providers: [faux.provider],
		});
	let gateway = await launch();
	const port = await freePort();
	await gateway.mobile.enable({ address: "127.0.0.1", port });
	const desktops: NekoGatewayConnection[] = [];
	const rpcs: MobileRpc[] = [];
	const disconnectAll = async () => {
		for (const rpc of rpcs.splice(0)) rpc.ws.terminate();
		for (const desktop of desktops.splice(0)) await desktop.close().catch(() => undefined);
	};
	return {
		get gateway() {
			return gateway;
		},
		async restart() {
			await disconnectAll();
			await gateway.close();
			gateway = await launch();
			expect(gateway.mobile.state).toMatchObject({ status: "listening", port });
		},
		faux,
		port,
		dir,
		async desktop() {
			const connection = await connectTestClient(gateway);
			desktops.push(connection);
			return connection;
		},
		async pair() {
			const text = gateway.mobile.createPairing().pairingText;
			const payload = JSON.parse(Buffer.from(text.slice("nekopair:1:".length), "base64url").toString("utf8")) as {
				sid: string;
				code: string;
			};
			const device = { deviceId: randomUUID(), credential: randomBytes(32).toString("base64url") };
			const response = await post(port, "/mobile/v1/pair", {
				v: 1,
				sid: payload.sid,
				code: payload.code,
				pairRequestId: randomUUID(),
				deviceId: device.deviceId,
				deviceName: "Pixel",
				credential: device.credential,
			});
			expect(response.status).toBe(200);
			return device;
		},
		async connect(device) {
			const rpc = await connectRpc(port, device);
			rpcs.push(rpc);
			return rpc;
		},
		async close() {
			await disconnectAll();
			await gateway.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export async function connectRpc(port: number, device: MobileDevice): Promise<MobileRpc> {
	const ws = await connectMobileWs(port, { Authorization: `Neko-Device ${device.deviceId}.${device.credential}` });
	let nextId = 0;
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const waiters: Array<{
		method: string;
		predicate: (params: Record<string, unknown>) => boolean;
		resolve: (params: Record<string, unknown>) => void;
	}> = [];
	let closed = false;
	const pump = async () => {
		while (!closed) {
			const message = (await ws.nextMessage()) as {
				id?: number;
				method?: string;
				params?: Record<string, unknown>;
				result?: unknown;
				error?: { message: string; data?: { code: string } };
			};
			if (message.method !== undefined) {
				const params = message.params ?? {};
				const index = waiters.findIndex((waiter) => waiter.method === message.method && waiter.predicate(params));
				if (index >= 0) {
					const [waiter] = waiters.splice(index, 1);
					waiter?.resolve(params);
				} else notifications.push({ method: message.method, params });
				continue;
			}
			const entry = message.id === undefined ? undefined : pending.get(message.id);
			if (entry === undefined) continue;
			pending.delete(message.id as number);
			if (message.error !== undefined) {
				const error = new Error(`${message.error.data?.code ?? "error"}: ${message.error.message}`) as RpcError;
				(error as { code: string }).code = message.error.data?.code ?? "error";
				entry.reject(error);
			} else entry.resolve(message.result);
		}
	};
	const rpc: MobileRpc = {
		ws,
		notifications,
		call(method, params) {
			const id = ++nextId;
			ws.send({ jsonrpc: "2.0", id, method, params });
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			});
		},
		notification(method, predicate = () => true) {
			const index = notifications.findIndex((entry) => entry.method === method && predicate(entry.params));
			if (index >= 0) {
				const [entry] = notifications.splice(index, 1);
				return Promise.resolve(entry?.params ?? {});
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 10_000);
				waiters.push({
					method,
					predicate,
					resolve: (params) => {
						clearTimeout(timer);
						resolve(params);
					},
				});
			});
		},
		async close() {
			closed = true;
			ws.close(1000, "done");
			await ws.waitForClose();
		},
	};
	const hello = rpc.call("server.hello", {
		apiVersions: [1],
		app: { version: "1.0.0", platform: "android", build: "test" },
	});
	void pump().catch(() => undefined);
	await hello;
	return rpc;
}

export async function rpcError(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		return (error as RpcError).code;
	}
	throw new Error("expected the call to fail");
}

export async function eventually(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000) {
	const start = Date.now();
	while (!(await check())) {
		if (Date.now() - start > timeout) throw new Error(`timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
