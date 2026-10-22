import { expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "@earendil-works/pi-env";
import { rm } from "../../../test/temp-dir.ts";
import { FILE_CACHE_LIMITS, WorkspaceFiles } from "../src/workspace-files.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

it("restarts a lost helper, invalidates other cached directories and keeps shared queries usable", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neko-helper-restart-")));
	const files = new WorkspaceFiles();
	const info = Connection.prototype.info;
	const pids: number[] = [];
	const observed = spyOn(Connection.prototype, "info").mockImplementation(async function (this: Connection) {
		const value = await info.call(this);
		pids.push(value.pid);
		return value;
	});
	const signal = new AbortController().signal;
	try {
		await mkdir(join(root, "a"));
		await mkdir(join(root, "b"));
		await writeFile(join(root, "a/item.ts"), "");
		await files.search(root, "a/item", signal);
		const calls = pids.length;
		await files.search(root, "a/ite", signal);
		expect(pids).toHaveLength(calls);
		expect(new Set(pids).size).toBe(1);
		process.kill(pids[0]!, "SIGTERM");
		// Windows terminates the helper asynchronously; a request sent before the exit is seen fails once with "connection lost".
		for (let n = 0; n < 100 && isAlive(pids[0]!); n++) await Bun.sleep(20);
		await Bun.sleep(20);
		await writeFile(join(root, "a/after.ts"), "");
		await files.search(root, "b/", signal);
		expect(pids.at(-1)).not.toBe(pids[0]);
		expect((await files.search(root, "a/after", signal)).entries[0]?.path).toBe("a/after.ts");
		expect(files.stats.active).toBe(0);
	} finally {
		observed.mockRestore();
		await files.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("discovers files without fd, shares scans, refreshes and exposes incomplete trees", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neko-pi-env-")));
	const files = new WorkspaceFiles({ ...FILE_CACHE_LIMITS, ttlMs: 40, idleMs: 1000, maxEntries: 3 });
	try {
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(root, ".gitignore"), "ignored/\n");
		await mkdir(join(root, "ignored"));
		await writeFile(join(root, "ignored/hidden.ts"), "hidden");
		await writeFile(join(root, "a.ts"), "no contents in index");
		await mkdir(join(root, "z"));
		await writeFile(join(root, "z/target.ts"), "target");
		const [a, b] = await Promise.all([
			files.search(root, "a", new AbortController().signal),
			files.search(root, "a", new AbortController().signal),
		]);
		expect(a).toEqual(b);
		expect(a.entries.some((e) => e.path === "a.ts")).toBe(true);
		expect(JSON.stringify(a)).not.toContain("no contents");
		expect(a.incomplete).toBe(true);
		expect((await files.search(root, "missing", new AbortController().signal)).incomplete).toBe(true);
		expect((await files.search(root, "z/target", new AbortController().signal)).entries[0]?.path).toBe("z/target.ts");
		await writeFile(join(root, "z/new.ts"), "new");
		await Bun.sleep(50);
		// The watcher can report the write while this refresh scan runs, which asks the caller to retry.
		const fresh = async () => {
			for (let n = 0; ; n++) {
				try {
					return await files.search(root, "z/new", new AbortController().signal);
				} catch (error) {
					if (n >= 5 || !(error instanceof Error) || !error.message.includes("changed")) throw error;
				}
			}
		};
		expect((await fresh()).entries[0]?.path).toBe("z/new.ts");
		await expect(files.search(root, "../escape", new AbortController().signal)).rejects.toThrow();
		const controller = new AbortController();
		controller.abort();
		await expect(files.search(root, "a", controller.signal)).rejects.toThrow();
	} finally {
		await files.close();
		await rm(root, { recursive: true, force: true });
	}
});

it("uses Git ignores only in work trees, includes hidden files, and ignores fd-specific rules", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neko-ignore-policy-")));
	const files = new WorkspaceFiles();
	const signal = new AbortController().signal;
	const untilCount = async (query: string, count: number) => {
		for (let n = 0; n < 150; n++) {
			try {
				if ((await files.search(root, query, signal)).entries.length === count) return;
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("changed")) throw error;
			}
			await Bun.sleep(20);
		}
		throw new Error(`Watch did not refresh ${query}`);
	};
	try {
		await writeFile(join(root, ".gitignore"), "drop.txt\n");
		await writeFile(join(root, ".ignore"), "keep.txt\n");
		await writeFile(join(root, ".fdignore"), "keep.txt\n");
		await writeFile(join(root, "drop.txt"), "");
		await writeFile(join(root, "keep.txt"), "");
		await writeFile(join(root, ".hidden"), "");
		expect((await files.search(root, "drop", signal)).entries).toContainEqual({
			name: "drop.txt",
			path: "drop.txt",
			kind: "file",
		});
		await mkdir(join(root, ".git/info"), { recursive: true });
		await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		files.remove(root);
		expect((await files.search(root, "drop", signal)).entries).toEqual([]);
		expect((await files.search(root, "keep", signal)).entries).toHaveLength(1);
		expect((await files.search(root, "hidden", signal)).entries).toHaveLength(1);
		await writeFile(join(root, "srcManager.ts"), "");
		await writeFile(join(root, "SuperManager.ts"), "");
		files.remove(root);
		expect((await files.search(root, "smt", signal)).entries).toHaveLength(2);
		expect((await files.search(root, "SM", signal)).entries.map((entry) => entry.name)).toEqual(["SuperManager.ts"]);
		await writeFile(join(root, ".git/info/exclude"), "keep.txt\n");
		await untilCount("keep", 0);
		await writeFile(join(root, ".gitignore"), "");
		await untilCount("drop", 1);
		await writeFile(join(root, ".gitignore"), "drop.txt\n");
		await untilCount("drop", 0);
		await writeFile(join(root, "created.ts"), "");
		await untilCount("created", 1);
		await rename(join(root, "created.ts"), join(root, "renamed.ts"));
		await untilCount("created", 0);
		await untilCount("renamed", 1);
		await rm(join(root, "renamed.ts"));
		await untilCount("renamed", 0);
	} finally {
		await files.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);

it("refreshes external Git global excludes through the TTL fallback", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neko-global-ignore-")));
	const global = `${root}-excludes`;
	const home = `${root}-home`;
	try {
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		await mkdir(home);
		await writeFile(join(home, ".gitconfig"), `[core]\nexcludesFile = ${global.replaceAll("\\", "/")}\n`);
		await writeFile(join(root, "global.txt"), "");
		await writeFile(global, "global.txt\n");
		// The native walker reads the user's global Git config, so isolate only this child process's home.
		const child = Bun.spawn(
			[
				process.execPath,
				"--conditions=neko-source",
				"-e",
				`
			import {WorkspaceFiles, FILE_CACHE_LIMITS} from "@neko-harness/core/workspace-files";
			const files = new WorkspaceFiles({...FILE_CACHE_LIMITS, ttlMs:60});
			const root = ${JSON.stringify(root)}, global = ${JSON.stringify(global)};
			const signal = new AbortController().signal;
			try {
				const before = await files.search(root,"global",signal);
				await Bun.write(global, ""); await Bun.sleep(80);
				const after = await files.search(root,"global",signal);
				console.log(JSON.stringify([before.entries.length, after.entries.length]));
			} finally { await files.close(); }
		`,
			],
			{ env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" },
		);
		const [output, error, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(error).toBe("");
		expect(code).toBe(0);
		expect(JSON.parse(output)).toEqual([0, 1]);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
		await rm(global, { force: true });
	}
});
