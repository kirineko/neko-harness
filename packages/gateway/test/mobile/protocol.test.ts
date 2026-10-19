import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { RUNNING_VERSION } from "@neko-harness/core/application-version";
import { rm } from "../../../../test/temp-dir.ts";
import { type NekoGateway, startGateway } from "../../src/index.ts";
import { MOBILE_API_VERSIONS, MOBILE_CAPABILITIES, MOBILE_LIMITS } from "../../src/mobile/protocol.ts";
import { testSocketPath } from "../helpers.ts";
import { connectMobileWs } from "./ws-client.ts";

function credential(): string {
	return randomBytes(32).toString("base64url");
}

function hello(id: number, apiVersions: readonly number[], version = "1.0.0") {
	return {
		jsonrpc: "2.0",
		id,
		method: "server.hello",
		params: { apiVersions, app: { version, platform: "android", build: "test" } },
	};
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

async function startEnabledGateway(dir: string) {
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
	});
	const port = await freePort();
	await gateway.mobile.enable({ address: "127.0.0.1", port });
	return { gateway, port };
}

async function pairDevice(gateway: NekoGateway, port: number): Promise<{ deviceId: string; credential: string }> {
	const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
	const deviceId = randomUUID();
	const secret = credential();
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

async function connectPaired(
	port: number,
	device: { deviceId: string; credential: string },
): Promise<import("./ws-client.ts").MobileWsClient> {
	return connectMobileWs(port, { Authorization: `Neko-Device ${device.deviceId}.${device.credential}` });
}

async function expectCloseBeforeMessage(
	client: import("./ws-client.ts").MobileWsClient,
): Promise<{ readonly code: number }> {
	const outcome = await Promise.race([
		client.waitForClose().then((close) => ({ close })),
		client.nextMessage().then((message) => ({ message })),
	]);
	if ("message" in outcome) throw new Error(`expected close, received message: ${JSON.stringify(outcome.message)}`);
	return outcome.close;
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-protocol-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("mobile server.hello", () => {
	it("negotiates the api version and reports identity, capabilities, and exact limits", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectPaired(port, device);
			client.send(hello(1, [1, 2], "999.0.0-beta.1"));
			const response = (await client.nextMessage()) as Record<string, unknown>;
			expect(response).toEqual({
				jsonrpc: "2.0",
				id: 1,
				result: {
					apiVersion: 1,
					serverId: gateway.serverId,
					serverName: "TestPC",
					gatewayVersion: RUNNING_VERSION,
					capabilities: MOBILE_CAPABILITIES,
					limits: MOBILE_LIMITS,
				},
			});
			expect(MOBILE_LIMITS).toEqual({
				maxFrameBytes: 262_144,
				maxPayloadBytes: 131_072,
				pageItems: 50,
				chunkBytes: 65_536,
				maxConcurrentRequests: 8,
				maxSendBufferBytes: 2_097_152,
			});
			expect(MOBILE_API_VERSIONS).toEqual([1]);
			client.close(1000, "done");
			await client.waitForClose();
		} finally {
			await gateway.close();
		}
	});

	it("closes the connection when any other method arrives before hello", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectPaired(port, device);
			client.send({ jsonrpc: "2.0", id: 1, method: "sessions.list", params: {} });
			const close = await expectCloseBeforeMessage(client);
			expect(close.code).toBe(1002);
		} finally {
			await gateway.close();
		}
	});

	it("rejects newer-only clients as incompatible and points at the computer", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectPaired(port, device);
			client.send(hello(7, [2]));
			const response = (await client.nextMessage()) as { error: { data: Record<string, unknown> } };
			expect(response.error.data).toEqual({ code: "incompatible", needs: "computer" });
			const close = await client.waitForClose();
			expect(close.code).toBe(4402);
		} finally {
			await gateway.close();
		}
	});

	it("rejects older-only clients as incompatible and points at the app", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectPaired(port, device);
			client.send(hello(9, [0]));
			const response = (await client.nextMessage()) as { error: { data: Record<string, unknown> } };
			expect(response.error.data).toEqual({ code: "incompatible", needs: "app" });
		} finally {
			await gateway.close();
		}
	});

	it("answers malformed hello params with invalid_params and closes", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectPaired(port, device);
			client.send({ jsonrpc: "2.0", id: 3, method: "server.hello", params: { apiVersions: [], app: { version: 1 } } });
			const response = (await client.nextMessage()) as { error: { code: number; data: Record<string, unknown> } };
			expect(response.error.code).toBe(-32_602);
			expect(response.error.data).toEqual({ code: "invalid_params" });
			const close = await client.waitForClose();
			expect(close.code).toBe(1002);
		} finally {
			await gateway.close();
		}
	});

	it("responds not_found for unknown methods after hello without hanging", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectPaired(port, device);
			client.send(hello(1, [1]));
			await client.nextMessage();
			client.send({ jsonrpc: "2.0", id: 2, method: "fs.readFile", params: { path: "/etc/passwd" } });
			const first = (await client.nextMessage()) as { id: number; error: { code: number; data: { code: string } } };
			expect(first.id).toBe(2);
			expect(first.error.code).toBe(-32_601);
			expect(first.error.data.code).toBe("not_found");
			client.send({ jsonrpc: "2.0", id: 3, method: "credentials.state", params: null });
			const second = (await client.nextMessage()) as { id: number; error: { data: { code: string } } };
			expect(second.id).toBe(3);
			expect(second.error.data.code).toBe("not_found");
			client.close(1000, "done");
			await client.waitForClose();
		} finally {
			await gateway.close();
		}
	});

	it("closes only the offending connection on invalid JSON or non-request frames", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const first = await pairDevice(gateway, port);
			const second = await pairDevice(gateway, port);
			const broken = await connectPaired(port, first);
			const healthy = await connectPaired(port, second);

			broken.sendText("this is not json");
			const close = await broken.waitForClose();
			expect(close.code).toBe(1003);

			const other = await connectPaired(port, first);
			other.sendText("42");
			const otherClose = await other.waitForClose();
			expect(otherClose.code).toBe(1002);

			healthy.send(hello(1, [1]));
			const response = (await healthy.nextMessage()) as { result: { apiVersion: number } };
			expect(response.result.apiVersion).toBe(1);
			healthy.close(1000, "done");
			await healthy.waitForClose();
		} finally {
			await gateway.close();
		}
	});
});
