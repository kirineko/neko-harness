import "./support/lang-en.ts";
import { expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { APPLICATION_PROTOCOL, ApplicationProtocolError } from "@neko-harness/core/application-version";
import { startGateway } from "@neko-harness/gateway";
import { WebSocketServer } from "ws";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { waitFor } from "../../gateway/test/helpers.ts";
import { connectToGateway } from "../src/gateway.ts";

// Exercise the Windows discovery branch without changing process.platform. Service handshakes use real WS.
async function target(protocolVersion = APPLICATION_PROTOCOL) {
	const dir = await mkdtemp(join(tmpdir(), "neko-tui-start-"));
	const serverId = randomUUID();
	const storagePath = join(dir, "session.sqlite");
	const portFile = join(dir, `${serverId}.port`);
	await writeFile(join(dir, "gateway-server-id"), serverId);
	const gateway = await startGateway({
		storage: "memory",
		storagePath,
		socketPath: null,
		port: 0,
		serverId,
		cwd: dir,
		providers: [fauxProvider().provider],
		model: { provider: "faux", modelId: "faux-1" },
		updates: { protocolVersion },
	});
	return {
		gateway,
		portFile,
		options: { platform: "win32" as const, configDir: dir, storagePath, spawnTimeoutMs: 2_000 },
		async close() {
			await gateway.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

class TestChild extends EventEmitter {
	pid = -1;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill(): boolean {
		this.signalCode = "SIGTERM";
		this.emit("exit", null, "SIGTERM");
		return true;
	}
}

function mockSpawn(onSpawn: (child: TestChild) => void = () => {}) {
	const child = new TestChild();
	const kill = spyOn(child, "kill").mockImplementation(() => {
		child.signalCode = "SIGTERM";
		child.emit("exit", null, "SIGTERM");
		return true;
	});
	const spawn = spyOn(childProcess, "spawn").mockImplementation(
		new Proxy(childProcess.spawn, {
			apply() {
				onSpawn(child);
				return child;
			},
		}),
	);
	return { child, kill, spawn, restore: () => spawn.mockRestore() };
}

async function deadUrl(): Promise<string> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `ws://127.0.0.1:${address.port}`;
}

it("rereads a stale port file after spawning and connects to the newly written address", async () => {
	const fresh = await target();
	await writeFile(fresh.portFile, await deadUrl());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const child = mockSpawn(() => {
		timer = setTimeout(() => writeFileSync(fresh.portFile, fresh.gateway.wsUrl!), 200);
	});
	try {
		const connection = await connectToGateway(fresh.options);
		try {
			expect(connection.spawned).toBe(true);
			expect((await connection.client.models.list(null)).length).toBeGreaterThan(0);
			expect(child.spawn).toHaveBeenCalledTimes(1);
		} finally {
			await connection.close();
		}
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(existsSync(fresh.portFile)).toBe(false);
	} finally {
		clearTimeout(timer);
		child.restore();
		await fresh.close();
	}
});

it("reuses a live Windows gateway without spawning or deleting its address on close", async () => {
	const fresh = await target();
	await writeFile(fresh.portFile, fresh.gateway.wsUrl!);
	const child = mockSpawn();
	try {
		const connection = await connectToGateway(fresh.options);
		expect(connection.spawned).toBe(false);
		await connection.close();
		expect(child.spawn).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
		expect(existsSync(fresh.portFile)).toBe(true);
	} finally {
		child.restore();
		await fresh.close();
	}
});

for (const phase of ["HTTP", "Chord"] as const) {
	for (const at of ["reuse", "spawn"] as const) {
		it(`bounds a stalled ${phase} handshake during ${at} and releases its socket`, async () => {
			const fresh = await target();
			const sockets = new Set<Socket>();
			let accepted = 0;
			const server = createServer();
			server.on("connection", (socket) => {
				accepted++;
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
			});
			const ws = phase === "Chord" ? new WebSocketServer({ server }) : undefined;
			if (!ws) server.on("upgrade", (_request, socket) => socket.resume());
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing address");
			const stalled = `ws://127.0.0.1:${address.port}`;
			await writeFile(fresh.portFile, at === "reuse" ? stalled : await deadUrl());
			const child = mockSpawn(() => {
				writeFileSync(fresh.portFile, at === "reuse" ? fresh.gateway.wsUrl! : stalled);
			});
			try {
				const started = Date.now();
				const pending = connectToGateway({ ...fresh.options, spawnTimeoutMs: 200 });
				if (at === "reuse") {
					const connection = await pending;
					expect(connection.spawned).toBe(true);
					await connection.close();
				} else {
					await expect(pending).rejects.toThrow("timed out");
					// No successful handshake established ownership of this record; preserve it.
					expect(existsSync(fresh.portFile)).toBe(true);
				}
				expect(Date.now() - started).toBeLessThan(1_500);
				expect(accepted).toBeGreaterThan(0);
				expect(child.kill).toHaveBeenCalledTimes(1);
				await waitFor(() => sockets.size === 0, "timed-out TUI socket released", 1_000);
			} finally {
				child.restore();
				for (const socket of sockets) socket.destroy();
				await new Promise<void>((resolve) => (ws ? ws.close(() => resolve()) : resolve()));
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await fresh.close();
			}
		});
	}
}

for (const at of ["reuse", "spawn"] as const) {
	it(`keeps protocol incompatibility fatal during ${at}`, async () => {
		const fresh = await target(APPLICATION_PROTOCOL + 1);
		await writeFile(fresh.portFile, at === "reuse" ? fresh.gateway.wsUrl! : await deadUrl());
		const child = mockSpawn(() => writeFileSync(fresh.portFile, fresh.gateway.wsUrl!));
		try {
			await expect(connectToGateway(fresh.options)).rejects.toBeInstanceOf(ApplicationProtocolError);
			expect(child.spawn).toHaveBeenCalledTimes(at === "reuse" ? 0 : 1);
			expect(child.kill).toHaveBeenCalledTimes(at === "reuse" ? 0 : 1);
		} finally {
			child.restore();
			await fresh.close();
		}
	});
}

it("treats a running gateway on another Chord protocol version as fatal and does not spawn a competitor", async () => {
	const fresh = await target();
	const legacy = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => legacy.once("listening", resolve));
	legacy.on("connection", (socket) => {
		socket.send(JSON.stringify({ t: "hello", name: "legacy", kind: "host", epoch: 1 }));
		socket.on("error", () => {});
	});
	const address = legacy.address();
	if (!address || typeof address === "string") throw new Error("Missing address");
	await writeFile(fresh.portFile, `ws://127.0.0.1:${address.port}`);
	const child = mockSpawn(() => writeFileSync(fresh.portFile, fresh.gateway.wsUrl!));
	try {
		await expect(connectToGateway(fresh.options)).rejects.toBeInstanceOf(ApplicationProtocolError);
		expect(child.spawn).not.toHaveBeenCalled();
	} finally {
		child.restore();
		for (const client of legacy.clients) client.terminate();
		await new Promise<void>((resolve) => legacy.close(() => resolve()));
		await fresh.close();
	}
});

for (const file of ["identity", "port"] as const) {
	it(`reports a signal-terminated child promptly while waiting for its ${file} file`, async () => {
		const fresh = await target();
		await rm(fresh.portFile, { force: true });
		if (file === "identity") await rm(join(dirname(fresh.options.storagePath), "gateway-server-id"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const child = mockSpawn((process) => {
			timer = setTimeout(() => {
				process.signalCode = "SIGTERM";
				process.emit("exit", null, "SIGTERM");
			}, 50);
		});
		try {
			const started = Date.now();
			await expect(connectToGateway(fresh.options)).rejects.toThrow("signal SIGTERM");
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(child.kill).not.toHaveBeenCalled();
		} finally {
			clearTimeout(timer);
			child.restore();
			await fresh.close();
		}
	});
}
