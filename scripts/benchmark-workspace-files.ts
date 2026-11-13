import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FILE_CACHE_LIMITS, WorkspaceFiles } from "../packages/core/src/workspace-files.ts";

const temp = await realpath(await mkdtemp(join(tmpdir(), "neko-index-bench-")));
const files = new WorkspaceFiles();
const signal = new AbortController().signal;
const rss = process.memoryUsage().rss;
const heap = process.memoryUsage().heapUsed;
const timed = async (root: string, query: string) => {
	const start = performance.now();
	const value = await files.search(root, query, signal);
	return {
		ms: Number((performance.now() - start).toFixed(2)),
		candidates: value.entries.length,
		limited: value.limited,
		incomplete: value.incomplete,
	};
};
try {
	const repository = await timed(await realpath(process.cwd()), "workspace-files");
	const hot = await Promise.all(Array.from({ length: 10 }, () => timed(process.cwd(), "workspace-files")));
	await mkdir(join(temp, "bulk"));
	await mkdir(join(temp, "z"));
	await writeFile(join(temp, "z/target.ts"), "");
	for (let offset = 0; offset < 55000; offset += 200)
		await Promise.all(
			Array.from({ length: Math.min(200, 55000 - offset) }, (_, i) =>
				writeFile(join(temp, "bulk", `file-${String(offset + i).padStart(5, "0")}.txt`), ""),
			),
		);
	const truncated = await timed(temp, "target");
	const scoped = await timed(temp, "z/target");
	const hotLarge = await timed(temp, "file-01000");
	await writeFile(join(temp, "z/new.ts"), "");
	const refreshStart = performance.now();
	let refreshed = await timed(temp, "z/new");
	for (let i = 0; i < 50 && !refreshed.candidates; i++) {
		await sleep(100);
		refreshed = await timed(temp, "z/new");
	}
	const refreshWaitMs = Number((performance.now() - refreshStart).toFixed(2));
	const small = join(temp, "small");
	for (const name of ["d0", "d1", "d2"]) await mkdir(join(small, name), { recursive: true });
	const bounded = new WorkspaceFiles({ ...FILE_CACHE_LIMITS, keys: 2, idleMs: 100 });
	let lru: typeof files.stats, idle: typeof files.stats;
	try {
		for (const name of ["d0", "d1", "d2"]) await bounded.search(small, `${name}/`, signal);
		lru = bounded.stats;
		await sleep(400);
		idle = bounded.stats;
	} finally {
		await bounded.close();
	}
	console.log(
		JSON.stringify(
			{
				platform: `${process.platform}/${process.arch}`,
				limits: FILE_CACHE_LIMITS,
				repository,
				hotMeanMs: Number((hot.reduce((n, value) => n + value.ms, 0) / hot.length).toFixed(2)),
				fixtureFiles: 55001,
				truncated,
				scoped,
				hotLarge,
				refreshed,
				refreshWaitMs,
				cache: files.stats,
				capacityFixture: { keys: 2, idleMs: 100, lru, idle },
				heapDeltaMiB: Number(((process.memoryUsage().heapUsed - heap) / 1048576).toFixed(2)),
				rssDeltaMiB: Number(((process.memoryUsage().rss - rss) / 1048576).toFixed(2)),
			},
			null,
			2,
		),
	);
} finally {
	await files.close();
	await rm(temp, { recursive: true, force: true });
}
