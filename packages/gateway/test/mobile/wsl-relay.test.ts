import { mkdtemp } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { createServer as createNetServer } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "../../../../test/temp-dir.ts";
import { MobileGateway, type MobileNetworkHooks } from "../../src/mobile/listener.ts";
import { RelayError, type RelayHandle, type RelayOptions } from "../../src/mobile/relay.ts";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const WINDOWS_LAN = "192.168.31.71";

const nic = (address: string): NetworkInterfaceInfo => ({
	address,
	netmask: "255.255.240.0",
	family: "IPv4",
	mac: "00:15:5d:00:00:01",
	internal: false,
	cidr: `${address}/20`,
});

async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no address");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

function reachable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const request = httpsGet({ host: "127.0.0.1", port, path: "/nope", rejectUnauthorized: false }, (response) => {
			response.resume();
			resolve(true);
		});
		request.on("error", () => resolve(false));
		request.end();
	});
}

type FakeRelay = {
	readonly options: RelayOptions;
	stopped: number;
	die(reason: string): void;
};

function relayHarness(plan: Array<RelayError | "ok"> = ["ok"]) {
	const relays: FakeRelay[] = [];
	let attempts = 0;
	const startRelay = async (options: RelayOptions): Promise<RelayHandle> => {
		const step = plan[Math.min(attempts, plan.length - 1)];
		attempts++;
		if (step instanceof RelayError) throw step;
		let resolveExit: (reason: string) => void = () => {};
		const exited = new Promise<string>((resolve) => {
			resolveExit = resolve;
		});
		const fake: FakeRelay = {
			options,
			stopped: 0,
			die: (reason) => resolveExit(reason),
		};
		relays.push(fake);
		return {
			exited,
			async stop() {
				fake.stopped++;
				resolveExit("stopped");
			},
		};
	};
	return { relays, startRelay, attempts: () => attempts };
}

describe("mobile gateway in WSL", () => {
	let dir: string;
	let gateway: MobileGateway | undefined;
	const chord = { accept() {}, async invalidatePrincipal() {} };

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "neko-mobile-wsl-"));
	});
	afterEach(async () => {
		await gateway?.close().catch(() => undefined);
		gateway = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	const create = async (network: MobileNetworkHooks) => {
		gateway = await MobileGateway.create({ nekoDir: dir, serverId: SERVER_ID, chord, network });
		return gateway;
	};

	const wslNat = (extra: Partial<MobileNetworkHooks> = {}): MobileNetworkHooks => ({
		wsl: { powershell: "powershell.exe" },
		windowsCandidates: async () => [WINDOWS_LAN],
		// 测试中用回环作为「WSL 内部地址」，使监听真实可达。
		localInterfaces: () => ({ eth0: [nic("127.0.0.1")] }),
		...extra,
	});

	it("advertises the Windows LAN address, listens on the WSL address and relays between them", async () => {
		const harness = relayHarness();
		const mobile = await create(wslNat({ startRelay: harness.startRelay }));
		const port = await freePort();
		const state = await mobile.enable({ address: WINDOWS_LAN, port });
		expect(state).toEqual({
			status: "listening",
			address: WINDOWS_LAN,
			port,
			mode: "wsl-relay",
			bindAddress: "127.0.0.1",
		});
		expect(harness.relays).toHaveLength(1);
		expect(harness.relays[0]?.options).toMatchObject({
			listenAddress: WINDOWS_LAN,
			listenPort: port,
			targetAddress: "127.0.0.1",
			targetPort: port,
		});
		expect(await reachable(port)).toBe(true);

		const { pairingText } = mobile.createPairing();
		const payload = JSON.parse(Buffer.from(pairingText.split(":")[2] ?? "", "base64url").toString("utf8"));
		expect(payload.ep).toBe(`https://${WINDOWS_LAN}:${port}`);
	});

	it("offers only Windows addresses as candidates and reports WSL status", async () => {
		const mobile = await create(wslNat());
		const state = await mobile.adminState();
		expect(state.candidates).toEqual([WINDOWS_LAN]);
		expect(state.wsl).toEqual({ interop: true, error: null });
	});

	it("reports an unreadable Windows address list without offering WSL addresses", async () => {
		const mobile = await create(
			wslNat({
				windowsCandidates: async () => {
					throw new Error("powershell timed out");
				},
			}),
		);
		const state = await mobile.adminState();
		expect(state.candidates).toEqual([]);
		expect(state.wsl?.error).toContain("powershell timed out");
	});

	it("refuses to start without interop instead of exposing an unreachable WSL address", async () => {
		const mobile = await create({
			wsl: { powershell: undefined },
			localInterfaces: () => ({ eth0: [nic("127.0.0.1")] }),
		});
		const state = await mobile.adminState();
		expect(state.candidates).toEqual([]);
		expect(state.wsl?.interop).toBe(false);
		const port = await freePort();
		await expect(mobile.enable({ address: "127.0.0.1", port })).rejects.toThrow("互操作");
		expect(mobile.state.status).toBe("error");
		expect(await reachable(port)).toBe(false);
	});

	it("rejects an address that is not a current Windows LAN address (e.g. a stale WSL 172.x)", async () => {
		const harness = relayHarness();
		const mobile = await create(wslNat({ startRelay: harness.startRelay }));
		const port = await freePort();
		await expect(mobile.enable({ address: "172.24.180.5", port })).rejects.toThrow("不是当前可用的 Windows 局域网地址");
		expect(harness.attempts()).toBe(0);
		expect(await reachable(port)).toBe(false);
	});

	it("listens directly without a relay when the address belongs to a WSL interface (mirrored)", async () => {
		const harness = relayHarness();
		const mobile = await create(
			wslNat({
				windowsCandidates: async () => ["127.0.0.1"],
				localInterfaces: () => ({ eth0: [nic("127.0.0.1")] }),
				startRelay: harness.startRelay,
			}),
		);
		const port = await freePort();
		const state = await mobile.enable({ address: "127.0.0.1", port });
		expect(state).toEqual({ status: "listening", address: "127.0.0.1", port });
		expect(harness.attempts()).toBe(0);
	});

	it("never starts a relay outside WSL", async () => {
		const harness = relayHarness();
		const mobile = await create({ wsl: null, startRelay: harness.startRelay });
		const port = await freePort();
		expect(await mobile.enable({ address: "127.0.0.1", port })).toEqual({
			status: "listening",
			address: "127.0.0.1",
			port,
		});
		expect(harness.attempts()).toBe(0);
		expect((await mobile.adminState()).wsl).toBeNull();
	});

	it("stops the relay when mobile access is disabled and when the gateway closes", async () => {
		const harness = relayHarness();
		const mobile = await create(wslNat({ startRelay: harness.startRelay }));
		const port = await freePort();
		await mobile.enable({ address: WINDOWS_LAN, port });
		await mobile.disable();
		expect(harness.relays[0]?.stopped).toBe(1);
		expect(mobile.state).toEqual({ status: "disabled" });
		expect(await reachable(port)).toBe(false);

		await mobile.enable({ address: WINDOWS_LAN, port });
		expect(harness.relays).toHaveLength(2);
		await mobile.close();
		expect(harness.relays[1]?.stopped).toBe(1);
	});

	it("restarts the relay when the port changes", async () => {
		const harness = relayHarness();
		const mobile = await create(wslNat({ startRelay: harness.startRelay }));
		const first = await freePort();
		await mobile.enable({ address: WINDOWS_LAN, port: first });
		const second = await freePort();
		await mobile.enable({ address: WINDOWS_LAN, port: second });
		expect(harness.relays).toHaveLength(2);
		expect(harness.relays[0]?.stopped).toBe(1);
		expect(harness.relays[1]?.options.listenPort).toBe(second);
	});

	it("turns an unexpected relay exit into an error state and invalidates pairing", async () => {
		const harness = relayHarness();
		const errors: string[] = [];
		gateway = await MobileGateway.create({
			nekoDir: dir,
			serverId: SERVER_ID,
			chord,
			onError: (error) => void errors.push(error.message),
			network: wslNat({ startRelay: harness.startRelay }),
		});
		const port = await freePort();
		await gateway.enable({ address: WINDOWS_LAN, port });
		gateway.createPairing();
		harness.relays[0]?.die("exit code 5");
		for (let i = 0; i < 50 && gateway.state.status === "listening"; i++) await new Promise((r) => setTimeout(r, 20));
		expect(gateway.state.status).toBe("error");
		if (gateway.state.status === "error") expect(gateway.state.error).toContain("中继意外退出");
		expect(errors.some((message) => message.includes("中继意外退出"))).toBe(true);
		expect(await reachable(port)).toBe(false);
		expect(() => gateway?.createPairing()).toThrow();
	});

	it("cleans up the listener and explains relay failures", async () => {
		const port = await freePort();
		const cases: Array<[RelayError, string]> = [
			[new RelayError("target_unreachable", "Connection refused"), "无法连接到 WSL 内的监听地址"],
			[new RelayError("start_failed", "constrained language mode"), "constrained language mode"],
		];
		for (const [error, expected] of cases) {
			const harness = relayHarness([error]);
			const mobile = await create(wslNat({ startRelay: harness.startRelay }));
			await expect(mobile.enable({ address: WINDOWS_LAN, port })).rejects.toThrow(expected);
			expect(mobile.state.status).toBe("error");
			expect(await reachable(port)).toBe(false);
			await mobile.close();
		}
	});

	it("retries briefly while the Windows port is still held by a previous relay", async () => {
		const harness = relayHarness([
			new RelayError("port_in_use", "in use"),
			new RelayError("port_in_use", "in use"),
			"ok",
		]);
		const mobile = await create(
			wslNat({ startRelay: harness.startRelay, relayPortRetryMs: 2_000, relayPortRetryIntervalMs: 20 }),
		);
		const port = await freePort();
		const state = await mobile.enable({ address: WINDOWS_LAN, port });
		expect(state.status).toBe("listening");
		expect(harness.attempts()).toBe(3);
	});

	it("gives up with a clear message when the Windows port stays busy", async () => {
		const harness = relayHarness([new RelayError("port_in_use", "in use")]);
		const mobile = await create(
			wslNat({ startRelay: harness.startRelay, relayPortRetryMs: 100, relayPortRetryIntervalMs: 20 }),
		);
		const port = await freePort();
		await expect(mobile.enable({ address: WINDOWS_LAN, port })).rejects.toThrow("已被占用");
		expect(await reachable(port)).toBe(false);
	});
});
