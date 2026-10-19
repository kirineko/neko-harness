import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** 本机 VS Code 与文件管理器的探测、命令构造与拉起（不经 shell，路径只作为参数）。 */

export type OpenTargetId = "vscode" | "file-manager";
export const OPEN_TARGET_IDS: readonly OpenTargetId[] = ["vscode", "file-manager"];

export type OpenTargetInfo = {
	readonly id: OpenTargetId;
	readonly label: string;
	readonly available: boolean;
	/** 不可用时的原因，可直接展示给用户。 */
	readonly reason?: string;
};

export type LaunchSpec = { readonly command: string; readonly args: readonly string[]; readonly cwd?: string };

export type OpenHost = {
	readonly platform: NodeJS.Platform;
	/** WSL 按 Windows 处理：显示资源管理器，经 Windows 互操作拉起。 */
	readonly wsl: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
	exists(path: string): boolean;
};

export type OpenErrorCode = "invalid_target" | "unavailable" | "launch_failed";

export class OpenError extends Error {
	readonly code: OpenErrorCode;
	constructor(code: OpenErrorCode, message: string) {
		super(message);
		this.name = "OpenError";
		this.code = code;
	}
}

const LAUNCH_TIMEOUT_MS = 8000;
const MAC_APP = "Visual Studio Code";

export function isOpenTargetId(value: unknown): value is OpenTargetId {
	return value === "vscode" || value === "file-manager";
}

export function detectWsl(
	platform: NodeJS.Platform,
	env: Readonly<Record<string, string | undefined>>,
	procVersion: () => string,
): boolean {
	if (platform !== "linux") return false;
	if (env.WSL_DISTRO_NAME !== undefined && env.WSL_DISTRO_NAME !== "") return true;
	try {
		return /microsoft/i.test(procVersion());
	} catch {
		return false;
	}
}

export function systemOpenHost(): OpenHost {
	const platform = process.platform;
	return {
		platform,
		wsl: detectWsl(platform, process.env, () => readFileSync("/proc/version", "utf8")),
		env: process.env,
		home: homedir(),
		exists: existsSync,
	};
}

export function fileManagerLabel(host: OpenHost): string {
	if (host.platform === "darwin") return "Finder";
	if (host.platform === "win32" || host.wsl) return "资源管理器";
	return "文件管理器";
}

function findOnPath(host: OpenHost, names: readonly string[]): string | undefined {
	const windows = host.platform === "win32";
	const pathApi = windows ? win32 : posix;
	const raw = host.env[windows ? "Path" : "PATH"] ?? host.env.PATH ?? host.env.Path ?? "";
	for (const entry of raw.split(windows ? ";" : ":")) {
		if (entry === "") continue;
		for (const name of names) {
			const candidate = pathApi.join(entry, name);
			if (host.exists(candidate)) return candidate;
		}
	}
	return undefined;
}

function windowsCodeExecutable(host: OpenHost): string | undefined {
	const shim = findOnPath(host, ["code.cmd"]);
	if (shim !== undefined) {
		const exe = win32.join(win32.dirname(win32.dirname(shim)), "Code.exe");
		if (host.exists(exe)) return exe;
	}
	for (const [variable, suffix] of [
		["LOCALAPPDATA", "Programs\\Microsoft VS Code\\Code.exe"],
		["ProgramFiles", "Microsoft VS Code\\Code.exe"],
	] as const) {
		const base = host.env[variable];
		if (base === undefined || base === "") continue;
		const exe = win32.join(base, suffix);
		if (host.exists(exe)) return exe;
	}
	return undefined;
}

function macAppInstalled(host: OpenHost): boolean {
	return (
		host.exists(`/Applications/${MAC_APP}.app`) || host.exists(posix.join(host.home, "Applications", `${MAC_APP}.app`))
	);
}

/** 返回打开 `dir` 的命令；目标不可用时返回原因。 */
export function resolveLaunch(
	host: OpenHost,
	target: OpenTargetId,
	dir: string,
): { readonly spec: LaunchSpec } | { readonly reason: string } {
	if (target === "vscode") {
		if (host.platform === "win32") {
			const exe = windowsCodeExecutable(host);
			return exe !== undefined ? { spec: { command: exe, args: [dir] } } : { reason: "未找到 VS Code（Code.exe）" };
		}
		const code = findOnPath(host, ["code"]);
		if (code !== undefined) return { spec: { command: code, args: [dir] } };
		if (host.platform === "darwin" && macAppInstalled(host))
			return { spec: { command: "open", args: ["-a", MAC_APP, dir] } };
		return { reason: "未找到 VS Code（命令 code 不在 PATH 中）" };
	}
	if (host.platform === "darwin") return { spec: { command: "open", args: [dir] } };
	if (host.platform === "win32") return { spec: { command: "explorer.exe", args: [dir] } };
	if (host.wsl) {
		const explorer = findOnPath(host, ["explorer.exe"]);
		return explorer !== undefined
			? { spec: { command: explorer, args: ["."], cwd: dir } }
			: { reason: "未找到 explorer.exe（需启用 Windows 互操作）" };
	}
	const opener = findOnPath(host, ["xdg-open"]);
	return opener !== undefined ? { spec: { command: opener, args: [dir] } } : { reason: "未找到 xdg-open" };
}

export function describeTargets(host: OpenHost): OpenTargetInfo[] {
	return OPEN_TARGET_IDS.map((id) => {
		const resolved = resolveLaunch(host, id, "");
		const label = id === "vscode" ? "VS Code" : fileManagerLabel(host);
		return "spec" in resolved
			? { id, label, available: true }
			: { id, label, available: false, reason: resolved.reason };
	});
}

/** 启动成功即返回（不等待进程退出，explorer.exe 成功时也可能返回非 0）；启动失败或超时拒绝。 */
export function spawnDetached(spec: LaunchSpec): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(spec.command, [...spec.args], {
			cwd: spec.cwd,
			detached: true,
			stdio: "ignore",
			// 不能设 windowsHide：它让子进程以 SW_HIDE 启动，explorer.exe 的窗口会被创建但不可见（Code.exe 不受影响）。
		});
		const timer = setTimeout(() => reject(new OpenError("launch_failed", "启动超时")), LAUNCH_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(new OpenError("launch_failed", `无法启动：${error.message}`));
		});
		child.once("spawn", () => {
			clearTimeout(timer);
			child.unref();
			resolve();
		});
	});
}

export type OpenService = {
	targets(): OpenTargetInfo[];
	open(target: OpenTargetId, dir: string): Promise<void>;
};

export function createOpenService(
	options: { readonly host?: OpenHost; readonly launch?: (spec: LaunchSpec) => Promise<void> } = {},
): OpenService {
	const launch = options.launch ?? spawnDetached;
	const host = (): OpenHost => options.host ?? systemOpenHost();
	return {
		targets: () => describeTargets(host()),
		async open(target, dir) {
			// 每次拉起前重新探测，目标在会话期间被卸载时给出明确原因。
			const resolved = resolveLaunch(host(), target, dir);
			if (!("spec" in resolved)) throw new OpenError("unavailable", resolved.reason);
			await launch(resolved.spec);
		},
	};
}
