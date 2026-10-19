import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { rm } from "../../../../test/temp-dir.ts";
import { connectNekoGateway, type NekoGateway, startGateway } from "../../src/index.ts";
import { MobileGateway } from "../../src/mobile/listener.ts";
import { MobileStore } from "../../src/mobile/store.ts";
import { testAddress, testSocketPath } from "../helpers.ts";
import { connectMobileWs, type MobileWsClient } from "./ws-client.ts";

function credential(): string {
	return randomBytes(32).toString("base64url");
}

function parsePairingText(pairingText: string): { readonly sid: string; readonly code: string } {
	return JSON.parse(Buffer.from(pairingText.slice("nekopair:1:".length), "base64url").toString("utf8")) as never;
}

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

function mobileRequest(
	port: number,
	path: string,
	method = "GET",
	body?: Buffer,
): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				rejectUnauthorized: false,
				headers: body === undefined ? {} : { "content-type": "application/json", "content-length": body.byteLength },
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
		request.end(body);
	});
}

async function startEnabledGateway(dir: string, onError?: (error: Error) => void) {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath: testSocketPath(dir),
		port: 0,
		mobileServerName: "TestPC",
		mobileNetwork: { wsl: null },
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
		...(onError === undefined ? {} : { onError }),
	});
	const port = await freePort();
	await gateway.mobile.enable({ address: "127.0.0.1", port });
	return { gateway, port };
}

async function pairDevice(
	gateway: NekoGateway,
	port: number,
	overrides: { readonly deviceId?: string; readonly credential?: string } = {},
): Promise<{ deviceId: string; credential: string }> {
	const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
	const deviceId = overrides.deviceId ?? randomUUID();
	const secret = overrides.credential ?? credential();
	const response = await mobileRequest(
		port,
		"/mobile/v1/pair",
		"POST",
		Buffer.from(
			JSON.stringify({
				v: 1,
				sid: payload.sid,
				code: payload.code,
				pairRequestId: randomUUID(),
				deviceId,
				deviceName: "Pixel 9",
				credential: secret,
			}),
			"utf8",
		),
	);
	expect(response.status).toBe(200);
	return { deviceId, credential: secret };
}

async function connectPaired(port: number, device: { deviceId: string; credential: string }): Promise<MobileWsClient> {
	const client = await connectMobileWs(port, { Authorization: `Neko-Device ${device.deviceId}.${device.credential}` });
	client.send({
		jsonrpc: "2.0",
		id: 1,
		method: "server.hello",
		params: { apiVersions: [1], app: { version: "1.0.0", platform: "android", build: "test" } },
	});
	const hello = (await client.nextMessage()) as { result: { apiVersion: number } };
	expect(hello.result.apiVersion).toBe(1);
	return client;
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-adapter-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("mobile adapter connections", () => {
	it("keeps two device connections isolated and both usable", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const first = await pairDevice(gateway, port);
			const second = await pairDevice(gateway, port);
			const firstClient = await connectPaired(port, first);
			const secondClient = await connectPaired(port, second);
			for (const client of [firstClient, secondClient]) {
				client.send({ jsonrpc: "2.0", id: 2, method: "nope.method", params: {} });
				const reply = (await client.nextMessage()) as { error: { data: { code: string } } };
				expect(reply.error.data.code).toBe("not_found");
			}
			firstClient.close(1000, "done");
			secondClient.close(1000, "done");
			expect((await firstClient.waitForClose()).code).toBe(1000);
			expect((await secondClient.waitForClose()).code).toBe(1000);
		} finally {
			await gateway.close();
		}
	});

	it("revoke removes the record, closes its websocket with 4401, and leaves others plus desktop intact", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const revoked = await pairDevice(gateway, port);
			const survivor = await pairDevice(gateway, port);
			const revokedClient = await connectPaired(port, revoked);
			const survivorClient = await connectPaired(port, survivor);
			const desktop = await connectNekoGateway(
				testAddress({ socketPath: gateway.socketPath, wsUrl: gateway.wsUrl ?? "", serverId: gateway.serverId }),
			);
			const desktopModels = await desktop.models.list(null);

			expect(await gateway.mobile.revoke(revoked.deviceId)).toBe(true);
			const close = await revokedClient.waitForClose();
			expect(close.code).toBe(4401);
			expect(close.reason).toBe("revoked");

			survivorClient.send({ jsonrpc: "2.0", id: 5, method: "another.unknown", params: {} });
			const reply = (await survivorClient.nextMessage()) as { error: { data: { code: string } } };
			expect(reply.error.data.code).toBe("not_found");
			expect((await desktop.models.list(null)).length).toBe(desktopModels.length);

			const store = await MobileStore.open(dir);
			const state = store.getState();
			expect(state.devices.map((device) => device.deviceId)).toEqual([survivor.deviceId]);
			expect(await gateway.mobile.revoke(revoked.deviceId)).toBe(false);

			survivorClient.close(1000, "done");
			await survivorClient.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("revoke invokes invalidatePrincipal with a device-only match", async () => {
		const store = await MobileStore.open(dir);
		const deviceId = randomUUID();
		const secret = credential();
		await store.upsertDevice({
			deviceId,
			name: "Pixel 9",
			credentialHash: createHash("sha256").update(secret, "utf8").digest("hex"),
			grantRevision: 1,
			pairedAt: Date.now(),
			lastSeenAt: Date.now(),
		});
		const matches: unknown[] = [];
		const gateway = await MobileGateway.create({
			nekoDir: dir,
			serverId: randomUUID(),
			chord: {
				accept: () => undefined,
				invalidatePrincipal: (match) => {
					matches.push(match);
					return Promise.resolve();
				},
			},
		});
		try {
			expect(await gateway.revoke(deviceId)).toBe(true);
			expect(await gateway.revoke(deviceId)).toBe(false);
			expect(matches).toHaveLength(1);
			const match = matches[0];
			expect(typeof match).toBe("function");
			if (typeof match !== "function") return;
			expect(match({ kind: "mobile", deviceId, grantRevision: 1, connectionId: "c-1" })).toBe(true);
			expect(match({ kind: "mobile", deviceId: "other", grantRevision: 1, connectionId: "c-1" })).toBe(false);
			expect(match({ connectionId: "desktop-1" })).toBe(false);
			expect((await MobileStore.open(dir)).getState().devices).toEqual([]);
		} finally {
			await gateway.close();
		}
	});

	it("re-pairing the same device closes the old connection but keeps the new grant usable", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const deviceId = randomUUID();
			const firstSecret = credential();
			await pairDevice(gateway, port, { deviceId, credential: firstSecret });
			const oldClient = await connectPaired(port, { deviceId, credential: firstSecret });

			const secondSecret = credential();
			const rePaired = await pairDevice(gateway, port, { deviceId, credential: secondSecret });
			expect(rePaired.deviceId).toBe(deviceId);

			const oldClose = await oldClient.waitForClose();
			expect(oldClose.code).toBe(4401);

			const freshClient = await connectPaired(port, { deviceId, credential: secondSecret });
			const state = (await MobileStore.open(dir)).getState();
			expect(state.devices).toHaveLength(1);
			expect(state.devices[0]?.grantRevision).toBe(2);
			expect(state.devices[0]?.credentialHash).toBe(createHash("sha256").update(secondSecret, "utf8").digest("hex"));
			freshClient.close(1000, "done");
			await freshClient.waitForClose();
		} finally {
			await gateway.close();
		}
	});

	it("client close releases the connection without disturbing the runtime or other clients", async () => {
		const errors: string[] = [];
		const errorSpy = spyOn(console, "error");
		const { gateway, port } = await startEnabledGateway(dir, (error) => errors.push(error.message));
		try {
			const first = await pairDevice(gateway, port);
			const second = await pairDevice(gateway, port);
			const leaving = await connectPaired(port, first);
			const staying = await connectPaired(port, second);
			leaving.close(1000, "done");
			expect((await leaving.waitForClose()).code).toBe(1000);

			staying.send({ jsonrpc: "2.0", id: 8, method: "still.alive", params: {} });
			const reply = (await staying.nextMessage()) as { error: { data: { code: string } } };
			expect(reply.error.data.code).toBe("not_found");

			const desktop = await connectNekoGateway(
				testAddress({ socketPath: gateway.socketPath, wsUrl: gateway.wsUrl ?? "", serverId: gateway.serverId }),
			);
			await desktop.close();
			const third = await pairDevice(gateway, port);
			const thirdClient = await connectPaired(port, third);
			thirdClient.close(1000, "done");
			await thirdClient.waitForClose();
		} finally {
			await gateway.close();
			errorSpy.mockRestore();
		}
		expect(errors).toEqual([]);
		expect(errorSpy.mock.calls.length).toBe(0);
	});

	it("disable closes mobile connections before the listener and keeps the desktop transport", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectPaired(port, device);
			await gateway.mobile.disable();
			const close = await client.waitForClose();
			expect(close.code).toBe(1001);
			const desktop = await connectNekoGateway(
				testAddress({ socketPath: gateway.socketPath, wsUrl: gateway.wsUrl ?? "", serverId: gateway.serverId }),
			);
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});
});
