import { describe, expect, it } from "vitest";
import { mobileListenCandidates } from "../../src/mobile/network.ts";
import {
	detectWsl,
	parseWindowsInterfaces,
	primaryWslAddress,
	toInterfaceDict,
	WindowsAddressDiscovery,
	wslOwnAddresses,
} from "../../src/mobile/wsl.ts";

const exec = (allowed: string[]) => (path: string) => allowed.includes(path);

describe("detectWsl", () => {
	it("returns undefined outside Linux and outside WSL", () => {
		expect(detectWsl({ platform: "darwin", env: {}, readProcVersion: () => undefined })).toBeUndefined();
		expect(
			detectWsl({ platform: "linux", env: { PATH: "/usr/bin" }, readProcVersion: () => "Linux version 6.8 (gcc)" }),
		).toBeUndefined();
	});

	it("detects WSL by env or kernel version and finds powershell.exe on PATH", () => {
		const byEnv = detectWsl({
			platform: "linux",
			env: { WSL_DISTRO_NAME: "Ubuntu", PATH: "/usr/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0" },
			readProcVersion: () => undefined,
			isExecutable: exec(["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"]),
		});
		expect(byEnv?.powershell).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
		const byKernel = detectWsl({
			platform: "linux",
			env: { PATH: "/usr/bin" },
			readProcVersion: () => "Linux version 5.15.153.1-microsoft-standard-WSL2",
			isExecutable: () => false,
		});
		expect(byKernel).toEqual({ powershell: undefined });
	});

	it("falls back to the default System32 location when PATH has no powershell.exe", () => {
		const env = detectWsl({
			platform: "linux",
			env: { WSL_INTEROP: "/run/WSL/1_interop", PATH: "/usr/bin" },
			readProcVersion: () => undefined,
			isExecutable: exec(["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"]),
		});
		expect(env?.powershell).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
	});
});

describe("Windows address discovery", () => {
	const fixture = JSON.stringify([
		{ name: "vEthernet (WSL (Hyper-V firewall))", address: "172.24.176.1" },
		{ name: "Wi-Fi", address: "192.168.31.71" },
		{ name: "Wi-Fi", address: "169.254.10.2" },
		{ name: "Clash Meta", address: "198.18.0.1" },
		{ name: "VMware Network Adapter VMnet8", address: "192.168.200.1" },
		{ name: "Ethernet", address: "10.0.0.5" },
		{ name: "Ethernet", address: "not-an-ip" },
	]);

	it("keeps only addresses a phone can reach", async () => {
		const candidates = mobileListenCandidates(toInterfaceDict(parseWindowsInterfaces(fixture)));
		expect(candidates).toEqual(["10.0.0.5", "192.168.31.71"]);
		const discovered = await new WindowsAddressDiscovery({
			powershell: "powershell.exe",
			run: async () => fixture,
		}).candidates();
		expect(discovered).toEqual(["10.0.0.5", "192.168.31.71"]);
	});

	it("parses PowerShell's single-object, empty and BOM-prefixed output", () => {
		expect(parseWindowsInterfaces('\uFEFF{"name":"Wi-Fi","address":"192.168.1.9"}')).toEqual([
			{ name: "Wi-Fi", address: "192.168.1.9" },
		]);
		expect(parseWindowsInterfaces("  ")).toEqual([]);
		expect(parseWindowsInterfaces("[]")).toEqual([]);
		expect(() => parseWindowsInterfaces("not json")).toThrow();
	});

	it("never offers the WSL switch address, but still falls back to a VPN-only address", async () => {
		const discover = (output: string) =>
			new WindowsAddressDiscovery({ powershell: "powershell.exe", run: async () => output }).candidates();
		const onlyWsl = JSON.stringify([{ name: "vEthernet (WSL)", address: "172.24.176.1" }]);
		expect(await discover(onlyWsl)).toEqual([]);
		const vpnOnly = JSON.stringify([
			{ name: "vEthernet (WSL)", address: "172.24.176.1" },
			{ name: "Corp VPN", address: "10.8.0.6" },
		]);
		expect(await discover(vpnOnly)).toEqual(["10.8.0.6"]);
	});

	it("caches results briefly, shares concurrent reads and reports failures", async () => {
		let calls = 0;
		let now = 1_000;
		const discovery = new WindowsAddressDiscovery({
			powershell: "powershell.exe",
			cacheMs: 5_000,
			now: () => now,
			run: async () => {
				calls++;
				return fixture;
			},
		});
		const [a, b] = await Promise.all([discovery.candidates(), discovery.candidates()]);
		expect(a).toEqual(["10.0.0.5", "192.168.31.71"]);
		expect(b).toEqual(a);
		expect(calls).toBe(1);
		await discovery.candidates();
		expect(calls).toBe(1);
		now += 6_000;
		await discovery.candidates();
		expect(calls).toBe(2);
		discovery.invalidate();
		await discovery.candidates();
		expect(calls).toBe(3);

		const failing = new WindowsAddressDiscovery({
			powershell: "powershell.exe",
			run: async () => {
				throw new Error("spawn powershell.exe ENOENT");
			},
		});
		await expect(failing.candidates()).rejects.toThrow("ENOENT");
	});
});

describe("WSL own addresses", () => {
	const info = (address: string, internal = false) => ({
		address,
		netmask: "255.255.240.0",
		family: "IPv4" as const,
		mac: "00:15:5d:00:00:01",
		internal,
		cidr: `${address}/20`,
	});

	it("prefers eth0 and lists non-loopback IPv4 addresses", () => {
		const interfaces = { lo: [info("127.0.0.1", true)], docker0: [info("172.17.0.1")], eth0: [info("172.24.180.5")] };
		expect(primaryWslAddress(interfaces)).toBe("172.24.180.5");
		expect(wslOwnAddresses(interfaces)).toEqual(["172.17.0.1", "172.24.180.5"]);
		expect(primaryWslAddress({ lo: [info("127.0.0.1", true)] })).toBeUndefined();
	});

	it("detects mirrored mode when a Windows address exists on a WSL interface", () => {
		const mirrored = { eth0: [info("192.168.31.71")] };
		expect(wslOwnAddresses(mirrored)).toContain("192.168.31.71");
	});
});
