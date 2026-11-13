import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installedVersion, UpdateChecker } from "@neko-harness/core/application-updates";
import { newer, stableVersion, upgradeCommand } from "@neko-harness/core/application-version";

/** Runs `command` (npm, or this Node for the freshly installed entry) without a shell and returns its trimmed stdout. */
export type UpdateRunner = (command: string, args: string[], inherit?: boolean) => Promise<string>;
export type UpdateCommandOptions = {
	entry?: string;
	runningVersion: string;
	platform?: NodeJS.Platform;
	run?: UpdateRunner;
	checker?: UpdateChecker;
};
const UNSUPPORTED = "当前安装方式不支持自升级，请按原方式更新，或改用 npm install -g neko-harness 安装。";
const UNWRITABLE = "没有 npm 全局安装目录的写权限，升级失败。请手动运行：\nnpm install -g neko-harness@latest";
const runCommand: UpdateRunner = async (command, args, inherit = false) => {
	if (!inherit) {
		const { stdout } = await promisify(execFile)(command, args, { maxBuffer: 1048576 });
		return stdout.trim();
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed`))));
	});
	return "";
};
/**
 * Supported means: this package is the real, non-linked `neko-harness` directory inside npm's global `node_modules`.
 * An npm that belongs to another prefix reports a different root, so it can never touch a foreign installation.
 */
export async function confirmGlobalInstallation(
	entry: string,
	run: UpdateRunner = runCommand,
): Promise<{ manifest: string; entry: string; lock: string }> {
	const globalRoot = await realpath(await run("npm", ["root", "-g"]));
	const root = dirname(dirname(await realpath(entry)));
	const installed = join(globalRoot, "neko-harness");
	const manifest = join(root, "package.json");
	if (
		(await lstat(installed)).isSymbolicLink() ||
		(await realpath(installed)) !== root ||
		!(await installedVersion(manifest))
	)
		throw new Error("unsupported");
	return { manifest, entry: join(root, "dist", "neko.js"), lock: join(globalRoot, ".neko-update.lock") };
}
export async function acquireUpdateLock(path: string): Promise<() => Promise<void>> {
	const token = crypto.randomUUID();
	try {
		await stat(`${path}.reclaim`);
		throw new Error("升级进行中，请稍后重试。");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		await mkdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let owner: { pid: number; token: string };
		try {
			owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
		} catch {
			throw new Error("升级进行中，请稍后重试。");
		}
		if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("升级进行中，请稍后重试。");
		try {
			process.kill(owner.pid, 0);
			throw new Error("升级进行中，请稍后重试。");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("升级进行中，请稍后重试。");
		}
		// Serialize stale-owner reclamation so competing updaters cannot erase a new lock.
		const gate = `${path}.reclaim`;
		try {
			await mkdir(gate);
		} catch {
			throw new Error("升级进行中，请稍后重试。");
		}
		try {
			const current = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
			if (current.token !== owner.token) throw new Error("升级进行中，请稍后重试。");
			await rm(path, { recursive: true });
			await mkdir(path);
		} finally {
			await rm(gate, { recursive: true, force: true });
		}
	}
	try {
		await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, token }));
	} catch (error) {
		await rm(path, { recursive: true, force: true });
		throw error;
	}
	return async () => {
		try {
			const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
			if (owner.token === token) await rm(path, { recursive: true });
		} catch {}
	};
}
export async function updateCommand(options: UpdateCommandOptions): Promise<string> {
	if ((options.platform ?? process.platform) === "win32")
		return `请先退出 neko，然后运行：\n${upgradeCommand("win32")}\n完成后重新启动 neko。`;
	if (!stableVersion(options.runningVersion)) throw new Error(UNSUPPORTED);
	const run = options.run ?? runCommand;
	let install: Awaited<ReturnType<typeof confirmGlobalInstallation>>;
	try {
		install = await confirmGlobalInstallation(options.entry ?? fileURLToPath(import.meta.url), run);
	} catch {
		throw new Error(UNSUPPORTED);
	}
	let release: Awaited<ReturnType<typeof acquireUpdateLock>>;
	try {
		release = await acquireUpdateLock(install.lock);
	} catch (error) {
		// The lock lives next to the installation: no write access here means npm could not install either.
		if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error(UNWRITABLE);
		throw error;
	}
	const checker =
		options.checker ?? new UpdateChecker({ manifest: install.manifest, runningVersion: options.runningVersion });
	try {
		const state = await checker.check(true);
		const current = await installedVersion(install.manifest);
		if (state.checkState !== "ok" || !state.latestVersion || !current)
			throw new Error("检查失败，请重试 neko update。");
		if (!newer(state.latestVersion, current)) return `已是最新版 v${current}。`;
		await run("npm", ["install", "-g", `neko-harness@${state.latestVersion}`], true);
		const actual = await installedVersion(install.manifest);
		const fresh = await run(process.execPath, [install.entry, "--version"]);
		if (!actual || actual !== fresh || newer(state.latestVersion, actual))
			throw new Error("Installation verification failed");
		return `已升级至 v${actual}。重新启动 neko 生效。`;
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("检查失败")) throw error;
		throw new Error("升级失败，请重试 neko update。");
	} finally {
		checker.close();
		await release();
	}
}
