import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { join } from "node:path";
import { connectNekoGateway, startGateway } from "@neko-harness/gateway";
import { WebSocketServer } from "ws";
import { cleanup, IS_WINDOWS, makeGateway, testAddress, waitFor } from "../../gateway/test/helpers.ts";
import { ensureNekoGateway } from "../src/gateway-spawn.ts";

describe.skipIf(IS_WINDOWS)("POSIX Web gateway readiness", () => {
	it("rejects a live Unix-only gateway without disturbing its client", async () => {
		const target = await makeGateway();
		await target.gateway.close();
		const unixOnly = await startGateway({
			storage: "memory",
			storagePath: join(target.dir, "unix-only.sqlite"),
			socketPath: target.socketPath!,
			serverId: target.serverId,
			port: null,
			model: { provider: "faux", modelId: "faux-1" },
			providers: [target.faux.provider],
		});
		const client = await connectNekoGateway(testAddress(target));
		try {
			await expect(
				ensureNekoGateway({
					storagePath: join(target.dir, "unused.sqlite"),
					serverId: target.serverId,
					socketPath: target.socketPath!,
					port: Number(new URL(target.wsUrl).port),
					spawnTimeoutMs: 500,
				}),
			).rejects.toThrow("请正常退出原网关");
			expect((await client.models.list(null)).length).toBeGreaterThan(0);
			expect(existsSync(join(target.dir, "unused.sqlite"))).toBe(false);
		} finally {
			await client.close();
			await unixOnly.close();
			await cleanup(target);
		}
	});

	it("validates a custom WS address and rejects another gateway's identity", async () => {
		const target = await makeGateway();
		const other = await makeGateway();
		const client = await connectNekoGateway(testAddress(target));
		const options = {
			storagePath: join(target.dir, "unused.sqlite"),
			serverId: target.serverId,
			socketPath: target.socketPath!,
			host: "127.0.0.1",
			port: Number(new URL(target.wsUrl).port),
			spawnTimeoutMs: 500,
		};
		try {
			const reused = await ensureNekoGateway(options);
			expect(reused.wsUrl).toBe(target.wsUrl);
			expect(reused.spawned).toBeNull();
			await reused.close();
			await expect(ensureNekoGateway({ ...options, port: Number(new URL(other.wsUrl).port) })).rejects.toThrow(
				`WebSocket ${other.wsUrl} 不可用或身份不匹配`,
			);
			expect((await client.models.list(null)).length).toBeGreaterThan(0);
			expect(existsSync(options.storagePath)).toBe(false);
		} finally {
			await client.close();
			await cleanup(other);
			await cleanup(target);
		}
	});

	for (const phase of ["HTTP", "Chord"] as const) {
		it(`bounds a stalled ${phase} handshake and releases its socket`, async () => {
			const target = await makeGateway();
			const sockets = new Set<Socket>();
			let accepted = 0;
			// HTTP: a TCP peer that never replies to the upgrade; Chord: upgrade but never send hello/service state.
			// The HTTP stall uses a raw server because Bun 1.4.4 never emits 'close' for a node:http upgrade socket.
			const httpServer = phase === "Chord" ? createServer() : undefined;
			const ws = httpServer ? new WebSocketServer({ server: httpServer }) : undefined;
			const server: NetServer = httpServer ?? createNetServer((socket) => void socket.resume());
			server.on("connection", (socket) => {
				accepted++;
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing TCP address");
			try {
				const started = Date.now();
				await expect(
					ensureNekoGateway({
						storagePath: join(target.dir, "unused.sqlite"),
						serverId: target.serverId,
						socketPath: target.socketPath!,
						port: address.port,
						spawnTimeoutMs: 200,
					}),
				).rejects.toThrow("请检查 --gateway-port");
				expect(Date.now() - started).toBeLessThan(1_000);
				expect(accepted).toBe(1);
				await waitFor(() => sockets.size === 0, "probe socket released", 1_000);
				expect(existsSync(join(target.dir, "unused.sqlite"))).toBe(false);
			} finally {
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => (ws ? ws.close(() => resolve()) : resolve()));
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await cleanup(target);
			}
		});
	}

	it("waits for WS after Unix is ready and cleans up its child on timeout", async () => {
		const target = await makeGateway();
		await target.gateway.close();
		const originalKey = process.env.DEEPSEEK_API_KEY;
		process.env.DEEPSEEK_API_KEY = "unused-startup-test";
		let child: childProcess.ChildProcess | undefined;
		const originalSpawn = childProcess.spawn;
		const spawn = spyOn(childProcess, "spawn").mockImplementation(
			new Proxy(originalSpawn, {
				apply(target, thisArg, args) {
					child = Reflect.apply(target, thisArg, args);
					return child;
				},
			}),
		);
		let unixReady = false;
		try {
			await expect(
				ensureNekoGateway({
					storagePath: join(target.dir, "child.sqlite"),
					credentialsPath: join(target.dir, "credentials.json"),
					serverId: target.serverId,
					socketPath: target.socketPath!,
					// CLI port 0 disables WS while keeping Unix; Web must never report success.
					port: 0,
					spawnTimeoutMs: 1_000,
					onLog: (line) => {
						if (line.includes("Unix socket:")) unixReady = true;
					},
				}),
			).rejects.toThrow("WebSocket ws://127.0.0.1:0");
			expect(unixReady).toBe(true);
			expect(child).toBeDefined();
			expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
			expect(existsSync(target.socketPath!)).toBe(false);
		} finally {
			spawn.mockRestore();
			child?.kill();
			if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = originalKey;
			await cleanup(target);
		}
	}, 5_000);
});
