import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { installShutdown, type ShutdownProcess, stopGatewayProcess } from "../src/index.ts";
import { IS_WINDOWS } from "./helpers.ts";

function fakeProcess(platform: NodeJS.Platform = "linux") {
	const listeners = new Map<string, Array<() => void>>();
	const proc: ShutdownProcess = {
		platform,
		on(signal, listener) {
			listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
		},
		off(signal, listener) {
			listeners.set(
				signal,
				(listeners.get(signal) ?? []).filter((item) => item !== listener),
			);
		},
	};
	return {
		proc,
		listeners,
		emit(signal: NodeJS.Signals) {
			for (const listener of [...(listeners.get(signal) ?? [])]) listener();
		},
	};
}

const tick = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("installShutdown", () => {
	it("runs cleanup once and exits 0, even when signalled by several sources", async () => {
		const fake = fakeProcess();
		const exits: number[] = [];
		let cleanups = 0;
		const shutdown = installShutdown({ process: fake.proc, exit: (code) => void exits.push(code), timeoutMs: 1_000 });
		shutdown.setCleanup(async () => {
			cleanups++;
		});
		fake.emit("SIGTERM");
		await tick();
		expect(cleanups).toBe(1);
		expect(exits).toEqual([0]);
		expect(shutdown.signal.aborted).toBe(true);
		shutdown.dispose();
	});

	it("exits immediately with 130 on a second signal while cleanup is stuck", async () => {
		const fake = fakeProcess();
		const exits: number[] = [];
		const shutdown = installShutdown({ process: fake.proc, exit: (code) => void exits.push(code), timeoutMs: 10_000 });
		shutdown.setCleanup(() => new Promise<void>(() => {}));
		fake.emit("SIGINT");
		expect(exits).toEqual([]);
		fake.emit("SIGINT");
		expect(exits).toEqual([130]);
		shutdown.dispose();
	});

	it("force-exits with 1 when cleanup exceeds the time limit", async () => {
		const fake = fakeProcess();
		const exits: number[] = [];
		const shutdown = installShutdown({ process: fake.proc, exit: (code) => void exits.push(code), timeoutMs: 30 });
		shutdown.setCleanup(() => new Promise<void>(() => {}));
		fake.emit("SIGINT");
		await tick(80);
		expect(exits).toEqual([1]);
		shutdown.dispose();
	});

	it("exits 1 when cleanup fails and logs the reason", async () => {
		const fake = fakeProcess();
		const exits: number[] = [];
		const logs: string[] = [];
		const shutdown = installShutdown({
			process: fake.proc,
			exit: (code) => void exits.push(code),
			log: (message) => void logs.push(message),
		});
		shutdown.setCleanup(async () => {
			throw new Error("boom");
		});
		fake.emit("SIGINT");
		await tick();
		expect(exits).toEqual([1]);
		expect(logs).toContain("boom");
		shutdown.dispose();
	});

	it("runs cleanup registered after the signal and aborts startup work", async () => {
		const fake = fakeProcess();
		const exits: number[] = [];
		const shutdown = installShutdown({ process: fake.proc, exit: (code) => void exits.push(code), timeoutMs: 1_000 });
		fake.emit("SIGINT");
		expect(shutdown.signal.aborted).toBe(true);
		expect(exits).toEqual([]);
		shutdown.setCleanup(async () => {});
		await tick();
		expect(exits).toEqual([0]);
		shutdown.dispose();
	});

	it("trigger runs the signal flow: cleanup once, repeated trigger force-exits", async () => {
		const fake = fakeProcess();
		const exits: number[] = [];
		const logs: string[] = [];
		const shutdown = installShutdown({
			process: fake.proc,
			exit: (code) => void exits.push(code),
			log: (message) => void logs.push(message),
			timeoutMs: 10_000,
		});
		let cleanups = 0;
		shutdown.setCleanup(() => {
			cleanups++;
			return new Promise<void>(() => {});
		});
		shutdown.trigger("stdin closed");
		expect(shutdown.signal.aborted).toBe(true);
		expect(cleanups).toBe(1);
		expect(logs.some((line) => line.includes("stdin closed"))).toBe(true);
		shutdown.trigger("stdin closed");
		expect(exits).toEqual([130]);
		expect(cleanups).toBe(1);
		shutdown.dispose();
	});

	it("trigger force-exits with 1 when cleanup exceeds the time limit", async () => {
		const fake = fakeProcess();
		const exits: number[] = [];
		const shutdown = installShutdown({ process: fake.proc, exit: (code) => void exits.push(code), timeoutMs: 30 });
		shutdown.setCleanup(() => new Promise<void>(() => {}));
		shutdown.trigger("stdin closed");
		await tick(80);
		expect(exits).toEqual([1]);
		shutdown.dispose();
	});

	it("listens to SIGBREAK only on Windows and removes listeners on dispose", () => {
		const linux = fakeProcess("linux");
		const win = fakeProcess("win32");
		const a = installShutdown({ process: linux.proc, exit: () => {} });
		const b = installShutdown({ process: win.proc, exit: () => {} });
		expect(linux.listeners.has("SIGBREAK")).toBe(false);
		expect(win.listeners.get("SIGBREAK")?.length).toBe(1);
		expect(win.listeners.get("SIGHUP")?.length).toBe(1);
		b.dispose();
		expect(win.listeners.get("SIGBREAK")?.length).toBe(0);
		a.dispose();
	});

	it("tolerates platforms that reject a signal", () => {
		const exits: number[] = [];
		const proc: ShutdownProcess = {
			platform: "linux",
			on(signal) {
				if (signal === "SIGHUP") throw new Error("unsupported");
			},
			off() {},
		};
		const shutdown = installShutdown({ process: proc, exit: (code) => void exits.push(code) });
		shutdown.dispose();
		expect(exits).toEqual([]);
	});
});

describe.skipIf(IS_WINDOWS)("stopGatewayProcess", () => {
	it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
		const child = spawn("sh", ["-c", 'trap "" TERM; while true; do sleep 1; done'], { stdio: "ignore" });
		await tick(100);
		const started = Date.now();
		await stopGatewayProcess(child, { gracefulMs: 200, forcedMs: 2_000 });
		expect(Date.now() - started).toBeLessThan(1_800);
		expect(child.signalCode).toBe("SIGKILL");
	});

	it("returns immediately for a child that already exited", async () => {
		const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
		await new Promise((resolve) => child.once("exit", resolve));
		await stopGatewayProcess(child);
	});
});
