import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";

export type PathKind = "file" | "directory" | "missing";

/** Everything the probe touches, injected so the probe runs (and is tested) on any platform. */
export type WindowsShellDeps = {
	readonly env: Readonly<Record<string, string | undefined>>;
	kind(path: string): PathKind;
	/** Results of `where <program>`, in PATH order; empty when none or `where` is unavailable. */
	where(program: string): readonly string[];
};

export type WindowsShellStatus =
	| { readonly kind: "found"; readonly path: string; readonly source: "config" | "auto" }
	| {
			readonly kind: "missing";
			readonly reason: "not_found" | "invalid_config";
			readonly detail: string;
			readonly searched: readonly string[];
	  };

/** What a gateway or UI needs to know; the paths searched stay inside the error message. */
export type WindowsShellSummary =
	| { readonly status: "ready"; readonly path: string; readonly source: "config" | "auto" }
	| { readonly status: "missing"; readonly reason: "not_found" | "invalid_config"; readonly detail?: string };

/** WSL's launchers: System32 and Sysnative bash.exe, and the Store launcher under WindowsApps. */
export function isWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return (
		/^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized) ||
		/\\microsoft\\windowsapps\\(?:[^\\]+\\)*bash\.exe$/.test(normalized)
	);
}

function envValue(env: WindowsShellDeps["env"], name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value) return value;
	return undefined;
}

/** `<root>\bin\bash.exe` of the Git for Windows install that owns this `git.exe`, if it is laid out like one. */
function bashBesideGit(gitExe: string): string | undefined {
	const dir = win32.dirname(gitExe);
	const parent = win32.dirname(dir);
	const name = win32.basename(dir).toLowerCase();
	if (name === "cmd") return win32.join(parent, "bin", "bash.exe");
	if (name === "bin") {
		const root = win32.basename(parent).toLowerCase() === "mingw64" ? win32.dirname(parent) : parent;
		return win32.join(root, "bin", "bash.exe");
	}
	return undefined;
}

function configProblem(path: string, kind: PathKind): string | undefined {
	if (isWslBashPath(path)) return "it is WSL's bash, which is not supported (commands must run in Git Bash)";
	if (kind === "missing") return "the file does not exist";
	if (kind === "directory") return "it is a directory, not bash.exe";
	return undefined;
}

/**
 * Pick the bash that Windows commands run in: `shell.path`, then the standard Git for Windows locations, then the
 * install that owns the `git.exe` on PATH, then any non-WSL `bash.exe` on PATH. WSL launchers are never chosen, and a
 * bad `shell.path` is an error rather than a reason to fall back.
 */
export function resolveWindowsShell(deps: WindowsShellDeps, configPath?: string): WindowsShellStatus {
	if (configPath !== undefined && configPath !== "") {
		const problem = configProblem(configPath, deps.kind(configPath));
		if (problem !== undefined) {
			return {
				kind: "missing",
				reason: "invalid_config",
				detail: `shell.path "${configPath}" is invalid: ${problem}.`,
				searched: [configPath],
			};
		}
		return { kind: "found", path: configPath, source: "config" };
	}

	const searched: string[] = [];
	const check = (path: string): boolean => {
		if (!searched.includes(path)) searched.push(path);
		return !isWslBashPath(path) && deps.kind(path) === "file";
	};
	const roots = [
		envValue(deps.env, "ProgramFiles"),
		envValue(deps.env, "ProgramFiles(x86)"),
		(() => {
			const local = envValue(deps.env, "LOCALAPPDATA");
			return local === undefined ? undefined : win32.join(local, "Programs");
		})(),
	];
	for (const root of roots) {
		if (root === undefined) continue;
		const candidate = win32.join(root, "Git", "bin", "bash.exe");
		if (check(candidate)) return { kind: "found", path: candidate, source: "auto" };
	}
	for (const gitExe of deps.where("git.exe")) {
		const candidate = bashBesideGit(gitExe);
		if (candidate !== undefined && check(candidate)) return { kind: "found", path: candidate, source: "auto" };
	}
	for (const candidate of deps.where("bash.exe")) {
		if (check(candidate)) return { kind: "found", path: candidate, source: "auto" };
	}
	return { kind: "missing", reason: "not_found", detail: "No Git Bash was found.", searched };
}

export function summarizeWindowsShell(status: WindowsShellStatus): WindowsShellSummary {
	return status.kind === "found"
		? { status: "ready", path: status.path, source: status.source }
		: { status: "missing", reason: status.reason, detail: status.detail };
}

/** The tool error shown to the model (and so the user) when commands cannot run. */
export function windowsShellMessage(status: Extract<WindowsShellStatus, { kind: "missing" }>): string {
	const lines =
		status.reason === "invalid_config"
			? [
					`Cannot run shell commands: ${status.detail}`,
					"Fix shell.path in neko.config.json, or remove it to auto-detect Git Bash.",
				]
			: [
					"Cannot run shell commands: Git Bash was not found. neko runs commands in Git for Windows' bash, not PowerShell, cmd or WSL.",
					"Install Git for Windows (https://git-scm.com/download/win), or set shell.path in neko.config.json to its bash.exe.",
				];
	if (status.searched.length > 0) lines.push("Checked:", ...status.searched.map((path) => `  ${path}`));
	lines.push("File tools (read, write, edit) still work.");
	return lines.join("\n");
}

export function systemWindowsShellDeps(): WindowsShellDeps {
	return {
		env: process.env,
		kind(path) {
			try {
				return statSync(path).isDirectory() ? "directory" : "file";
			} catch {
				return "missing";
			}
		},
		where(program) {
			const result = spawnSync("where", [program], { encoding: "utf8", timeout: 5000, windowsHide: true });
			if (result.status !== 0 || typeof result.stdout !== "string") return [];
			return result.stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line !== "");
		},
	};
}

export const WINDOWS_SHELL_RETRY_MS = 30_000;

export type WindowsShellResolver = {
	/** Cached probe result: a found bash is re-checked on use, a missing one is re-probed after 30 s or on `refresh`. */
	status(options?: { readonly refresh?: boolean }): WindowsShellStatus;
};

export function createWindowsShellResolver(options?: {
	readonly configPath?: string | undefined;
	readonly deps?: WindowsShellDeps;
	readonly now?: () => number;
}): WindowsShellResolver {
	const deps = options?.deps ?? systemWindowsShellDeps();
	const now = options?.now ?? Date.now;
	let cached: { readonly status: WindowsShellStatus; readonly at: number } | undefined;
	return {
		status(call) {
			if (cached !== undefined && call?.refresh !== true) {
				if (cached.status.kind === "found") {
					if (deps.kind(cached.status.path) === "file") return cached.status;
				} else if (now() - cached.at < WINDOWS_SHELL_RETRY_MS) {
					return cached.status;
				}
			}
			cached = { status: resolveWindowsShell(deps, options?.configPath), at: now() };
			return cached.status;
		},
	};
}
