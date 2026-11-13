import { describe, expect, it } from "vitest";
import {
	createOpenService,
	describeTargets,
	detectWsl,
	type LaunchSpec,
	OpenError,
	type OpenHost,
	resolveLaunch,
} from "../src/open-target.ts";

function host(input: Partial<OpenHost> & { readonly files?: readonly string[] }): OpenHost {
	const files = new Set(input.files ?? []);
	return {
		platform: input.platform ?? "linux",
		wsl: input.wsl ?? false,
		env: input.env ?? {},
		home: input.home ?? "/home/me",
		exists: (path) => files.has(path),
	};
}

const DIR = '/work/my "proj" & more';

describe("open target resolution", () => {
	it("macOS prefers the code CLI and falls back to the app bundle", () => {
		const withCli = host({ platform: "darwin", env: { PATH: "/usr/local/bin:/bin" }, files: ["/usr/local/bin/code"] });
		expect(resolveLaunch(withCli, "vscode", DIR)).toEqual({ spec: { command: "/usr/local/bin/code", args: [DIR] } });
		const appOnly = host({
			platform: "darwin",
			env: { PATH: "/bin" },
			files: ["/Applications/Visual Studio Code.app"],
		});
		expect(resolveLaunch(appOnly, "vscode", DIR)).toEqual({
			spec: { command: "open", args: ["-a", "Visual Studio Code", DIR] },
		});
		expect(resolveLaunch(appOnly, "file-manager", DIR)).toEqual({ spec: { command: "open", args: [DIR] } });
		expect(describeTargets(appOnly).map((t) => t.label)).toEqual(["VS Code", "Finder"]);
	});

	it("macOS without VS Code reports the reason and keeps Finder available", () => {
		const none = host({ platform: "darwin", env: { PATH: "/bin" } });
		const [code, finder] = describeTargets(none);
		expect(code).toMatchObject({ id: "vscode", available: false });
		expect(code?.reason).toContain("VS Code");
		expect(finder).toMatchObject({ id: "file-manager", available: true });
	});

	it("Windows launches Code.exe next to the code.cmd shim without a shell", () => {
		const bin = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin";
		const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
		const win = host({
			platform: "win32",
			env: { Path: `C:\\Windows;${bin}` },
			files: [`${bin}\\code.cmd`, exe],
		});
		expect(resolveLaunch(win, "vscode", "C:\\My Proj")).toEqual({ spec: { command: exe, args: ["C:\\My Proj"] } });
		expect(resolveLaunch(win, "file-manager", "C:\\My Proj")).toEqual({
			spec: { command: "explorer.exe", args: ["C:\\My Proj"] },
		});
		expect(describeTargets(win).map((t) => t.label)).toEqual(["VS Code", "资源管理器"]);
	});

	it("Windows falls back to the standard install location and reports a missing install", () => {
		const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
		const std = host({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, files: [exe] });
		expect(resolveLaunch(std, "vscode", "C:\\p")).toEqual({ spec: { command: exe, args: ["C:\\p"] } });
		expect(resolveLaunch(host({ platform: "win32" }), "vscode", "C:\\p")).toHaveProperty("reason");
	});

	it("Linux uses code and xdg-open from PATH", () => {
		const linux = host({
			env: { PATH: "/usr/bin:/usr/local/bin" },
			files: ["/usr/local/bin/code", "/usr/bin/xdg-open"],
		});
		expect(resolveLaunch(linux, "vscode", DIR)).toEqual({ spec: { command: "/usr/local/bin/code", args: [DIR] } });
		expect(resolveLaunch(linux, "file-manager", DIR)).toEqual({ spec: { command: "/usr/bin/xdg-open", args: [DIR] } });
		expect(describeTargets(linux).map((t) => t.label)).toEqual(["VS Code", "文件管理器"]);
		expect(describeTargets(host({ env: { PATH: "/usr/bin" } })).every((t) => !t.available)).toBe(true);
	});

	it("WSL is treated as Windows: Explorer via interop with the directory as cwd", () => {
		const wsl = host({
			wsl: true,
			env: { PATH: "/usr/bin:/mnt/c/Windows" },
			files: ["/mnt/c/Windows/explorer.exe", "/usr/bin/code"],
		});
		expect(resolveLaunch(wsl, "file-manager", DIR)).toEqual({
			spec: { command: "/mnt/c/Windows/explorer.exe", args: ["."], cwd: DIR },
		});
		expect(resolveLaunch(wsl, "vscode", DIR)).toEqual({ spec: { command: "/usr/bin/code", args: [DIR] } });
		expect(describeTargets(wsl)[1]?.label).toBe("资源管理器");
		const noInterop = host({ wsl: true, env: { PATH: "/usr/bin" } });
		expect(resolveLaunch(noInterop, "file-manager", DIR)).toHaveProperty("reason");
	});

	it("detects WSL from the environment or /proc/version on Linux only", () => {
		const proc = () => "Linux version 5.15 (microsoft-standard-WSL2)";
		expect(detectWsl("linux", {}, proc)).toBe(true);
		expect(detectWsl("linux", { WSL_DISTRO_NAME: "Ubuntu" }, () => "Linux")).toBe(true);
		expect(detectWsl("linux", {}, () => "Linux version 6.1 generic")).toBe(false);
		expect(
			detectWsl("linux", {}, () => {
				throw new Error("no /proc");
			}),
		).toBe(false);
		expect(detectWsl("darwin", { WSL_DISTRO_NAME: "Ubuntu" }, proc)).toBe(false);
	});
});

describe("open service", () => {
	it("passes the resolved command to the launcher, one argument per path", async () => {
		const launched: LaunchSpec[] = [];
		const service = createOpenService({
			host: host({ platform: "darwin", files: ["/Applications/Visual Studio Code.app"] }),
			launch: async (spec) => {
				launched.push(spec);
			},
		});
		await service.open("vscode", DIR);
		expect(launched).toEqual([{ command: "open", args: ["-a", "Visual Studio Code", DIR] }]);
	});

	it("re-checks availability on every open", async () => {
		let installed = true;
		const live: OpenHost = {
			...host({ platform: "darwin" }),
			exists: (path) => installed && path === "/Applications/Visual Studio Code.app",
		};
		const service = createOpenService({ host: live, launch: async () => {} });
		await service.open("vscode", "/w");
		installed = false;
		const error = await service.open("vscode", "/w").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(OpenError);
		expect((error as OpenError).code).toBe("unavailable");
	});
});
