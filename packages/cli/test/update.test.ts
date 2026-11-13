import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { spawnProcess } from "../../../test/process.ts";
import { rm } from "../../../test/temp-dir.ts";
import { UpdateChecker } from "../../core/src/application-updates.ts";
import { acquireUpdateLock, confirmGlobalInstallation, updateCommand } from "../src/update.ts";

// The supported flow is POSIX-only: Windows always returns manual instructions, and the link fixtures need symlinks.
const posixIt = it.skipIf(process.platform === "win32");

/** Lays out `<dir>/lib/node_modules/neko-harness` the way `npm install -g` does and answers `npm root -g` with it. */
async function npmGlobal(dir: string) {
	const globalRoot = join(dir, "lib/node_modules"),
		root = join(globalRoot, "neko-harness"),
		manifest = join(root, "package.json");
	await mkdir(join(root, "dist"), { recursive: true });
	await writeFile(join(root, "dist/neko.js"), "fixture");
	await writeFile(join(root, "dist/cli.js"), "fixture");
	const write = (version: string) => writeFile(manifest, JSON.stringify({ name: "neko-harness", version }));
	await write("1.0.0");
	// The running module is the bundled CLI; verification must go through the launcher next to it.
	return { globalRoot, root, manifest, write, entry: join(root, "dist/cli.js"), launcher: join(root, "dist/neko.js") };
}

posixIt("only updates the same npm global installation and verifies a fresh executable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-update-cli-"));
	try {
		const { globalRoot, manifest, write, entry, launcher } = await npmGlobal(dir);
		let installations = 0,
			fail = false,
			fake = false;
		let latest = "1.1.0";
		const run = async (command: string, args: string[]) => {
			if (command === "npm" && args[0] === "root") {
				expect(args).toEqual(["root", "-g"]);
				return globalRoot;
			}
			if (command === "npm") {
				expect(args).toEqual(["install", "-g", "neko-harness@1.1.0"]);
				installations++;
				latest = "1.2.0"; // The registry tag moves after the install target has been selected.
				if (fail) throw new Error("npm failed");
				if (!fake) await write("1.1.0");
				return "";
			}
			expect(command).toBe(process.execPath);
			expect(args).toEqual([await realpath(launcher), "--version"]);
			return fake ? "1.0.0" : "1.1.0";
		};
		const checker = () =>
			new UpdateChecker({
				runningVersion: "1.0.0",
				manifest,
				cachePath: join(dir, "cache"),
				fetch: async () => Response.json({ name: "neko-harness", version: latest }),
			});
		expect(await updateCommand({ entry, runningVersion: "1.0.0", run, checker: checker() })).toContain(
			"已升级至 v1.1.0",
		);
		expect(latest).toBe("1.2.0");
		latest = "1.1.0";
		expect(await updateCommand({ entry, runningVersion: "1.0.0", run, checker: checker() })).toContain("已是最新版");
		expect(installations).toBe(1);
		await write("1.2.0");
		expect(await updateCommand({ entry, runningVersion: "1.0.0", run, checker: checker() })).toContain("v1.2.0");
		expect(installations).toBe(1);
		const offline = new UpdateChecker({
			runningVersion: "1.0.0",
			manifest,
			cachePath: join(dir, "offline-cache"),
			fetch: async () => new Response("offline", { status: 503 }),
		});
		await expect(updateCommand({ entry, runningVersion: "1.0.0", run, checker: offline })).rejects.toThrow("检查失败");
		await write("1.0.0");
		fail = true;
		await expect(updateCommand({ entry, runningVersion: "1.0.0", run, checker: checker() })).rejects.toThrow(
			"升级失败",
		);
		fail = false;
		latest = "1.1.0";
		fake = true;
		await expect(updateCommand({ entry, runningVersion: "1.0.0", run, checker: checker() })).rejects.toThrow(
			"升级失败",
		);
		expect(installations).toBe(3);

		// A second updater must not install while the first one owns the installation.
		fake = false;
		const release = await acquireUpdateLock(join(globalRoot, ".neko-update.lock"));
		await expect(updateCommand({ entry, runningVersion: "1.0.0", run, checker: checker() })).rejects.toThrow(
			"稍后重试",
		);
		expect(installations).toBe(3);
		await release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

posixIt("refuses installations that are not the npm global one, without installing anything", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-update-unsupported-"));
	try {
		const { globalRoot, root, entry } = await npmGlobal(dir);
		const npm = (answer: string | Error) => async (command: string, args: string[]) => {
			if (command !== "npm" || args[0] !== "root") throw new Error("Nothing may be installed or executed");
			if (answer instanceof Error) throw answer;
			return answer;
		};
		const refused = async (from: string, run: ReturnType<typeof npm>, runningVersion = "1.0.0") => {
			const error = await updateCommand({ entry: from, runningVersion, run }).catch((e: Error) => e);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("不支持自升级");
			expect((error as Error).message).toContain("npm install -g neko-harness");
		};
		// Source / development builds never reach npm.
		await refused(entry, npm(new Error("npm must not run")), "development");
		// A Bun (or any other) global directory and a project-local install: npm's global root is somewhere else.
		for (const other of [".bun/install/global/node_modules/neko-harness", "project/node_modules/neko-harness"]) {
			await mkdir(join(dir, other, "dist"), { recursive: true });
			await writeFile(join(dir, other, "package.json"), JSON.stringify({ name: "neko-harness", version: "1.0.0" }));
			await writeFile(join(dir, other, "dist/cli.js"), "fixture");
			await refused(join(dir, other, "dist/cli.js"), npm(globalRoot));
		}
		// `npm link`: the global entry is a symlink to a checkout.
		const linkedRoot = join(dir, "linked/lib/node_modules");
		await mkdir(linkedRoot, { recursive: true });
		await symlink(root, join(linkedRoot, "neko-harness"));
		await refused(entry, npm(linkedRoot));
		await expect(confirmGlobalInstallation(entry, npm(linkedRoot))).rejects.toThrow("unsupported");
		// npm is missing, or the installed manifest is not a stable neko-harness.
		await refused(entry, npm(new Error("spawn npm ENOENT")));
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "neko-harness", version: "1.0.0-beta.1" }));
		await refused(entry, npm(globalRoot));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// Root ignores directory permissions, so the fixture cannot be made unwritable there.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"reports an unwritable npm global directory with the manual command instead of escalating",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "neko-update-readonly-"));
		const { globalRoot, entry } = await npmGlobal(dir);
		try {
			await chmod(globalRoot, 0o555);
			const run = async (command: string, args: string[]) => {
				if (command === "npm" && args[0] === "root") return globalRoot;
				throw new Error("Nothing may be installed or executed");
			};
			const error = await updateCommand({ entry, runningVersion: "1.0.0", run }).catch((e: Error) => e);
			expect((error as Error).message).toContain("npm install -g neko-harness@latest");
			expect((error as Error).message).toContain("失败");
			expect((error as Error).message).not.toContain("已升级");
		} finally {
			await chmod(globalRoot, 0o755);
			await rm(dir, { recursive: true, force: true });
		}
	},
);
it("serializes update attempts and releases ownership", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-update-lock-")),
		lock = join(dir, "lock");
	try {
		const release = await acquireUpdateLock(lock);
		await expect(acquireUpdateLock(lock)).rejects.toThrow("稍后重试");
		await release();
		await (await acquireUpdateLock(lock))();
		await mkdir(lock);
		await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead" }));
		await (await acquireUpdateLock(lock))();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("only returns manual instructions on Windows, before touching installation or updates", async () => {
	for (const runningVersion of ["0.2.7", "development"]) {
		const text = await updateCommand({
			platform: "win32",
			runningVersion,
			get entry(): string {
				throw new Error("Installation must not be inspected");
			},
			get run(): never {
				throw new Error("npm must not be invoked");
			},
			get checker(): never {
				throw new Error("Updates must not be checked");
			},
		});
		expect(text).toBe("请先退出 neko，然后运行：\nnpm install -g neko-harness@latest\n完成后重新启动 neko。");
		expect(text).not.toContain("已升级");
		expect(text).not.toContain("已是最新版");
	}
});

it("documents manual Windows updates and rejects invalid update arguments", async () => {
	const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
	for (const args of [["--help"], ["--invalid"], ["--help", "extra"]]) {
		const child = spawnProcess([process.execPath, "--conditions=neko-source", entry, "update", ...args]);
		const [out, err, code] = await Promise.all([child.stdout, child.stderr, child.exited]);
		if (args.length === 1 && args[0] === "--help") {
			expect(code).toBe(0);
			expect(out).toContain("Windows：先退出 neko，再运行 npm install -g neko-harness@latest");
		} else {
			expect(code).not.toBe(0);
			expect(err).toContain("用法: neko update");
		}
	}
});
