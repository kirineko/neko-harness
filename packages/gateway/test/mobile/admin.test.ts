import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { ChordError, type Link, memoryLinkPair } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { renderPairingQr } from "../../../../scripts/mobile-dev-pair.ts";
import { rm } from "../../../../test/temp-dir.ts";
import { type NekoGateway, startGateway } from "../../src/index.ts";
import { createClientHost } from "../../src/link.ts";
import { createMobileAdminFactory, NekoMobileAdmin } from "../../src/mobile/admin.ts";
import type { MobileGateway } from "../../src/mobile/listener.ts";
import { MobileStore } from "../../src/mobile/store.ts";
import { createUnixLink } from "../../src/unix-link.ts";
import { connectTestClient, IS_WINDOWS, waitFor } from "../helpers.ts";
import { connectMobileWs, type MobileWsClient } from "./ws-client.ts";

function parsePairingText(pairingText: string): { readonly sid: string; readonly code: string; readonly ep: string } {
	return JSON.parse(Buffer.from(pairingText.slice("nekopair:1:".length), "base64url").toString("utf8")) as never;
}

function credential(): string {
	return randomBytes(32).toString("base64url");
}

async function mobileRequest(
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

async function pairDevice(
	gateway: NekoGateway,
	port: number,
): Promise<{ deviceId: string; credential: string; body: Buffer }> {
	const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
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
	return { deviceId, credential: secret, body };
}

async function connectMobileHello(
	port: number,
	device: { deviceId: string; credential: string },
): Promise<MobileWsClient> {
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

async function startGatewayOnly(dir: string): Promise<NekoGateway> {
	const faux = fauxProvider();
	faux.setResponses([0, 1, 2, 3].map(() => fauxAssistantMessage([fauxText("pong")])));
	// 预写 serverId 身份文件并按 <serverId>.sock 命名 socket，与脚本的发现约定一致。
	const serverId = randomUUID();
	await writeFile(join(dir, "gateway-server-id"), `${serverId}\n`, { mode: 0o600 });
	return startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath: IS_WINDOWS ? null : join(dir, `${serverId}.sock`),
		port: 0,
		mobileServerName: "TestPC",
		mobileNetwork: { wsl: null },
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
}

function tlsFingerprint(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false });
		socket.on("secureConnect", () => {
			const fingerprint = createHash("sha256").update(socket.getPeerCertificate().raw).digest("hex");
			socket.destroy();
			resolve(fingerprint);
		});
		socket.on("error", reject);
	});
}

async function connectAdmin(gateway: NekoGateway, token: string) {
	// Bun on Windows drops frames when a WebSocket server and client share a process, so the admin link is in-memory there.
	let link: Link;
	if (IS_WINDOWS) {
		const [clientEnd, serverEnd] = memoryLinkPair();
		gateway.accept(serverEnd);
		link = clientEnd;
	} else {
		link = await createUnixLink(gateway.socketPath ?? "");
	}
	const host = createClientHost(link);
	const admin = await host.get(NekoMobileAdmin, { token });
	return { host, link, admin };
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-admin-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("mobile admin minimal subset", () => {
	it("enables the listener and creates pairing over a dedicated admin client", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			expect(gateway.mobile.state.status).toBe("disabled");
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				const port = await freePort();
				const state = await admin.enable({ address: "127.0.0.1", port });
				expect(state).toEqual({ status: "listening", address: "127.0.0.1", port });
				expect(gateway.mobile.state).toEqual({ status: "listening", address: "127.0.0.1", port });

				const { pairingText, expiresAt } = await admin.createPairing(null);
				expect(pairingText.startsWith("nekopair:1:")).toBe(true);
				expect(parsePairingText(pairingText).ep).toBe(`https://127.0.0.1:${port}`);
				expect(expiresAt).toBeGreaterThan(Date.now());
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
			expect(gateway.mobile.state.status).toBe("listening");
		} finally {
			await gateway.close();
		}
	});

	it("rejects missing and wrong tokens with forbidden and never echoes the token", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			await (await MobileStore.open(dir)).ensureAdminToken();
			const wrong = `wrong-${randomUUID()}`;
			const { host, link, admin } = await connectAdmin(gateway, wrong);
			try {
				const failure = await admin.createPairing(null).then(
					() => undefined,
					(error: unknown) => error as Error,
				);
				expect(failure).toBeInstanceOf(ChordError);
				expect((failure as ChordError).code).toBe("forbidden");
				expect(String((failure as Error).message)).not.toContain(wrong);
				expect(JSON.stringify(failure)).not.toContain(wrong);
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}

			const denied = await connectAdmin(gateway, "");
			try {
				await expect(denied.admin.enable({ address: "127.0.0.1" })).rejects.toMatchObject({ code: "forbidden" });
				await expect(denied.admin.createPairing(null)).rejects.toMatchObject({ code: "forbidden" });
			} finally {
				denied.admin.release();
				await denied.host.close().catch(() => undefined);
				denied.link.close("done");
			}
		} finally {
			await gateway.close();
		}
	});

	it("refuses mobile principals before any token check", async () => {
		const calls: string[] = [];
		const mobile = {
			enable: () => {
				calls.push("enable");
				return Promise.resolve({ status: "listening" as const, address: "127.0.0.1", port: 8323 });
			},
			createPairing: () => {
				calls.push("createPairing");
				return Promise.resolve({ pairingText: "nekopair:1:x", expiresAt: 1 });
			},
		} as unknown as MobileGateway;
		const factory = createMobileAdminFactory({ mobile, store: undefined });
		let failure: unknown;
		try {
			factory({ token: "any" }, { kind: "mobile", deviceId: "d", grantRevision: 1, connectionId: "c" });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ChordError);
		expect((failure as ChordError).code).toBe("forbidden");
		expect(calls).toEqual([]);
	});

	it("does not bind the admin contract into createGatewayConnection", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const desktop = await connectTestClient(gateway);
			const exposed = Object.keys(desktop).filter((key) => key.toLowerCase().includes("admin"));
			expect(exposed).toEqual([]);
			const models = await desktop.models.list(null);
			expect(models.length).toBeGreaterThan(0);
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("revoke closes the device's mobile websocket with 4401 and keeps other devices and desktop intact", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			const target = await pairDevice(gateway, port);
			const survivor = await pairDevice(gateway, port);
			const targetClient = await connectMobileHello(port, target);
			const survivorClient = await connectMobileHello(port, survivor);
			const desktop = await connectTestClient(gateway);

			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				await expect(admin.revoke({ deviceId: target.deviceId })).resolves.toEqual({ revoked: true });
				const close = await targetClient.waitForClose();
				expect(close.code).toBe(4401);
				expect(close.reason).toBe("revoked");

				survivorClient.send({ jsonrpc: "2.0", id: 2, method: "probe.alive", params: {} });
				const reply = (await survivorClient.nextMessage()) as { error: { data: { code: string } } };
				expect(reply.error.data.code).toBe("not_found");

				const state = (await MobileStore.open(dir)).getState();
				expect(state.devices.map((device) => device.deviceId)).toEqual([survivor.deviceId]);
				expect((await desktop.models.list(null)).length).toBeGreaterThan(0);
				await expect(admin.revoke({ deviceId: target.deviceId })).resolves.toEqual({ revoked: false });
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
			survivorClient.close(1000, "done");
			await survivorClient.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("a wrong token cannot revoke and leaves the device and its connection untouched", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			const device = await pairDevice(gateway, port);
			const client = await connectMobileHello(port, device);

			const denied = await connectAdmin(gateway, `wrong-${randomUUID()}`);
			try {
				const failure = await denied.admin.revoke({ deviceId: device.deviceId }).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(failure).toBeInstanceOf(ChordError);
				expect((failure as ChordError).code).toBe("forbidden");
			} finally {
				denied.admin.release();
				await denied.host.close().catch(() => undefined);
				denied.link.close("done");
			}

			expect((await MobileStore.open(dir)).getState().devices.map((d) => d.deviceId)).toEqual([device.deviceId]);
			client.send({ jsonrpc: "2.0", id: 3, method: "still.alive", params: {} });
			const reply = (await client.nextMessage()) as { error: { data: { code: string } } };
			expect(reply.error.data.code).toBe("not_found");
			client.close(1000, "done");
			await client.waitForClose();
		} finally {
			await gateway.close();
		}
	});

	it("client sessions release cleanly and a second session still works", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const first = await connectAdmin(gateway, token);
			const rejected = await first.admin.createPairing(null).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(rejected).toBeDefined();
			first.admin.release();
			await first.host.close();
			first.link.close("done");

			const second = await connectAdmin(gateway, token);
			try {
				const state = await second.admin.enable({ address: "127.0.0.1", port: await freePort() });
				expect(state.status).toBe("listening");
			} finally {
				second.admin.release();
				await second.host.close().catch(() => undefined);
				second.link.close("done");
			}
		} finally {
			await gateway.close();
		}
	});
});

describe("mobile dev pair script", () => {
	it("renders a scannable ascii qr for the pairing text", async () => {
		const pairingText = `nekopair:1:${Buffer.from(
			JSON.stringify({
				v: 1,
				sid: randomUUID(),
				name: "TestPC",
				ep: "https://192.168.1.20:8323",
				fp: "ab".repeat(32),
				code: randomUUID(),
				exp: 1,
			}),
			"utf8",
		).toString("base64url")}`;
		const rendered = renderPairingQr(pairingText);
		const lines = rendered.split("\n");
		expect(lines.length).toBeGreaterThan(20);
		expect(rendered).toContain("██");
		const width = lines[0]?.length ?? 0;
		expect(width).toBeGreaterThan(40);
		for (const line of lines) expect(line.length).toBe(width);
		expect(rendered).not.toContain(pairingText);
		expect(renderPairingQr(pairingText)).toBe(rendered);
	});

	it("prints the pairing text and qr against a live gateway without leaking the token", async () => {
		const gateway = await startGatewayOnly(dir);
		const port = await freePort();
		try {
			const result = await runScript(["--data-dir", dir, "--address", "127.0.0.1", "--port", String(port)]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("nekopair:1:");
			expect(result.stdout).toContain("██");
			expect(result.stdout).toContain(`https://127.0.0.1:${port}`);
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			expect(result.stdout).not.toContain(token);
			expect(gateway.mobile.state).toEqual({ status: "listening", address: "127.0.0.1", port });
		} finally {
			await gateway.close();
		}
	});

	it("fails with an actionable error and prints no qr when no gateway is running", async () => {
		const empty = await mkdtemp(join(tmpdir(), "neko-mobile-admin-empty-"));
		try {
			const result = await runScript(["--data-dir", empty, "--address", "127.0.0.1"]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr + result.stdout).toContain("请先");
			expect(result.stdout).not.toContain("██");
			expect(result.stdout).not.toContain("nekopair:1:");
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});
});

describe("mobile admin full surface (4.1)", () => {
	it("reports the full state with certificate info and per-device online/lastSeenAt", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const initial = await connectAdmin(gateway, token);
			try {
				const before = await initial.admin.state(null);
				expect(before.state).toEqual({ status: "disabled" });
				expect(Array.isArray(before.candidates)).toBe(true);
				expect(before.port).toBe(8323);
				// 非 WSL 为 null；WSL 下为互操作状态（此测试不依赖运行环境）。
				expect(before.wsl === null || typeof before.wsl?.interop === "boolean").toBe(true);
				expect(before.certificate).toBeNull();
				expect(before.devices).toEqual([]);
			} finally {
				initial.admin.release();
				await initial.host.close().catch(() => undefined);
				initial.link.close("done");
			}

			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			const device = await pairDevice(gateway, port);
			const pairedAt = (await MobileStore.open(dir)).getState().devices[0]?.lastSeenAt ?? 0;
			const client = await connectMobileHello(port, device);

			const during = await connectAdmin(gateway, token);
			try {
				const state = await during.admin.state(null);
				expect(state.state).toEqual({ status: "listening", address: "127.0.0.1", port });
				expect(state.certificate?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
				expect(state.certificate?.expiresAt).toBeGreaterThan(Date.now());
				expect(state.devices).toHaveLength(1);
				expect(state.devices[0]?.deviceId).toBe(device.deviceId);
				expect(state.devices[0]?.online).toBe(true);
			} finally {
				during.admin.release();
				await during.host.close().catch(() => undefined);
				during.link.close("done");
			}

			const touched = async (): Promise<boolean> =>
				((await MobileStore.open(dir)).getState().devices[0]?.lastSeenAt ?? 0) > pairedAt;
			const start = Date.now();
			while (!(await touched())) {
				if (Date.now() - start > 5_000) throw new Error("lastSeenAt was not touched after connect");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}

			client.close(1000, "done");
			await client.waitForClose();
			const after = await connectAdmin(gateway, token);
			try {
				// The server notices the closed socket asynchronously; the client-side close can come first (observed on Windows).
				let state = await after.admin.state(null);
				const offlineBy = Date.now() + 5_000;
				while (state.devices[0]?.online !== false && Date.now() < offlineBy) {
					await new Promise((resolve) => setTimeout(resolve, 25));
					state = await after.admin.state(null);
				}
				expect(state.devices[0]?.online).toBe(false);
				expect(state.devices[0]?.lastSeenAt).toBeGreaterThan(pairedAt);
			} finally {
				after.admin.release();
				await after.host.close().catch(() => undefined);
				after.link.close("done");
			}
		} finally {
			await gateway.close();
		}
	});

	it("learns the local address on a successful mobile connection and persists it across restarts", async () => {
		let gateway = await startGatewayOnly(dir);
		const port = await freePort();
		await gateway.mobile.enable({ address: "127.0.0.1", port });
		const device = await pairDevice(gateway, port);
		const client = await connectMobileHello(port, device);
		try {
			const learned = async (): Promise<boolean> =>
				(await MobileStore.open(dir)).getState().lastConnectedAddress === "127.0.0.1";
			const start = Date.now();
			while (!(await learned())) {
				if (Date.now() - start > 5_000) throw new Error("lastConnectedAddress was not learned after connect");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				const state = await admin.state(null);
				// 接入 socket 的本地地址即监听地址；学习值原样上报（127.0.0.1 是内部地址，不在候选里）。
				expect(state.lastConnectedAddress).toBe("127.0.0.1");
				expect(state.candidates).not.toContain("127.0.0.1");
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
		} finally {
			client.close(1000, "done");
			await client.waitForClose();
			await gateway.close();
		}

		expect((await MobileStore.open(dir)).getState().lastConnectedAddress).toBe("127.0.0.1");

		gateway = await startGatewayOnly(dir);
		try {
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				const state = await admin.state(null);
				expect(state.lastConnectedAddress).toBe("127.0.0.1");
				expect(state.state).toEqual({ status: "listening", address: "127.0.0.1", port });
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
		} finally {
			await gateway.close();
		}
	});

	it("disables the listener through admin and persists the change", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				expect(await admin.disable(null)).toEqual({ status: "disabled" });
				expect(gateway.mobile.state).toEqual({ status: "disabled" });
				await expect(mobileRequest(port, "/")).rejects.toThrow();
				expect((await MobileStore.open(dir)).getState().enabled).toBe(false);
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
		} finally {
			await gateway.close();
		}
	});

	it("cancelPairing invalidates the current pairing code", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				const { pairingText } = await admin.createPairing(null);
				await admin.cancelPairing(null);
				const payload = parsePairingText(pairingText);
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
							deviceId: randomUUID(),
							deviceName: "Pixel 9",
							credential: credential(),
						}),
						"utf8",
					),
				);
				expect(response.status).toBe(410);
				expect((await MobileStore.open(dir)).getState().devices).toEqual([]);
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
		} finally {
			await gateway.close();
		}
	});

	it("accepted runtime work keeps running after revoke", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			const device = await pairDevice(gateway, port);
			const client = await connectMobileHello(port, device);
			const desktop = await connectTestClient(gateway);
			const created = await desktop.management.create({});
			const chat = await desktop.attach(created.id);
			await chat.submit({ content: "before revoke" });
			await waitFor(
				() => chat.view.value?.items.some((item) => item.type === "assistant") ?? false,
				"reply before revoke",
			);

			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				await expect(admin.revoke({ deviceId: device.deviceId })).resolves.toEqual({ revoked: true });
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
			const close = await client.waitForClose();
			expect(close.code).toBe(4401);

			const items = chat.view.value?.items.length ?? 0;
			await chat.submit({ content: "after revoke" });
			await waitFor(() => (chat.view.value?.items.length ?? 0) > items, "reply after revoke");
			await desktop.detach();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("regenerateCertificate rotates everything while listening and restarts with the new certificate", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const firstDevice = await pairDevice(gateway, port);
			const retryBody = firstDevice.body;
			const secondDevice = await pairDevice(gateway, port);
			const firstClient = await connectMobileHello(port, firstDevice);
			const secondClient = await connectMobileHello(port, secondDevice);
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				const before = await admin.state(null);
				const oldFingerprint = before.certificate?.fingerprint ?? "";
				const { pairingText } = await admin.createPairing(null);

				const rotated = await admin.regenerateCertificate(null);
				expect(rotated.fingerprint).toMatch(/^[0-9a-f]{64}$/);
				expect(rotated.fingerprint).not.toBe(oldFingerprint);
				expect(rotated.expiresAt).toBeGreaterThan(Date.now());

				expect((await firstClient.waitForClose()).code).toBe(4401);
				expect((await secondClient.waitForClose()).code).toBe(4401);

				const store = await MobileStore.open(dir);
				expect(store.getState().devices).toEqual([]);
				expect(store.getState().receipts).toEqual([]);

				// 旧回执不能恢复旧授权；旧二维码与新凭据全部失效。
				const retry = await mobileRequest(port, "/mobile/v1/pair", "POST", retryBody);
				expect(retry.status).toBe(410);
				const staleCode = parsePairingText(pairingText);
				const staleAttempt = await mobileRequest(
					port,
					"/mobile/v1/pair",
					"POST",
					Buffer.from(
						JSON.stringify({
							v: 1,
							sid: staleCode.sid,
							code: staleCode.code,
							pairRequestId: randomUUID(),
							deviceId: randomUUID(),
							deviceName: "Pixel 9",
							credential: credential(),
						}),
						"utf8",
					),
				);
				expect(staleAttempt.status).toBe(410);
				await expect(
					connectMobileWs(port, { Authorization: `Neko-Device ${firstDevice.deviceId}.${firstDevice.credential}` }),
				).rejects.toThrow("401");

				// listener 用新证书重启。
				expect(await tlsFingerprint(port)).toBe(rotated.fingerprint);
				const after = await admin.state(null);
				expect(after.state).toEqual({ status: "listening", address: "127.0.0.1", port });
				expect(after.certificate?.fingerprint).toBe(rotated.fingerprint);
				expect(after.devices).toEqual([]);
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
		} finally {
			await gateway.close();
		}
	});

	it("regenerateCertificate works from disabled state and the next enable uses the new certificate", async () => {
		const gateway = await startGatewayOnly(dir);
		try {
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			let rotated: { fingerprint: string; expiresAt: number } | undefined;
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				rotated = await admin.regenerateCertificate(null);
				expect(rotated.fingerprint).toMatch(/^[0-9a-f]{64}$/);
				const state = await admin.state(null);
				expect(state.state).toEqual({ status: "disabled" });
				expect(state.certificate?.fingerprint).toBe(rotated.fingerprint);
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}

			const port = await freePort();
			await gateway.mobile.enable({ address: "127.0.0.1", port });
			expect(await tlsFingerprint(port)).toBe(rotated?.fingerprint);
		} finally {
			await gateway.close();
		}
	});

	it("recovers listener state, devices, and certificate after a gateway restart", async () => {
		let gateway = await startGatewayOnly(dir);
		const port = await freePort();
		await gateway.mobile.enable({ address: "127.0.0.1", port });
		const device = await pairDevice(gateway, port);
		const fingerprint = await tlsFingerprint(port);
		await gateway.close();

		gateway = await startGatewayOnly(dir);
		try {
			const token = await (await MobileStore.open(dir)).ensureAdminToken();
			const { host, link, admin } = await connectAdmin(gateway, token);
			try {
				const state = await admin.state(null);
				expect(state.state).toEqual({ status: "listening", address: "127.0.0.1", port });
				expect(state.certificate?.fingerprint).toBe(fingerprint);
				expect(state.devices.map((entry) => entry.deviceId)).toEqual([device.deviceId]);
				expect(state.devices[0]?.online).toBe(false);
				expect(await tlsFingerprint(port)).toBe(fingerprint);
			} finally {
				admin.release();
				await host.close().catch(() => undefined);
				link.close("done");
			}
			expect(await tlsFingerprint(port)).toBe(fingerprint);
		} finally {
			await gateway.close();
		}
	});
});

async function runScript(
	args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
	const root = join(import.meta.dir, "../../../..");
	const proc = Bun.spawn({
		cmd: [process.execPath, "--conditions=neko-source", "scripts/mobile-dev-pair.ts", ...args],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => proc.kill(), 30_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(timeout);
	}
}
