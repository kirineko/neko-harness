import { expect, it } from "bun:test";
import {
	createWindowsShellResolver,
	isWslBashPath,
	type PathKind,
	resolveWindowsShell,
	summarizeWindowsShell,
	WINDOWS_SHELL_RETRY_MS,
	type WindowsShellDeps,
	windowsShellMessage,
} from "../src/windows-shell.ts";

function fakeDeps(options: {
	files?: string[];
	directories?: string[];
	where?: Record<string, string[]>;
	env?: Record<string, string>;
}): WindowsShellDeps & { calls: string[] } {
	const files = new Set((options.files ?? []).map((path) => path.toLowerCase()));
	const directories = new Set((options.directories ?? []).map((path) => path.toLowerCase()));
	const calls: string[] = [];
	return {
		calls,
		env: {
			ProgramFiles: "C:\\Program Files",
			"ProgramFiles(x86)": "C:\\Program Files (x86)",
			LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
			...options.env,
		},
		kind(path): PathKind {
			calls.push(`kind ${path}`);
			if (files.has(path.toLowerCase())) return "file";
			return directories.has(path.toLowerCase()) ? "directory" : "missing";
		},
		where(program) {
			calls.push(`where ${program}`);
			return options.where?.[program] ?? [];
		},
	};
}

const STANDARD = "C:\\Program Files\\Git\\bin\\bash.exe";
const USER_LEVEL = "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";

it("recognizes WSL launchers and nothing else", () => {
	for (const path of [
		"C:\\Windows\\System32\\bash.exe",
		"c:/windows/sysnative/bash.exe",
		"C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
		"C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\Ubuntu\\bash.exe",
	])
		expect(isWslBashPath(path)).toBe(true);
	for (const path of [STANDARD, "D:\\tools\\Git\\bin\\bash.exe", "C:\\msys64\\usr\\bin\\bash.exe"])
		expect(isWslBashPath(path)).toBe(false);
});

it("uses the standard Git for Windows install", () => {
	expect(resolveWindowsShell(fakeDeps({ files: [STANDARD, USER_LEVEL] }))).toEqual({
		kind: "found",
		path: STANDARD,
		source: "auto",
	});
});

it("finds a per-user install", () => {
	expect(resolveWindowsShell(fakeDeps({ files: [USER_LEVEL] }))).toEqual({
		kind: "found",
		path: USER_LEVEL,
		source: "auto",
	});
});

it("derives bash from the git.exe on PATH", () => {
	const root = "D:\\Dev\\Git";
	for (const gitExe of [`${root}\\cmd\\git.exe`, `${root}\\bin\\git.exe`, `${root}\\mingw64\\bin\\git.exe`]) {
		const status = resolveWindowsShell(fakeDeps({ files: [`${root}\\bin\\bash.exe`], where: { "git.exe": [gitExe] } }));
		expect(status).toEqual({ kind: "found", path: `${root}\\bin\\bash.exe`, source: "auto" });
	}
	const unrelated = resolveWindowsShell(
		fakeDeps({ files: ["D:\\Tools\\bin\\bash.exe"], where: { "git.exe": ["D:\\Tools\\tool\\git.exe"] } }),
	);
	expect(unrelated.kind).toBe("missing");
});

it("takes a non-WSL bash from PATH but never the WSL launchers", () => {
	const wsl = [
		"C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
		"C:\\Windows\\System32\\bash.exe",
		"C:\\Windows\\Sysnative\\bash.exe",
	];
	const only = resolveWindowsShell(fakeDeps({ files: wsl, where: { "bash.exe": wsl } }));
	expect(only.kind).toBe("missing");
	const withMsys = resolveWindowsShell(
		fakeDeps({
			files: [...wsl, "C:\\msys64\\usr\\bin\\bash.exe"],
			where: { "bash.exe": [...wsl, "C:\\msys64\\usr\\bin\\bash.exe"] },
		}),
	);
	expect(withMsys).toEqual({ kind: "found", path: "C:\\msys64\\usr\\bin\\bash.exe", source: "auto" });
});

it("reports every searched location when nothing is found", () => {
	const status = resolveWindowsShell(fakeDeps({}));
	expect(status.kind).toBe("missing");
	if (status.kind !== "missing") throw new Error("expected missing");
	expect(status.reason).toBe("not_found");
	expect(status.searched).toEqual([STANDARD, "C:\\Program Files (x86)\\Git\\bin\\bash.exe", USER_LEVEL]);
	const message = windowsShellMessage(status);
	expect(message).toContain("Git for Windows");
	expect(message).toContain("shell.path");
	expect(message).toContain(STANDARD);
	expect(summarizeWindowsShell(status)).toMatchObject({ status: "missing", reason: "not_found" });
});

it("honors shell.path without probing anything else", () => {
	const custom = "D:\\tools\\Git\\bin\\bash.exe";
	const deps = fakeDeps({ files: [custom, STANDARD] });
	expect(resolveWindowsShell(deps, custom)).toEqual({ kind: "found", path: custom, source: "config" });
	expect(deps.calls.some((call) => call.startsWith("where"))).toBe(false);
});

it("rejects a bad shell.path instead of falling back", () => {
	const cases: [string, string, Partial<Parameters<typeof fakeDeps>[0]>][] = [
		["C:\\Windows\\System32\\bash.exe", "WSL", { files: ["C:\\Windows\\System32\\bash.exe", STANDARD] }],
		["D:\\nope\\bash.exe", "does not exist", { files: [STANDARD] }],
		["D:\\tools", "directory", { files: [STANDARD], directories: ["D:\\tools"] }],
	];
	for (const [path, reason, options] of cases) {
		const status = resolveWindowsShell(fakeDeps(options), path);
		if (status.kind !== "missing") throw new Error(`expected missing for ${path}`);
		expect(status.reason).toBe("invalid_config");
		expect(status.detail).toContain(path);
		expect(status.detail).toContain(reason);
		expect(windowsShellMessage(status)).toContain("shell.path");
	}
});

it("caches a found bash, re-checking that the file still exists", () => {
	const files = new Set([STANDARD]);
	const deps = fakeDeps({});
	let probes = 0;
	const resolver = createWindowsShellResolver({
		deps: {
			...deps,
			kind: (path) => (files.has(path) ? "file" : "missing"),
			where: (program) => {
				probes++;
				return deps.where(program);
			},
		},
	});
	expect(resolver.status().kind).toBe("found");
	files.delete(STANDARD);
	files.add(USER_LEVEL);
	expect(resolver.status()).toEqual({ kind: "found", path: USER_LEVEL, source: "auto" });
	expect(probes).toBe(0);
});

it("re-probes a missing result after the retry window or on refresh", () => {
	const files = new Set<string>();
	let clock = 1_000;
	let probes = 0;
	const base = fakeDeps({});
	const resolver = createWindowsShellResolver({
		now: () => clock,
		deps: {
			...base,
			kind: (path) => (files.has(path) ? "file" : "missing"),
			where: () => {
				probes++;
				return [];
			},
		},
	});
	expect(resolver.status().kind).toBe("missing");
	const first = probes;
	files.add(STANDARD);
	clock += WINDOWS_SHELL_RETRY_MS - 1;
	expect(resolver.status().kind).toBe("missing");
	expect(probes).toBe(first);
	expect(resolver.status({ refresh: true }).kind).toBe("found");
	files.clear();
	expect(resolver.status().kind).toBe("missing");
	files.add(STANDARD);
	clock += WINDOWS_SHELL_RETRY_MS;
	expect(resolver.status().kind).toBe("found");
});
