import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { rm } from "../../../../test/temp-dir.ts";
import { type NekoGateway, startGateway } from "../../src/index.ts";
import { AUTH_FAILURE_LIMIT, MobileAuth, type MobileAuthStore } from "../../src/mobile/auth.ts";
import { MobileStore, type MobileStoreState } from "../../src/mobile/store.ts";
import { testSocketPath } from "../helpers.ts";
import { connectMobileWs } from "./ws-client.ts";

function credential(): string {
	return randomBytes(32).toString("base64url");
}

function deviceRecord(deviceId: string, secret: string) {
	return {
		deviceId,
		name: "Pixel 9",
		credentialHash: createHash("sha256").update(secret, "utf8").digest("hex"),
		grantRevision: 1,
		pairedAt: Date.now(),
		lastSeenAt: Date.now(),
	};
}

function fakeRequest(entries: Array<[string, string]>, remoteAddress: string): IncomingMessage {
	return {
		socket: { remoteAddress },
		rawHeaders: entries.flat(),
		headers: {},
	} as unknown as IncomingMessage;
}

function makeClock(start = 1_800_000_000_000) {
	const clock = {
		now: start,
		tick(ms: number): void {
			clock.now += ms;
		},
	};
	return clock;
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

function parsePairingText(pairingText: string): { readonly sid: string; readonly code: string } {
	return JSON.parse(Buffer.from(pairingText.slice("nekopair:1:".length), "base64url").toString("utf8")) as never;
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

function rawUpgrade(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false });
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("rawUpgrade timeout"));
		}, 5_000);
		socket.on("secureConnect", () => {
			const lines = [
				`${method} ${path} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version: 13",
			];
			for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			clearTimeout(timer);
			socket.destroy();
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		socket.on("error", (error: Error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function wsUpgradeResult(
	port: number,
	headers: Record<string, string>,
): Promise<{ readonly statusLine: string; readonly closeCode?: number }> {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false });
		const chunks: Buffer[] = [];
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				socket.destroy();
				reject(new Error("wsUpgradeResult timeout"));
			}
		}, 5_000);
		const finish = (result: { statusLine: string; closeCode?: number }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		socket.on("secureConnect", () => {
			const lines = [
				"GET /mobile/v1/ws HTTP/1.1",
				`Host: 127.0.0.1:${port}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version: 13",
			];
			for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
		});
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			const buffer = Buffer.concat(chunks);
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const statusLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("utf8");
			if (!statusLine.startsWith("HTTP/1.1 101")) {
				finish({ statusLine });
				return;
			}
			const frame = buffer.subarray(headerEnd + 4);
			if (frame.length < 2 || (frame[0] ?? 0) % 16 !== 0x8) return;
			let length = (frame[1] ?? 0) & 0x7f;
			let offset = 2;
			if (length === 126) {
				if (frame.length < 4) return;
				length = frame.readUInt16BE(2);
				offset = 4;
			}
			if (frame.length < offset + length) return;
			finish({ statusLine, closeCode: length >= 2 ? frame.readUInt16BE(offset) : undefined });
		});
		socket.on("error", (error: Error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(error);
			}
		});
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

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-auth-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("mobile auth service", () => {
	it("authenticates a valid Neko-Device authorization", async () => {
		const store = await MobileStore.open(dir);
		const deviceId = randomUUID();
		const secret = credential();
		await store.upsertDevice(deviceRecord(deviceId, secret));
		const auth = new MobileAuth({ store });
		const result = auth.authenticate(fakeRequest([["Authorization", `Neko-Device ${deviceId}.${secret}`]], "10.0.0.1"));
		expect(result).toEqual({ ok: true, deviceId, grantRevision: 1, remoteAddress: "10.0.0.1" });
	});

	it("rejects missing, duplicated, or malformed authorization headers", async () => {
		const store = await MobileStore.open(dir);
		const deviceId = randomUUID();
		const secret = credential();
		await store.upsertDevice(deviceRecord(deviceId, secret));
		const auth = new MobileAuth({ store });
		const header = `Neko-Device ${deviceId}.${secret}`;
		const malformed: Array<Array<[string, string]>> = [
			[],
			[
				["Authorization", header],
				["Authorization", header],
			],
			[["Authorization", "Bearer token"]],
			[["Authorization", "neko-device token"]],
			[["Authorization", `Neko-Device ${deviceId}`]],
			[["Authorization", `Neko-Device ${deviceId}.short`]],
			[["Authorization", `Neko-Device  ${deviceId}.${secret}`]],
			[["Authorization", `${header} `]],
			[["Authorization", `Neko-Device ${deviceId} ${secret}`]],
		];
		for (const entries of malformed) {
			const result = auth.authenticate(fakeRequest(entries, "10.0.0.1"));
			expect(result).toEqual({ ok: false, status: 401, code: "unauthorized" });
		}
	});

	it("keeps unknown devices and wrong credentials indistinguishable", async () => {
		const store = await MobileStore.open(dir);
		const deviceId = randomUUID();
		await store.upsertDevice(deviceRecord(deviceId, credential()));
		const auth = new MobileAuth({ store });
		const unknown = auth.authenticate(
			fakeRequest([["Authorization", `Neko-Device ${randomUUID()}.${credential()}`]], "10.0.0.1"),
		);
		const wrong = auth.authenticate(
			fakeRequest([["Authorization", `Neko-Device ${deviceId}.${credential()}`]], "10.0.0.1"),
		);
		expect(unknown).toEqual({ ok: false, status: 401, code: "unauthorized" });
		expect(wrong).toEqual(unknown);
	});

	it("revoked devices can no longer authenticate", async () => {
		const store = await MobileStore.open(dir);
		const deviceId = randomUUID();
		const secret = credential();
		await store.upsertDevice(deviceRecord(deviceId, secret));
		const auth = new MobileAuth({ store });
		await store.removeDevice(deviceId);
		const result = auth.authenticate(fakeRequest([["Authorization", `Neko-Device ${deviceId}.${secret}`]], "10.0.0.1"));
		expect(result.ok).toBe(false);
	});

	it("fails safely on malformed stored hashes", () => {
		const malformedState = {
			formatVersion: 1,
			enabled: true,
			address: null,
			port: 8323,
			devices: [
				{ deviceId: "dev-1", name: "x", credentialHash: "not-hex!!", grantRevision: 1, pairedAt: 1, lastSeenAt: 1 },
			],
			receipts: [],
		} as unknown as MobileStoreState;
		const malformedStore: MobileAuthStore = { getState: () => malformedState };
		const auth = new MobileAuth({ store: malformedStore });
		const result = auth.authenticate(fakeRequest([["Authorization", `Neko-Device dev-1.${credential()}`]], "10.0.0.1"));
		expect(result).toEqual({ ok: false, status: 401, code: "unauthorized" });
	});

	it("rate limits after twenty failures per source and recovers after the window", () => {
		const clock = makeClock();
		const auth = new MobileAuth({ store: undefined, now: () => clock.now });
		const attempt = () => auth.authenticate(fakeRequest([], "10.0.0.1"));
		for (let index = 0; index < AUTH_FAILURE_LIMIT; index++)
			expect(attempt()).toEqual({ ok: false, status: 401, code: "unauthorized" });
		expect(attempt()).toEqual({ ok: false, status: 429, code: "rate_limited" });
		expect(auth.authenticate(fakeRequest([], "10.0.0.2"))).toEqual({ ok: false, status: 401, code: "unauthorized" });
		clock.tick(61_000);
		expect(attempt()).toEqual({ ok: false, status: 401, code: "unauthorized" });
	});

	it("never spends the failure budget on successes", async () => {
		const store = await MobileStore.open(dir);
		const deviceId = randomUUID();
		const secret = credential();
		await store.upsertDevice(deviceRecord(deviceId, secret));
		const auth = new MobileAuth({ store });
		for (let index = 0; index < AUTH_FAILURE_LIMIT - 1; index++) auth.authenticate(fakeRequest([], "10.0.0.1"));
		const success = auth.authenticate(
			fakeRequest([["Authorization", `Neko-Device ${deviceId}.${secret}`]], "10.0.0.1"),
		);
		expect(success.ok).toBe(true);
		const twentieth = auth.authenticate(fakeRequest([], "10.0.0.1"));
		expect(twentieth).toEqual({ ok: false, status: 401, code: "unauthorized" });
		expect(auth.authenticate(fakeRequest([], "10.0.0.1"))).toEqual({ ok: false, status: 429, code: "rate_limited" });
	});

	it("trusts only the socket address and ignores X-Forwarded-For", () => {
		const clock = makeClock();
		const auth = new MobileAuth({ store: undefined, now: () => clock.now });
		for (let index = 0; index < AUTH_FAILURE_LIMIT; index++)
			auth.authenticate(fakeRequest([["X-Forwarded-For", `198.51.100.${index}`]], "10.0.0.1"));
		const spoofed = auth.authenticate(fakeRequest([["X-Forwarded-For", "10.0.0.1"]], "10.0.0.9"));
		expect(spoofed).toEqual({ ok: false, status: 401, code: "unauthorized" });
	});
});

describe("mobile auth upgrade", () => {
	it("rejects unauthenticated upgrades with 401 and never opens a websocket", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const raw = await rawUpgrade(port, "GET", "/mobile/v1/ws");
			expect(raw.startsWith("HTTP/1.1 401")).toBe(true);
			expect(raw).toContain('"code":"unauthorized"');
			const upgrade = await wsUpgradeResult(port, {});
			expect(upgrade.statusLine).toBe("HTTP/1.1 401 Unauthorized");
			expect(upgrade.closeCode).toBeUndefined();
		} finally {
			await gateway.close();
		}
	});

	it("rejects wrong credentials without reflecting them", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const deviceId = randomUUID();
			const wrong = `WRONGMARKER-${credential()}`;
			const raw = await rawUpgrade(port, "GET", "/mobile/v1/ws", {
				Authorization: `Neko-Device ${deviceId}.${wrong}`,
			});
			expect(raw.startsWith("HTTP/1.1 401")).toBe(true);
			expect(raw).not.toContain("WRONGMARKER");
		} finally {
			await gateway.close();
		}
	});

	it("rejects unknown devices", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const raw = await rawUpgrade(port, "GET", "/mobile/v1/ws", {
				Authorization: `Neko-Device ${randomUUID()}.${credential()}`,
			});
			expect(raw.startsWith("HTTP/1.1 401")).toBe(true);
		} finally {
			await gateway.close();
		}
	});

	it("rejects revoked devices after removeDevice", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const { deviceId, credential: secret } = await pairDevice(gateway, port);
			const mobileStore = gateway.mobile.store;
			if (mobileStore === undefined) throw new Error("mobile store unavailable");
			await mobileStore.removeDevice(deviceId);
			const raw = await rawUpgrade(port, "GET", "/mobile/v1/ws", {
				Authorization: `Neko-Device ${deviceId}.${secret}`,
			});
			expect(raw.startsWith("HTTP/1.1 401")).toBe(true);
		} finally {
			await gateway.close();
		}
	});

	it("rejects non-GET requests and other paths", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const post = await rawUpgrade(port, "POST", "/mobile/v1/ws", {});
			expect(post.startsWith("HTTP/1.1 401")).toBe(true);
			const other = await rawUpgrade(port, "GET", "/mobile/v1/other", {});
			expect(other.startsWith("HTTP/1.1 401")).toBe(true);
		} finally {
			await gateway.close();
		}
	});

	it("authenticates paired devices and hands the connection to the mobile adapter", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const { deviceId, credential: secret } = await pairDevice(gateway, port);
			const client = await connectMobileWs(port, { Authorization: `Neko-Device ${deviceId}.${secret}` });
			client.close(1000, "done");
			const close = await client.waitForClose();
			expect(close.code).toBe(1000);
		} finally {
			await gateway.close();
		}
	});

	it("rate limits upgrade failures per source ip", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			for (let index = 0; index < AUTH_FAILURE_LIMIT; index++) {
				const raw = await rawUpgrade(port, "GET", "/mobile/v1/ws");
				expect(raw.startsWith("HTTP/1.1 401")).toBe(true);
			}
			const limited = await rawUpgrade(port, "GET", "/mobile/v1/ws");
			expect(limited.startsWith("HTTP/1.1 429")).toBe(true);
			expect(limited).toContain('"code":"rate_limited"');
		} finally {
			await gateway.close();
		}
	});

	it("keeps credentials, codes, and key material out of logs, errors, and responses", async () => {
		const logged: string[] = [];
		const logSpy = spyOn(console, "log");
		const infoSpy = spyOn(console, "info");
		const warnSpy = spyOn(console, "warn");
		const errorSpy = spyOn(console, "error");
		const { gateway, port } = await startEnabledGateway(dir, (error) => logged.push(error.message));
		let secrets: string[] = [];
		try {
			const { deviceId, credential: secret } = await pairDevice(gateway, port);
			const pairingText = gateway.mobile.createPairing().pairingText;
			const code = parsePairingText(pairingText).code;
			secrets = [secret, code, `Neko-Device ${deviceId}.${secret}`];
			await rawUpgrade(port, "GET", "/mobile/v1/ws", { Authorization: `Neko-Device ${deviceId}.${secret}` });
			const store = await MobileStore.open(dir);
			await store.removeDevice(deviceId);
			await rawUpgrade(port, "GET", "/mobile/v1/ws", { Authorization: `Neko-Device ${deviceId}.${secret}` }).catch(
				() => undefined,
			);
		} finally {
			await gateway.close();
			logSpy.mockRestore();
			infoSpy.mockRestore();
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
		const output = [
			...logged,
			...logSpy.mock.calls,
			...infoSpy.mock.calls,
			...warnSpy.mock.calls,
			...errorSpy.mock.calls,
		]
			.map((entry) => (Array.isArray(entry) ? entry.map((arg) => String(arg)).join(" ") : String(entry)))
			.join("\n");
		for (const secret of secrets) expect(output).not.toContain(secret);
		expect(output).not.toContain("PRIVATE KEY");
	});
});
