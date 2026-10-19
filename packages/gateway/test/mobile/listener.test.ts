import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../../test/faux.ts";
import { rm } from "../../../../test/temp-dir.ts";
import { startGateway } from "../../src/index.ts";
import { mobileListenCandidates, prioritizeListenCandidate } from "../../src/mobile/listener.ts";
import { MobileStore } from "../../src/mobile/store.ts";
import { cleanup, connectTestClient, makeGateway, testSocketPath } from "../helpers.ts";

function fingerprintOf(certPem: string): string {
	return createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex");
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
	await closeServer(server);
	return port;
}

async function occupyPort(address: string, port: number): Promise<NetServer> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, address, resolve);
	});
	return server;
}

async function closeServer(server: NetServer): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function httpsRequest(port: number, path: string): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpsGet({ host: "127.0.0.1", port, path, rejectUnauthorized: false }, (response) => {
			let body = "";
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request.on("error", reject);
		request.end();
	});
}

function rawUpgrade(port: number, path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false });
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("rawUpgrade timeout"));
		}, 5_000);
		socket.on("secureConnect", () => {
			socket.write(
				`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
			);
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

async function startIsolatedGateway(dir: string) {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: randomUUID(),
		mobileNetwork: { wsl: null },
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	return gateway;
}

async function expectLocalHandshake(target: Parameters<typeof connectTestClient>[0]): Promise<void> {
	const client = await connectTestClient(target);
	await client.close();
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-listener-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("mobile listen candidates", () => {
	it("keeps only external IPv4 addresses and sorts them", () => {
		const info = (address: string, family: string, internal: boolean) =>
			({ address, family, internal }) as unknown as NetworkInterfaceInfo;
		const candidates = mobileListenCandidates({
			eth0: [info("192.168.1.20", "IPv4", false), info("169.254.7.7", "IPv4", false), info("fe80::1", "IPv6", false)],
			lo: [info("127.0.0.1", "IPv4", true)],
			en1: [info("10.0.0.5", "IPv4", false), info("10.0.0.9", "IPv4", false)],
		});
		expect(candidates).toEqual(["10.0.0.5", "10.0.0.9", "192.168.1.20"]);
	});

	it("tolerates missing interfaces and empty entries", () => {
		expect(mobileListenCandidates({})).toEqual([]);
		expect(mobileListenCandidates({ eth0: undefined })).toEqual([]);
		expect(Array.isArray(mobileListenCandidates())).toBe(true);
	});

	it("excludes every documented virtual interface prefix", () => {
		const info = (address: string) => ({ address, family: "IPv4", internal: false }) as unknown as NetworkInterfaceInfo;
		const virtualNames = [
			"anpi1",
			"awdl0",
			"bridge100",
			"docker0",
			"gif0",
			"ipsec0",
			"llw0",
			"ppp0",
			"stf0",
			"tap0",
			"tun0",
			"utun4",
			"vboxnet0",
			"vethf0a1b2",
			"virbr0",
			"vmnet8",
		];
		const interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = Object.fromEntries(
			virtualNames.map((name, index) => [name, [info(`10.9.${index}.1`)]]),
		);
		interfaces.en0 = [info("192.168.31.71")];
		expect(mobileListenCandidates(interfaces)).toEqual(["192.168.31.71"]);
	});

	it("excludes Windows-style descriptive virtual interface names", () => {
		const info = (address: string) => ({ address, family: "IPv4", internal: false }) as unknown as NetworkInterfaceInfo;
		const candidates = mobileListenCandidates({
			Ethernet: [info("192.168.1.20")],
			"vEthernet (WSL)": [info("172.20.0.1")],
			"VMware Network Adapter VMnet1": [info("192.168.220.1")],
			"Hyper-V Virtual Ethernet Adapter": [info("192.168.250.1")],
			"VirtualBox Host-Only Network": [info("192.168.56.1")],
			"VPN 连接": [info("10.8.0.2")],
		});
		expect(candidates).toEqual(["192.168.1.20"]);
	});

	it("excludes the RFC 2544 benchmark range (198.18.0.0/15)", () => {
		const info = (address: string) => ({ address, family: "IPv4", internal: false }) as unknown as NetworkInterfaceInfo;
		const candidates = mobileListenCandidates({
			en0: [info("192.168.31.71"), info("198.18.0.1"), info("198.19.255.7"), info("198.20.0.1")],
		});
		expect(candidates).toEqual(["192.168.31.71", "198.20.0.1"]);
	});

	it("falls back to the unfiltered list when filtering leaves no address", () => {
		const info = (address: string) => ({ address, family: "IPv4", internal: false }) as unknown as NetworkInterfaceInfo;
		const onlyVirtual: NodeJS.Dict<NetworkInterfaceInfo[]> = {
			utun4: [info("198.18.0.1")],
			bridge100: [info("192.168.128.1")],
		};
		expect(mobileListenCandidates(onlyVirtual)).toEqual(["192.168.128.1", "198.18.0.1"]);
		expect(mobileListenCandidates({ utun4: [info("198.18.0.1")] })).toEqual(["198.18.0.1"]);
		expect(mobileListenCandidates({})).toEqual([]);
	});
});

describe("prioritizeListenCandidate", () => {
	it("moves the last connected address to the front and keeps the rest sorted", () => {
		expect(prioritizeListenCandidate(["10.0.0.5", "192.168.1.20"], "192.168.1.20")).toEqual([
			"192.168.1.20",
			"10.0.0.5",
		]);
	});

	it("leaves the list unchanged when the learned address is null or no longer present", () => {
		expect(prioritizeListenCandidate(["10.0.0.5", "192.168.1.20"], null)).toEqual(["10.0.0.5", "192.168.1.20"]);
		expect(prioritizeListenCandidate(["10.0.0.5", "192.168.1.20"], "198.18.0.1")).toEqual(["10.0.0.5", "192.168.1.20"]);
		expect(prioritizeListenCandidate([], null)).toEqual([]);
	});
});

describe("mobile gateway listener", () => {
	it("stays disabled by default, generates no certificate, and keeps local transports usable", async () => {
		const target = await makeGateway();
		try {
			expect(target.gateway.mobile.state).toEqual({ status: "disabled" });
			expect(existsSync(join(target.dir, "mobile", "tls", "cert.pem"))).toBe(false);
			expect(existsSync(join(target.dir, "mobile", "tls", "key.pem"))).toBe(false);
			await expectLocalHandshake(target);
		} finally {
			await cleanup(target);
		}
	});

	it("enters error when the configured port is occupied, keeps local transports alive, and retries cleanly", async () => {
		const port = await freePort();
		const blocker = await occupyPort("127.0.0.1", port);
		try {
			const store = await MobileStore.open(dir);
			await store.updateConfig({ enabled: true, address: "127.0.0.1", port });
			const gateway = await startIsolatedGateway(dir);
			try {
				const state = gateway.mobile.state;
				expect(state.status).toBe("error");
				if (state.status === "error") expect(state.error).toMatch(/EADDRINUSE/);
				expect((await MobileStore.open(dir)).getState().enabled).toBe(true);
				expect(existsSync(join(dir, "mobile", "tls", "cert.pem"))).toBe(true);
				await expectLocalHandshake(gateway);

				await closeServer(blocker);
				const retried = await gateway.mobile.enable({ address: "127.0.0.1", port });
				expect(retried).toEqual({ status: "listening", address: "127.0.0.1", port });
			} finally {
				await gateway.close();
			}
		} finally {
			await closeServer(blocker).catch(() => undefined);
		}
	});

	it("enters error when the configured address does not exist without blocking gateway startup", async () => {
		const store = await MobileStore.open(dir);
		await store.updateConfig({ enabled: true, address: "192.0.2.1", port: await freePort() });
		const gateway = await startIsolatedGateway(dir);
		try {
			const state = gateway.mobile.state;
			expect(state.status).toBe("error");
			if (state.status === "error") expect(state.error.length).toBeGreaterThan(0);
			await expectLocalHandshake(gateway);
		} finally {
			await gateway.close();
		}
	});

	it("enables and disables at runtime, serves 404 for unknown paths, and rejects unauthenticated upgrades", async () => {
		const target = await makeGateway();
		try {
			const port = await freePort();
			const state = await target.gateway.mobile.enable({ address: "127.0.0.1", port });
			expect(state).toEqual({ status: "listening", address: "127.0.0.1", port });
			expect((await MobileStore.open(target.dir)).getState()).toMatchObject({
				enabled: true,
				address: "127.0.0.1",
				port,
			});

			const missing = await httpsRequest(port, "/nope");
			expect(missing.status).toBe(404);
			const future = await httpsRequest(port, "/mobile/v1/pair");
			expect(future.status).toBe(404);

			const upgrade = await rawUpgrade(port, "/mobile/v1/ws");
			expect(upgrade.startsWith("HTTP/1.1 401")).toBe(true);
			expect(existsSync(join(target.dir, "mobile", "tls", "cert.pem"))).toBe(true);

			const disabled = await target.gateway.mobile.disable();
			expect(disabled).toEqual({ status: "disabled" });
			expect((await MobileStore.open(target.dir)).getState().enabled).toBe(false);
			await expect(httpsRequest(port, "/nope")).rejects.toThrow();
		} finally {
			await cleanup(target);
		}
	});

	it("reuses the persisted port when enable omits it", async () => {
		const target = await makeGateway();
		try {
			const port = await freePort();
			const first = await target.gateway.mobile.enable({ address: "127.0.0.1", port });
			expect(first).toEqual({ status: "listening", address: "127.0.0.1", port });
			expect((await target.gateway.mobile.disable()).status).toBe("disabled");

			const second = await target.gateway.mobile.enable({ address: "127.0.0.1" });
			expect(second).toEqual({ status: "listening", address: "127.0.0.1", port });
		} finally {
			await cleanup(target);
		}
	});

	it("restores the listener after restart without regenerating the certificate", async () => {
		const port = await freePort();
		const store = await MobileStore.open(dir);
		await store.updateConfig({ enabled: true, address: "127.0.0.1", port });
		let gateway = await startIsolatedGateway(dir);
		try {
			expect(gateway.mobile.state).toEqual({ status: "listening", address: "127.0.0.1", port });
		} finally {
			await gateway.close();
		}

		const certPath = join(dir, "mobile", "tls", "cert.pem");
		const certPem = await readFile(certPath, "utf8");
		const fingerprint = fingerprintOf(certPem);

		gateway = await startIsolatedGateway(dir);
		try {
			expect(gateway.mobile.state).toEqual({ status: "listening", address: "127.0.0.1", port });
			expect(await readFile(certPath, "utf8")).toBe(certPem);
			expect((await httpsRequest(port, "/")).status).toBe(404);
			expect(fingerprintOf(certPem)).toBe(fingerprint);
		} finally {
			await gateway.close();
		}
	});

	it("serializes conflicting enable calls so the last write wins without losing resources", async () => {
		const target = await makeGateway();
		try {
			const portA = await freePort();
			const portB = await freePort();
			const [first, second] = await Promise.all([
				target.gateway.mobile.enable({ address: "127.0.0.1", port: portA }),
				target.gateway.mobile.enable({ address: "127.0.0.1", port: portB }),
			]);
			expect(first.status).toBe("listening");
			expect(second).toEqual({ status: "listening", address: "127.0.0.1", port: portB });
			expect(target.gateway.mobile.state).toEqual({ status: "listening", address: "127.0.0.1", port: portB });
			await expect(httpsRequest(portA, "/")).rejects.toThrow();
			expect((await httpsRequest(portB, "/")).status).toBe(404);
		} finally {
			await cleanup(target);
		}
	});

	it("rejects invalid listen addresses before touching the store", async () => {
		const target = await makeGateway();
		try {
			await expect(target.gateway.mobile.enable({ address: "0.0.0.0" })).rejects.toThrow("0.0.0.0");
			await expect(target.gateway.mobile.enable({ address: "not-an-ip" })).rejects.toThrow("IPv4");
			await expect(target.gateway.mobile.enable({ address: "256.1.1.1" })).rejects.toThrow("IPv4");
			expect(target.gateway.mobile.state).toEqual({ status: "disabled" });
			expect((await MobileStore.open(target.dir)).getState().enabled).toBe(false);
		} finally {
			await cleanup(target);
		}
	});

	it("releases the port on close, tolerates repeated close, and refuses enable after close", async () => {
		const target = await makeGateway();
		const port = await freePort();
		await target.gateway.mobile.enable({ address: "127.0.0.1", port });
		expect((await httpsRequest(port, "/")).status).toBe(404);

		await target.gateway.close();
		await target.gateway.close();
		expect(target.gateway.mobile.state).toEqual({ status: "disabled" });
		await expect(target.gateway.mobile.enable({ address: "127.0.0.1", port })).rejects.toThrow("closed");
		await expect(httpsRequest(port, "/")).rejects.toThrow();
		await rm(target.dir, { recursive: true, force: true });
	});
});
