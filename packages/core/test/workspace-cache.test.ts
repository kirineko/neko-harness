import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileChange, type FileListing, ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, LocalExecutionEnv } from "@earendil-works/pi-env";
import { rm } from "../../../test/temp-dir.ts";
import { FILE_CACHE_LIMITS, WorkspaceFiles } from "../src/workspace-files.ts";

const roots: string[] = [];
const instances: WorkspaceFiles[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
	for (const files of instances.splice(0)) await files.close();
	for (const restore of restores.splice(0)) restore();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(limits = FILE_CACHE_LIMITS) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neko-cache-")));
	roots.push(root);
	const files = new WorkspaceFiles(limits);
	instances.push(files);
	const info = spyOn(Connection.prototype, "info").mockResolvedValue({
		protocol: 1,
		version: "1.2.0",
		os: process.platform,
		arch: process.arch,
		home: root,
		tmpdir: root,
		separator: "/",
		cwd: root,
		driveCwds: {},
		pid: 0,
		features: ["listFiles"],
	});
	restores.push(() => info.mockRestore());
	const session = spyOn(Connection.prototype, "session").mockResolvedValue(1);
	restores.push(() => session.mockRestore());
	const watches: ((change: FileChange) => void)[] = [];
	let closed = 0;
	const watch = spyOn(NodeExecutionEnv.prototype, "watch").mockImplementation(async (_targets, change) => {
		watches.push(change);
		return ok({
			mode: "native",
			async stop() {
				closed++;
			},
		});
	});
	restores.push(() => watch.mockRestore());
	return { files, root, info, watches, closed: () => closed };
}
const empty: FileListing = { entries: [], truncated: false };

it("prioritizes directories before applying the candidate limit", async () => {
	const { files, root } = await setup();
	const entries: FileListing["entries"] = Array.from({ length: 101 }, (_, n) => ({
		path: `file-${n}.ts`,
		kind: "file",
	}));
	await Promise.all(entries.map((entry) => writeFile(join(root, entry.path), "")));
	await mkdir(join(root, "z-directory"));
	entries.push({ path: "z-directory", kind: "directory" });
	const list = spyOn(LocalExecutionEnv.prototype, "listFiles").mockResolvedValue(ok({ entries, truncated: false }));
	restores.push(() => list.mockRestore());
	const result = await files.search(root, "", new AbortController().signal);
	expect(result.entries[0]).toEqual({ name: "z-directory", path: "z-directory", kind: "directory" });
	expect(result.entries).toHaveLength(100);
	expect(result).toMatchObject({ limited: true, incomplete: false });
});
it("coalesces scans, isolates canceled waiters, rejects late scans after invalidation", async () => {
	const { files, root, watches } = await setup();
	let complete: (
		value: import("@earendil-works/pi-durable/env").Result<
			FileListing,
			import("@earendil-works/pi-durable/env").FileError
		>,
	) => void = () => {};
	const list = spyOn(LocalExecutionEnv.prototype, "listFiles").mockImplementation(
		async () =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	restores.push(() => list.mockRestore());
	const controller = new AbortController();
	const first = files.search(root, "x", controller.signal);
	const second = files.search(root, "y", new AbortController().signal);
	for (let i = 0; i < 100 && !list.mock.calls.length; i++) await Bun.sleep(1);
	controller.abort();
	await expect(first).rejects.toThrow("cancelled");
	expect(list).toHaveBeenCalledTimes(1);
	complete(ok(empty));
	expect((await second).incomplete).toBe(false);
	watches[0]!({ kind: "overflow" });
	const late = files.search(root, "", new AbortController().signal);
	for (let i = 0; i < 100 && list.mock.calls.length < 2; i++) await Bun.sleep(1);
	watches[0]!({ kind: "paths", paths: ["new.ts"] });
	complete(ok(empty));
	await expect(late).rejects.toThrow("changed");
	list.mockResolvedValue(ok(empty));
	await files.search(root, "", new AbortController().signal);
	expect(list).toHaveBeenCalledTimes(3);
});
it("bounds concurrent and queued scans and releases watchers on LRU, idle, removal and close", async () => {
	const { files, root, closed } = await setup({ ...FILE_CACHE_LIMITS, keys: 3, idleMs: 40 });
	let running = 0,
		maximum = 0;
	const pending: (() => void)[] = [];
	const list = spyOn(LocalExecutionEnv.prototype, "listFiles").mockImplementation(async () => {
		running++;
		maximum = Math.max(maximum, running);
		await new Promise<void>((resolve) => pending.push(resolve));
		running--;
		return ok(empty);
	});
	restores.push(() => list.mockRestore());
	const queries: Promise<unknown>[] = [];
	for (let i = 0; i < 3; i++) {
		await mkdir(join(root, String(i)));
		queries.push(files.search(root, `${i}/`, new AbortController().signal));
	}
	for (let i = 0; i < 100 && list.mock.calls.length < 2; i++) await Bun.sleep(1);
	await mkdir(join(root, "overflow"));
	await expect(files.search(root, "overflow/", new AbortController().signal)).rejects.toThrow("busy");
	expect(maximum).toBe(2);
	pending.splice(0).forEach((resolve) => {
		resolve();
	});
	for (let i = 0; i < 100 && list.mock.calls.length < 3; i++) await Bun.sleep(1);
	pending.splice(0).forEach((resolve) => {
		resolve();
	});
	await Promise.all(queries);
	list.mockResolvedValue(ok(empty));
	await files.search(root, "overflow/", new AbortController().signal);
	expect(files.stats.keys).toBe(3);
	expect(files.stats.watchers).toBe(1);
	files.remove(root);
	await Bun.sleep(0);
	expect(closed()).toBe(1);
	await files.search(root, "", new AbortController().signal);
	await Bun.sleep(100);
	expect(closed()).toBe(2);
	await files.search(root, "", new AbortController().signal);
	await files.close();
	expect(closed()).toBe(3);
});
it("replaces a connection after startup timeout and retries, without affecting ordinary Node operations", async () => {
	const { files, root, info } = await setup({ ...FILE_CACHE_LIMITS, startupMs: 20 });
	info.mockImplementationOnce(() => new Promise(() => {}));
	const closes = spyOn(Connection.prototype, "close");
	restores.push(() => closes.mockRestore());
	await expect(files.search(root, "", new AbortController().signal)).rejects.toThrow("startup timed out");
	expect(closes).toHaveBeenCalledTimes(1);
	const list = spyOn(LocalExecutionEnv.prototype, "listFiles").mockResolvedValue(ok(empty));
	restores.push(() => list.mockRestore());
	expect((await files.search(root, "", new AbortController().signal)).entries).toEqual([]);
	expect(info).toHaveBeenCalledTimes(2);
	expect((await files.env(root).exists(".", importContext)).ok).toBe(true);
});

import { BACKGROUND_CONTEXT as importContext } from "@earendil-works/chord/context";

it("reclaims a canceled final waiter and watcher, and falls back to TTL after watch failure", async () => {
	const { files, root, closed } = await setup({ ...FILE_CACHE_LIMITS, ttlMs: 15 });
	let started = false;
	const list = spyOn(LocalExecutionEnv.prototype, "listFiles").mockImplementation(async (_path, _options, context) => {
		started = true;
		await new Promise<void>((resolve) => {
			if (context.abortSignal?.aborted) resolve();
			else context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return ok(empty);
	});
	restores.push(() => list.mockRestore());
	const controller = new AbortController();
	const pending = files.search(root, "", controller.signal);
	for (let n = 0; n < 100 && !started; n++) await Bun.sleep(1);
	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
	await Bun.sleep(0);
	expect(files.stats.keys).toBe(0);
	expect(closed()).toBe(1);
	list.mockResolvedValue(ok(empty));
	const failedWatch = spyOn(NodeExecutionEnv.prototype, "watch").mockImplementation(async () => ({
		ok: false,
		error: new (await import("@earendil-works/pi-durable/env")).FileError("permission_denied", "watch denied"),
	}));
	failedWatch.mockRejectedValueOnce(new Error("watch initialization failed"));
	restores.push(() => failedWatch.mockRestore());
	await files.search(root, "", new AbortController().signal);
	await files.search(root, "", new AbortController().signal);
	expect(list).toHaveBeenCalledTimes(2);
	await Bun.sleep(20);
	await files.search(root, "", new AbortController().signal);
	expect(list).toHaveBeenCalledTimes(3);
});
