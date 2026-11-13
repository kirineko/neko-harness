import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { type NekoGateway, startGateway } from "../../gateway/src/index.ts";
import { IS_WINDOWS } from "../../gateway/test/helpers.ts";
import type { GatewayHandle } from "../src/gateway-spawn.ts";
import { createMobileAdminCaller, MobileAdminAbortedError, MobileAdminTimeoutError } from "../src/mobile-admin.ts";
import { startWebServer } from "../src/server.ts";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not finish in ${ms}ms`)), ms)),
	]);
}

describe("mobile admin caller bounds", () => {
	let dir: string;
	let silent: NetServer;
	const sockets = new Set<Socket>();
	let wsUrl: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "neko-web-caller-"));
		silent = createNetServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
		});
		await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
		const address = silent.address();
		if (typeof address !== "object" || address === null) throw new Error("no address");
		wsUrl = `ws://127.0.0.1:${address.port}`;
	});
	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	});

	const gatewayAt = (): GatewayHandle => ({
		serverId: randomUUID(),
		socketPath: undefined,
		wsUrl,
		spawned: null,
		async close() {},
	});

	it("rejects with a timeout when the gateway never answers", async () => {
		const caller = createMobileAdminCaller(gatewayAt(), dir, { callTimeoutMs: 150, enableTimeoutMs: 150 });
		await expect(within(caller("state", null), 3_000, "state")).rejects.toBeInstanceOf(MobileAdminTimeoutError);
	});

	it("cancels in-flight calls on abortAll", async () => {
		const caller = createMobileAdminCaller(gatewayAt(), dir, { callTimeoutMs: 10_000 });
		const pending = caller("state", null);
		pending.catch(() => undefined);
		await wait(100);
		caller.abortAll?.();
		await expect(within(pending, 1_000, "state")).rejects.toBeInstanceOf(MobileAdminAbortedError);
	});
});

describe("web server shutdown", () => {
	let dir: string;
	let gateway: NekoGateway;
	let serverId: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "neko-web-shutdown-"));
		serverId = randomUUID();
		await writeFile(join(dir, "gateway-server-id"), `${serverId}\n`, { mode: 0o600 });
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
		gateway = await startGateway({
			storage: "memory",
			storagePath: join(dir, "neko.sqlite"),
			socketPath: IS_WINDOWS ? null : join(dir, `${serverId}.sock`),
			port: 0,
			serverId,
			model: { provider: "faux", modelId: "faux-1" },
			providers: [faux.provider],
		});
	});
	afterEach(async () => {
		await gateway.close().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	});

	const options = (extra: { signal?: AbortSignal } = {}) => ({
		port: 0,
		staticDir: dir,
		...extra,
		gateway: {
			storagePath: join(dir, "neko.sqlite"),
			serverId,
			...(IS_WINDOWS ? {} : { socketPath: join(dir, `${serverId}.sock`) }),
			port: Number(new URL(gateway.wsUrl ?? "ws://127.0.0.1:0").port),
			spawnTimeoutMs: 5_000,
		},
	});

	it("closes promptly with an idle keep-alive connection and a half-sent request, and is idempotent", async () => {
		const web = await startWebServer(options());
		const open: Socket[] = [];
		const closed: Promise<void>[] = [];
		const connect = (payload: string) =>
			new Promise<Socket>((resolve) => {
				const socket = new Socket();
				socket.on("error", () => {});
				socket.resume();
				socket.connect(web.port, "127.0.0.1", () => {
					socket.write(payload);
					resolve(socket);
				});
				open.push(socket);
				closed.push(new Promise<void>((done) => socket.once("close", () => done())));
			});
		await connect(`GET /missing HTTP/1.1\r\nHost: 127.0.0.1:${web.port}\r\nConnection: keep-alive\r\n\r\n`);
		await connect(`GET /api/info HTTP/1.1\r\nHost: 127.0.0.1:${web.port}\r\n`);
		await wait(150);
		const first = web.close();
		const second = web.close();
		expect(second).toBe(first);
		await within(first, 3_000, "web.close");
		await within(Promise.all(closed), 1_000, "client sockets closing");
		expect(open.every((socket) => socket.destroyed)).toBe(true);
	});

	it("abandons startup when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const unusedDir = await mkdtemp(join(tmpdir(), "neko-web-abort-"));
		try {
			await expect(
				startWebServer({
					port: 0,
					staticDir: dir,
					signal: controller.signal,
					gateway: {
						storagePath: join(unusedDir, "neko.sqlite"),
						serverId: randomUUID(),
						...(IS_WINDOWS ? {} : { socketPath: join(unusedDir, "x.sock") }),
						port: 1,
						spawnTimeoutMs: 5_000,
					},
				}),
			).rejects.toThrow("启动被中断");
		} finally {
			await rm(unusedDir, { recursive: true, force: true });
		}
	});
});
