import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { rm } from "../../../../test/temp-dir.ts";
import { connectNekoGateway, type NekoGateway, startGateway } from "../../src/index.ts";
import type { MobileCertificate } from "../../src/mobile/certificate.ts";
import {
	MobilePairing,
	type MobilePairingStore,
	type MobilePairRequest,
	PAIRING_BODY_LIMIT_BYTES,
} from "../../src/mobile/pairing.ts";
import { type MobileDeviceRecord, MobileStore } from "../../src/mobile/store.ts";
import { cleanup, makeGateway, testAddress, testSocketPath } from "../helpers.ts";

const IS_WINDOWS = process.platform === "win32";
const FAKE_FINGERPRINT = createHash("sha256").update("fake-der").digest("hex");
const FAKE_CERTIFICATE = { fingerprint: FAKE_FINGERPRINT } as unknown as MobileCertificate;

function credential(): string {
	return randomBytes(32).toString("base64url");
}

function parsePairingText(pairingText: string): {
	readonly v: number;
	readonly sid: string;
	readonly name: string;
	readonly ep: string;
	readonly fp: string;
	readonly code: string;
	readonly exp: number;
} {
	expect(pairingText.startsWith("nekopair:1:")).toBe(true);
	return JSON.parse(Buffer.from(pairingText.slice("nekopair:1:".length), "base64url").toString("utf8")) as never;
}

function pairBody(
	payload: { readonly sid: string; readonly code: string },
	overrides: Partial<MobilePairRequest> = {},
): Buffer {
	return Buffer.from(
		JSON.stringify({
			v: 1,
			sid: payload.sid,
			code: payload.code,
			pairRequestId: randomUUID(),
			deviceId: randomUUID(),
			deviceName: "Pixel 9",
			credential: credential(),
			...overrides,
		}),
		"utf8",
	);
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

async function makeHarness(
	dir: string,
	options: {
		readonly serverName?: string;
		readonly store?: MobilePairingStore;
		readonly onPaired?: (device: MobileDeviceRecord) => void;
	} = {},
) {
	const store = options.store ?? (await MobileStore.open(dir));
	const clock = makeClock();
	const pairing = new MobilePairing({
		serverId: randomUUID(),
		serverName: options.serverName ?? "TestPC",
		store,
		certificate: () => FAKE_CERTIFICATE,
		isListening: () => ({ address: "192.168.1.20", port: 8323 }),
		...(options.onPaired === undefined ? {} : { onPaired: options.onPaired }),
		now: () => clock.now,
	});
	return { pairing, clock, store };
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

async function startEnabledGateway(
	dir: string,
	serverName = "TestPC",
): Promise<{ gateway: NekoGateway; port: number }> {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath: testSocketPath(dir),
		port: 0,
		mobileServerName: serverName,
		mobileNetwork: { wsl: null },
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	const port = await freePort();
	await gateway.mobile.enable({ address: "127.0.0.1", port });
	return { gateway, port };
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-pairing-"));
});
afterEach(async () => {
	await chmod(join(dir, "mobile"), 0o700).catch(() => undefined);
	await rm(dir, { recursive: true, force: true });
});

describe("mobile pairing service", () => {
	it("issues a nekopair:1 text with the D4 payload and replaces codes on refresh", async () => {
		const { pairing, clock } = await makeHarness(dir);
		const first = pairing.createPairing();
		const payload = parsePairingText(first.pairingText);
		expect(payload.v).toBe(1);
		expect(payload.name).toBe("TestPC");
		expect(payload.ep).toBe("https://192.168.1.20:8323");
		expect(payload.fp).toBe(FAKE_FINGERPRINT);
		expect(payload.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(first.expiresAt).toBe(clock.now + 120_000);
		expect(payload.exp).toBe(first.expiresAt);

		const second = pairing.createPairing();
		const refreshed = parsePairingText(second.pairingText);
		expect(refreshed.code).not.toBe(payload.code);
		expect(second.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);
	});

	it("refuses to create pairing text unless listening with a certificate", async () => {
		const store = await MobileStore.open(dir);
		const clock = makeClock();
		const offline = new MobilePairing({
			serverId: randomUUID(),
			serverName: "TestPC",
			store,
			certificate: () => FAKE_CERTIFICATE,
			isListening: () => undefined,
			now: () => clock.now,
		});
		expect(() => offline.createPairing()).toThrow("listening");
		const noCertificate = new MobilePairing({
			serverId: randomUUID(),
			serverName: "TestPC",
			store,
			certificate: () => undefined,
			isListening: () => ({ address: "192.168.1.20", port: 8323 }),
			now: () => clock.now,
		});
		expect(() => noCertificate.createPairing()).toThrow("certificate");
	});

	it("rejects an expired code with 410 and a body free of request secrets", async () => {
		const { pairing, clock } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody(payload);
		clock.tick(121_000);
		const result = await pairing.redeem(body, "10.0.0.1");
		expect(result.status).toBe(410);
		if (result.status !== 200) expect(result.body.code).toBe("code_expired");
		const text = JSON.stringify(result.body);
		expect(text).not.toContain(payload.code);
		expect(text).not.toContain("Pixel 9");
	});

	it("invalidates the previous code when a new one is created", async () => {
		const { pairing, store } = await makeHarness(dir);
		const first = parsePairingText(pairing.createPairing().pairingText);
		const second = parsePairingText(pairing.createPairing().pairingText);
		const stale = await pairing.redeem(pairBody(first), "10.0.0.1");
		expect(stale.status).toBe(410);
		const fresh = await pairing.redeem(pairBody(second), "10.0.0.2");
		expect(fresh.status).toBe(200);
		expect(store.getState().devices).toHaveLength(1);
	});

	it("invalidate clears the active code", async () => {
		const { pairing } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		pairing.invalidate();
		const result = await pairing.redeem(pairBody(payload), "10.0.0.1");
		expect(result.status).toBe(410);
	});

	it("lets exactly one of two concurrent redemptions succeed", async () => {
		const { pairing, store } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const [first, second] = await Promise.all([
			pairing.redeem(pairBody(payload), "10.0.0.1"),
			pairing.redeem(pairBody(payload), "10.0.0.2"),
		]);
		const statuses = [first.status, second.status].sort();
		expect(statuses).toEqual([200, 409]);
		const rejected = first.status === 409 ? first : second;
		if (rejected.status !== 200) expect(rejected.body.code).toBe("code_used");
		expect(store.getState().devices).toHaveLength(1);
		expect(store.getState().receipts).toHaveLength(1);
	});

	it("returns the original result for a same-request retry without re-pairing", async () => {
		const { pairing, store } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody(payload);
		const first = await pairing.redeem(body, "10.0.0.1");
		expect(first.status).toBe(200);
		const second = await pairing.redeem(body, "10.0.0.1");
		expect(second).toEqual(first);
		expect(store.getState().devices).toHaveLength(1);
		expect(store.getState().devices[0]?.grantRevision).toBe(1);
	});

	it("survives a gateway restart because receipts are persisted", async () => {
		const { pairing, store, clock } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody(payload);
		const original = await pairing.redeem(body, "10.0.0.1");
		expect(original.status).toBe(200);
		clock.tick(60_000);

		const restarted = new MobilePairing({
			serverId: original.status === 200 ? original.body.serverId : "",
			serverName: "TestPC",
			store,
			certificate: () => FAKE_CERTIFICATE,
			isListening: () => ({ address: "192.168.1.20", port: 8323 }),
			now: () => clock.now,
		});
		const retried = await restarted.redeem(body, "10.0.0.1");
		expect(retried).toEqual(original);
		expect(store.getState().devices).toHaveLength(1);
	});

	it("rejects retries after the receipt recovery window", async () => {
		const { pairing, clock } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody(payload);
		expect((await pairing.redeem(body, "10.0.0.1")).status).toBe(200);
		clock.tick(10 * 60_000 + 1_000);
		const result = await pairing.redeem(body, "10.0.0.1");
		expect(result.status).toBe(410);
		if (result.status !== 200) expect(result.body.message).toMatch(/scan a new code/);
	});

	it("refuses mismatched retries and fresh attempts against a consumed code", async () => {
		const { pairing } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody(payload);
		expect((await pairing.redeem(body, "10.0.0.1")).status).toBe(200);

		const mismatched = await pairing.redeem(
			pairBody(payload, { pairRequestId: bodyJson(body).pairRequestId }),
			"10.0.0.1",
		);
		expect(mismatched.status).toBe(409);

		const freshAttempt = await pairing.redeem(pairBody(payload), "10.0.0.1");
		expect(freshAttempt.status).toBe(409);
		if (freshAttempt.status !== 200) expect(freshAttempt.body.code).toBe("code_used");
	});

	it("rejects wrong-server requests with 403 without echoing the sid", async () => {
		const { pairing } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody({ sid: "not-the-server-id", code: payload.code });
		const result = await pairing.redeem(body, "10.0.0.1");
		expect(result.status).toBe(403);
		if (result.status !== 200) {
			expect(result.body.code).toBe("wrong_server");
			expect(JSON.stringify(result.body)).not.toContain("not-the-server-id");
		}
	});

	it("rejects malformed requests with 400 invalid", async () => {
		const { pairing } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const malformed = [
			Buffer.from("{ not json", "utf8"),
			Buffer.from(JSON.stringify({ ...JSON.parse(pairBody(payload).toString("utf8")), v: 2 }), "utf8"),
			Buffer.from(JSON.stringify({ v: 1, sid: payload.sid }), "utf8"),
			pairBody(payload, { code: "!!not-base64url!!" }),
			pairBody(payload, { credential: "short" }),
		];
		for (const body of malformed) {
			const result = await pairing.redeem(body, "10.0.0.1");
			expect(result.status).toBe(400);
			if (result.status !== 200) expect(result.body.code).toBe("invalid");
		}
	});

	it("rate limits a source to ten attempts per minute", async () => {
		const { pairing } = await makeHarness(dir);
		const payload = parsePairingText(pairing.createPairing().pairingText);
		for (let attempt = 0; attempt < 10; attempt++) {
			const result = await pairing.redeem(pairBody(payload), "10.0.0.1");
			expect(result.status === 200 || result.status === 409 || result.status === 410).toBe(true);
		}
		const limited = await pairing.redeem(pairBody(payload), "10.0.0.1");
		expect(limited.status).toBe(429);
		if (limited.status !== 200) expect(limited.body.code).toBe("rate_limited");
		const otherSource = await pairing.redeem(pairBody(payload), "10.0.0.2");
		expect(otherSource.status).not.toBe(429);
	});

	it("caps concurrent redemptions globally at four", async () => {
		const store = await MobileStore.open(dir);
		const clock = makeClock();
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gatedStore: MobilePairingStore = {
			getState: () => store.getState(),
			completePairing: (input) => gate.then(() => store.completePairing(input)),
		};
		const pairing = new MobilePairing({
			serverId: randomUUID(),
			serverName: "TestPC",
			store: gatedStore,
			certificate: () => FAKE_CERTIFICATE,
			isListening: () => ({ address: "192.168.1.20", port: 8323 }),
			now: () => clock.now,
		});
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const pending = [
			pairing.redeem(pairBody(payload), "10.0.0.1"),
			pairing.redeem(pairBody(payload), "10.0.0.2"),
			pairing.redeem(pairBody(payload), "10.0.0.3"),
			pairing.redeem(pairBody(payload), "10.0.0.4"),
			pairing.redeem(pairBody(payload), "10.0.0.5"),
		];
		await new Promise((resolve) => setTimeout(resolve, 25));
		release?.();
		const results = await Promise.all(pending);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 409, 409, 409, 429]);
		expect(store.getState().devices).toHaveLength(1);
	});

	it("rolls back consumption when the store write fails", async () => {
		const store = await MobileStore.open(dir);
		const clock = makeClock();
		let fail = true;
		const flakyStore: MobilePairingStore = {
			getState: () => store.getState(),
			completePairing: (input) => (fail ? Promise.reject(new Error("disk full")) : store.completePairing(input)),
		};
		const pairing = new MobilePairing({
			serverId: randomUUID(),
			serverName: "TestPC",
			store: flakyStore,
			certificate: () => FAKE_CERTIFICATE,
			isListening: () => ({ address: "192.168.1.20", port: 8323 }),
			now: () => clock.now,
		});
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody(payload);
		const failed = await pairing.redeem(body, "10.0.0.1");
		expect(failed.status).toBe(500);
		if (failed.status !== 200) expect(failed.body.code).toBe("internal");
		expect(store.getState().devices).toEqual([]);
		expect(store.getState().receipts).toEqual([]);

		fail = false;
		const retried = await pairing.redeem(body, "10.0.0.1");
		expect(retried.status).toBe(200);
	});

	it("re-pairing the same device replaces the credential and bumps the grant revision", async () => {
		const { pairing, store } = await makeHarness(dir);
		const firstPayload = parsePairingText(pairing.createPairing().pairingText);
		const first = await pairing.redeem(pairBody(firstPayload), "10.0.0.1");
		expect(first.status).toBe(200);
		if (first.status !== 200) return;
		expect(first.body.grantRevision).toBe(1);

		const deviceId = first.body.deviceId;
		const secondPayload = parsePairingText(pairing.createPairing().pairingText);
		const second = await pairing.redeem(pairBody(secondPayload, { deviceId }), "10.0.0.1");
		expect(second.status).toBe(200);
		if (second.status !== 200) return;
		expect(second.body.deviceId).toBe(deviceId);
		expect(second.body.grantRevision).toBe(2);

		const state = store.getState();
		expect(state.devices).toHaveLength(1);
		expect(state.devices[0]?.grantRevision).toBe(2);
		expect(state.receipts).toHaveLength(2);
		expect(state.receipts[0]?.grantRevision).toBe(1);
		expect(state.receipts[1]?.grantRevision).toBe(2);
	});

	it("notifies the onPaired hook with the persisted device", async () => {
		const store = await MobileStore.open(dir);
		const clock = makeClock();
		let seen: unknown;
		const pairing = new MobilePairing({
			serverId: randomUUID(),
			serverName: "TestPC",
			store,
			certificate: () => FAKE_CERTIFICATE,
			isListening: () => ({ address: "192.168.1.20", port: 8323 }),
			onPaired: (device) => {
				seen = device;
			},
			now: () => clock.now,
		});
		const payload = parsePairingText(pairing.createPairing().pairingText);
		await pairing.redeem(pairBody(payload), "10.0.0.1");
		expect(seen).toEqual(store.getState().devices[0]);
	});

	it("a throwing onPaired callback cannot fail a persisted pairing or reopen the code", async () => {
		const store = await MobileStore.open(dir);
		const clock = makeClock();
		const pairing = new MobilePairing({
			serverId: randomUUID(),
			serverName: "TestPC",
			store,
			certificate: () => FAKE_CERTIFICATE,
			isListening: () => ({ address: "192.168.1.20", port: 8323 }),
			onPaired: () => {
				throw new Error("invalidation exploded");
			},
			now: () => clock.now,
		});
		const payload = parsePairingText(pairing.createPairing().pairingText);
		const body = pairBody(payload);
		const result = await pairing.redeem(body, "10.0.0.1");
		expect(result.status).toBe(200);
		expect(store.getState().devices).toHaveLength(1);
		const again = await pairing.redeem(pairBody(payload), "10.0.0.2");
		expect(again.status).toBe(409);
	});
});

function bodyJson(body: Buffer): MobilePairRequest {
	return JSON.parse(body.toString("utf8")) as MobilePairRequest;
}

describe("mobile pairing over https", () => {
	it("completes a pairing end to end and persists device plus receipt", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const client = await connectNekoGateway(
				testAddress({ socketPath: gateway.socketPath, wsUrl: gateway.wsUrl ?? "", serverId: gateway.serverId }),
			);
			await client.close();

			const { pairingText, expiresAt } = gateway.mobile.createPairing();
			const payload = parsePairingText(pairingText);
			expect(payload.name).toBe("TestPC");
			expect(payload.ep).toBe(`https://127.0.0.1:${port}`);
			expect(payload.fp).toBe(
				new X509Certificate(await readFile(join(dir, "mobile", "tls", "cert.pem"), "utf8")).fingerprint256
					.replaceAll(":", "")
					.toLowerCase(),
			);
			expect(payload.exp).toBe(expiresAt);

			const deviceId = randomUUID();
			const secret = credential();
			const body = Buffer.from(
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
			);
			const response = await mobileRequest(port, "/mobile/v1/pair", "POST", body);
			expect(response.status).toBe(200);
			const result = JSON.parse(response.body) as Record<string, unknown>;
			expect(result).toEqual({
				serverId: gateway.serverId,
				serverName: "TestPC",
				deviceId,
				grantRevision: 1,
				apiVersions: [1],
			});

			const store = await MobileStore.open(dir);
			const state = store.getState();
			expect(state.devices).toHaveLength(1);
			expect(state.devices[0]).toMatchObject({ deviceId, name: "Pixel 9", grantRevision: 1 });
			expect(state.devices[0]?.credentialHash).toBe(createHash("sha256").update(secret, "utf8").digest("hex"));
			expect(state.receipts).toHaveLength(1);
			expect(response.body).not.toContain(secret);
			expect(response.body).not.toContain(payload.code);
		} finally {
			await gateway.close();
		}
	});

	it("keeps unknown paths at 404 and rejects other methods on the pair route", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			expect((await mobileRequest(port, "/mobile/v1/other", "POST", Buffer.from("{}"))).status).toBe(404);
			expect((await mobileRequest(port, "/mobile/v1/pair")).status).toBe(404);
			expect((await mobileRequest(port, "/")).status).toBe(404);
		} finally {
			await gateway.close();
		}
	});

	it("rejects oversized bodies with 413", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const oversized = Buffer.from(`{"pad":"${"x".repeat(PAIRING_BODY_LIMIT_BYTES + 64)}"}`, "utf8");
			const response = await mobileRequest(port, "/mobile/v1/pair", "POST", oversized);
			expect(response.status).toBe(413);
			const body = JSON.parse(response.body) as { code: string };
			expect(body.code).toBe("payload_too_large");
		} finally {
			await gateway.close();
		}
	});

	it("rate limits the pair endpoint per source ip", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const invalid = Buffer.from("{}", "utf8");
			for (let attempt = 0; attempt < 10; attempt++) {
				expect((await mobileRequest(port, "/mobile/v1/pair", "POST", invalid)).status).toBe(400);
			}
			const limited = await mobileRequest(port, "/mobile/v1/pair", "POST", invalid);
			expect(limited.status).toBe(429);
			expect((JSON.parse(limited.body) as { code: string }).code).toBe("rate_limited");
		} finally {
			await gateway.close();
		}
	});

	it("settles two concurrent redemptions over https with one success and one 409", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
			const [first, second] = await Promise.all([
				mobileRequest(port, "/mobile/v1/pair", "POST", pairBody(payload)),
				mobileRequest(port, "/mobile/v1/pair", "POST", pairBody(payload)),
			]);
			expect([first.status, second.status].sort()).toEqual([200, 409]);
			const store = await MobileStore.open(dir);
			expect(store.getState().devices).toHaveLength(1);
		} finally {
			await gateway.close();
		}
	});

	it("disable invalidates the current code and blocks new pairing text", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
			await gateway.mobile.disable();
			expect(() => gateway.mobile.createPairing()).toThrow("listening");
			await expect(mobileRequest(port, "/mobile/v1/pair", "POST", pairBody(payload))).rejects.toThrow();
		} finally {
			await gateway.close();
		}
	});

	it("retry after gateway restart returns the original result", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		let body: Buffer | undefined;
		let original = "";
		try {
			const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
			body = pairBody(payload);
			const response = await mobileRequest(port, "/mobile/v1/pair", "POST", body);
			expect(response.status).toBe(200);
			original = response.body;
		} finally {
			await gateway.close();
		}

		const restarted = await startEnabledGateway(dir);
		try {
			const response = await mobileRequest(restarted.port, "/mobile/v1/pair", "POST", body);
			expect(response.status).toBe(200);
			expect(response.body).toBe(original);
			const store = await MobileStore.open(dir);
			expect(store.getState().devices).toHaveLength(1);
		} finally {
			await restarted.gateway.close();
		}
	});

	it("unredeemed codes do not survive a gateway restart", async () => {
		const { gateway } = await startEnabledGateway(dir);
		let body: Buffer | undefined;
		try {
			const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
			body = pairBody(payload);
		} finally {
			await gateway.close();
		}

		const restarted = await startEnabledGateway(dir);
		try {
			const response = await mobileRequest(restarted.port, "/mobile/v1/pair", "POST", body);
			expect(response.status).toBe(410);
		} finally {
			await restarted.gateway.close();
		}
	});

	it.skipIf(IS_WINDOWS)("a failed persist writes neither device nor receipt and can be retried", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
			const body = pairBody(payload);
			await chmod(join(dir, "mobile"), 0o500);
			let response: { status: number; body: string };
			try {
				response = await mobileRequest(port, "/mobile/v1/pair", "POST", body);
			} finally {
				await chmod(join(dir, "mobile"), 0o700);
			}
			expect(response.status).toBe(500);
			const store = await MobileStore.open(dir);
			expect(store.getState().devices).toEqual([]);
			expect(store.getState().receipts).toEqual([]);

			const retried = await mobileRequest(port, "/mobile/v1/pair", "POST", body);
			expect(retried.status).toBe(200);
			expect((await MobileStore.open(dir)).getState().devices).toHaveLength(1);
		} finally {
			await gateway.close();
		}
	});

	it("error responses never echo request fields", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
			const secret = credential();
			const wrongServer = Buffer.from(
				JSON.stringify({
					v: 1,
					sid: "MARKER-SID-1234",
					code: payload.code,
					pairRequestId: "MARKER-REQUEST",
					deviceId: "MARKER-DEVICE",
					deviceName: "MARKER-NAME",
					credential: secret,
				}),
				"utf8",
			);
			const response = await mobileRequest(port, "/mobile/v1/pair", "POST", wrongServer);
			expect(response.status).toBe(403);
			for (const marker of [
				"MARKER-SID-1234",
				"MARKER-REQUEST",
				"MARKER-DEVICE",
				"MARKER-NAME",
				secret,
				payload.code,
			]) {
				expect(response.body).not.toContain(marker);
			}

			const invalid = await mobileRequest(
				port,
				"/mobile/v1/pair",
				"POST",
				Buffer.from(JSON.stringify({ v: 1, sid: payload.sid, deviceName: "MARKER-INVALID" }), "utf8"),
			);
			expect(invalid.status).toBe(400);
			expect(invalid.body).not.toContain("MARKER-INVALID");
		} finally {
			await gateway.close();
		}
	});

	it("refuses to show pairing text while disabled or in error state", async () => {
		const target = await makeGateway();
		try {
			expect(() => target.gateway.mobile.createPairing()).toThrow("listening");
			const blocker = createNetServer();
			await new Promise<void>((resolve, reject) => {
				blocker.once("error", reject);
				blocker.listen(0, "127.0.0.1", resolve);
			});
			const address = blocker.address();
			if (typeof address !== "object" || address === null) throw new Error("no address assigned");
			try {
				await expect(target.gateway.mobile.enable({ address: "127.0.0.1", port: address.port })).rejects.toThrow();
				expect(target.gateway.mobile.state.status).toBe("error");
				expect(() => target.gateway.mobile.createPairing()).toThrow("listening");
			} finally {
				await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
			}
		} finally {
			await cleanup(target);
		}
	});
});
