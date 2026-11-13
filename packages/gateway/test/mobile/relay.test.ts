import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildRelayScript,
	encodeRelayCommand,
	RelayError,
	type RelayOptions,
	startWindowsRelay,
} from "../../src/mobile/relay.ts";
import { IS_WINDOWS } from "../helpers.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-relay.ts", import.meta.url));

const endpoints = { listenAddress: "192.168.31.71", listenPort: 8330, targetAddress: "172.24.180.5", targetPort: 8330 };

function fakeSpawn(mode: string, extraEnv: Record<string, string> = {}): RelayOptions["spawn"] {
	return ((_command: string, _args: readonly string[], options: object) =>
		nodeSpawn(process.execPath, [FAKE], {
			...options,
			env: { ...process.env, FAKE_RELAY_MODE: mode, ...extraEnv },
		})) as unknown as RelayOptions["spawn"];
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("buildRelayScript", () => {
	it("embeds only validated IPv4 literals and ports", () => {
		const script = buildRelayScript(endpoints);
		expect(script).toContain("[NekoRelay]::Run('192.168.31.71',8330,'172.24.180.5',8330,8000)");
		expect(script).toContain("Add-Type -TypeDefinition $src -Language CSharp");
	});

	it("rejects anything that is not an IPv4 literal or a valid port", () => {
		expect(() => buildRelayScript({ ...endpoints, listenAddress: "1.2.3.4'; calc #" })).toThrow("IPv4");
		expect(() => buildRelayScript({ ...endpoints, targetAddress: "example.com" })).toThrow("IPv4");
		expect(() => buildRelayScript({ ...endpoints, listenPort: 0 })).toThrow("port");
		expect(() => buildRelayScript({ ...endpoints, targetPort: 70000 })).toThrow("port");
		expect(() => buildRelayScript({ ...endpoints, targetPort: 1.5 })).toThrow("port");
	});

	it("encodes the command as UTF-16LE base64 for -EncodedCommand", () => {
		const script = buildRelayScript(endpoints);
		expect(Buffer.from(encodeRelayCommand(script), "base64").toString("utf16le")).toBe(script);
	});
});

describe.skipIf(IS_WINDOWS)("startWindowsRelay lifecycle", () => {
	it("starts, heartbeats, and stops by closing stdin", async () => {
		const relay = await startWindowsRelay({
			...endpoints,
			powershell: "powershell.exe",
			spawn: fakeSpawn("ready", { FAKE_RELAY_WATCHDOG_MS: "400" }),
			heartbeatMs: 100,
		});
		let exited = false;
		void relay.exited.then(() => {
			exited = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(exited).toBe(false);
		await relay.stop();
		expect(exited).toBe(true);
		await relay.stop();
	});

	it("reports port conflicts and unreachable targets with distinct codes", async () => {
		await expect(
			startWindowsRelay({ ...endpoints, powershell: "powershell.exe", spawn: fakeSpawn("error-port") }),
		).rejects.toMatchObject({ name: "RelayError", code: "port_in_use" });
		await expect(
			startWindowsRelay({ ...endpoints, powershell: "powershell.exe", spawn: fakeSpawn("error-target") }),
		).rejects.toMatchObject({ code: "target_unreachable" });
	});

	it("includes stderr when PowerShell fails before the relay is ready", async () => {
		const error = await startWindowsRelay({
			...endpoints,
			powershell: "powershell.exe",
			spawn: fakeSpawn("crash-before-ready"),
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RelayError);
		expect((error as RelayError).code).toBe("start_failed");
		expect((error as RelayError).message).toContain("constrained language mode");
	});

	it("reports a missing powershell.exe", async () => {
		const error = await startWindowsRelay({
			...endpoints,
			powershell: "/nonexistent/powershell.exe",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RelayError);
		expect((error as RelayError).code).toBe("start_failed");
	});

	it("times out and kills a relay that never becomes ready", async () => {
		const pids: number[] = [];
		const spawnSpy = ((command: string, args: readonly string[], options: object) => {
			const child = (fakeSpawn("hang") as typeof nodeSpawn)(command, args, options as never);
			if (child.pid !== undefined) pids.push(child.pid);
			return child;
		}) as unknown as RelayOptions["spawn"];
		await expect(
			startWindowsRelay({
				...endpoints,
				powershell: "powershell.exe",
				spawn: spawnSpy,
				startTimeoutMs: 200,
				stopGraceMs: 200,
			}),
		).rejects.toMatchObject({ code: "timeout" });
		expect(pids.length).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(isAlive(pids[0] as number)).toBe(false);
	});

	it("resolves `exited` when the relay dies after being ready", async () => {
		const relay = await startWindowsRelay({
			...endpoints,
			powershell: "powershell.exe",
			spawn: fakeSpawn("crash-after-ready"),
		});
		expect(await relay.exited).toContain("exit code 5");
		await relay.stop();
	});

	it("force-kills a relay that ignores stdin EOF", async () => {
		const pids: number[] = [];
		const spawnSpy = ((command: string, args: readonly string[], options: object) => {
			const child = (fakeSpawn("ignore-eof") as typeof nodeSpawn)(command, args, options as never);
			if (child.pid !== undefined) pids.push(child.pid);
			return child;
		}) as unknown as RelayOptions["spawn"];
		const relay = await startWindowsRelay({
			...endpoints,
			powershell: "powershell.exe",
			spawn: spawnSpy,
			stopGraceMs: 200,
		});
		const started = Date.now();
		await relay.stop();
		expect(Date.now() - started).toBeLessThan(1_500);
		expect(isAlive(pids[0] as number)).toBe(false);
	});

	it("exits on its own when heartbeats stop (gateway killed)", async () => {
		const relay = await startWindowsRelay({
			...endpoints,
			powershell: "powershell.exe",
			spawn: fakeSpawn("ready", { FAKE_RELAY_WATCHDOG_MS: "300" }),
			heartbeatMs: 1_000_000,
		});
		const reason = await Promise.race([
			relay.exited,
			new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 2_000)),
		]);
		expect(reason).toContain("exit code 0");
		await relay.stop();
	});
});
