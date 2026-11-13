import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { installedVersion, UpdateChecker } from "../src/application-updates.ts";
import {
	APPLICATION_PROTOCOL,
	newer,
	RUNNING_VERSION,
	stableVersion,
	type UpdateState,
	updateAction,
} from "../src/application-version.ts";

const state: UpdateState = {
	runningVersion: "1.0.0",
	installedVersion: "1.0.0",
	protocolVersion: APPLICATION_PROTOCOL,
	latestVersion: "1.1.0",
	checkedAt: 1,
	checkState: "ok",
};
it("distinguishes install, running services, page and unknown versions", () => {
	expect(RUNNING_VERSION).toBe("development");
	for (const v of ["1.2.3-beta", "01.2.3", "1.2", "9999999999999999999.0.0", undefined])
		expect(stableVersion(v)).toBe(false);
	expect(newer("1.10.0", "1.2.9")).toBe(true);
	const base = { gateway: state, frontend: "1.0.0", installed: "1.0.0" };
	expect(updateAction(base)).toBe("install");
	expect(updateAction({ ...base, gateway: { ...state, installedVersion: "1.1.0" } })).toBe("restart-service");
	expect(updateAction({ ...base, installed: "1.1.0" })).toBe("restart-service");
	expect(
		updateAction({
			...base,
			installed: "1.1.0",
			gateway: { ...state, runningVersion: "1.1.0", installedVersion: "1.1.0" },
		}),
	).toBe("restart-tui");
	expect(
		updateAction({ ...base, installed: "1.1.0", web: { runningVersion: "1.0.0", installedVersion: "1.1.0" } }),
	).toBe("restart-service");
	expect(
		updateAction({
			...base,
			installed: "1.1.0",
			gateway: { ...state, runningVersion: "1.1.0", installedVersion: "1.1.0" },
			web: { runningVersion: "1.1.0", installedVersion: "1.1.0" },
		}),
	).toBe("refresh-page");
	expect(
		updateAction({
			...base,
			frontend: "1.1.0",
			installed: "1.1.0",
			gateway: { ...state, runningVersion: "1.1.0", installedVersion: "1.1.0" },
		}),
	).toBe("none");
	expect(updateAction({ ...base, gateway: { ...state, protocolVersion: APPLICATION_PROTOCOL + 1 } })).toBe(
		"incompatible",
	);
	expect(updateAction({ gateway: null, frontend: "development", installed: null })).toBe("none");
});
it("checks cached registry independently of changed installed files, coalesces and handles failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-updates-"));
	try {
		const manifest = join(dir, "package.json"),
			cachePath = join(dir, "cache.json");
		await writeFile(manifest, JSON.stringify({ name: "neko-harness", version: "1.0.0" }));
		let calls = 0,
			fail = false;
		const checker = new UpdateChecker({
			runningVersion: "1.0.0",
			manifest,
			cachePath,
			fetch: (async () => {
				calls++;
				await sleep(5);
				return fail
					? new Response("offline", { status: 503 })
					: Response.json({ name: "neko-harness", version: "1.1.0" });
			}) as (url: string, options?: RequestInit) => Promise<Response>,
		});
		const results = await Promise.all([checker.check(), checker.check()]);
		expect(calls).toBe(1);
		expect(results[0]!.latestVersion).toBe("1.1.0");
		await writeFile(manifest, JSON.stringify({ name: "neko-harness", version: "1.1.0" }));
		expect((await checker.check()).installedVersion).toBe("1.1.0");
		expect(calls).toBe(1);
		expect(checker.state.runningVersion).toBe("1.0.0");
		fail = true;
		expect((await checker.check(true)).checkState).toBe("failed");
		await checker.check();
		expect(calls).toBe(2);
		const cached = new UpdateChecker({
			runningVersion: "1.0.0",
			manifest,
			cachePath,
			fetch: (() => {
				throw new Error("should use cache");
			}) as (url: string, options?: RequestInit) => Promise<Response>,
		});
		expect((await cached.check()).checkState).toBe("ok");
		checker.close();
		cached.close();
		const dev = new UpdateChecker({
			runningVersion: "development",
			cachePath,
			fetch: (() => {
				throw new Error("no development network");
			}) as (url: string, options?: RequestInit) => Promise<Response>,
		});
		expect((await dev.check(true)).checkState).toBe("development");
		dev.close();
		await writeFile(manifest, "broken");
		expect(await installedVersion(manifest)).toBeNull();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it("rejects malformed, oversized and stalled registry responses and corrupt caches", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-updates-"));
	try {
		const cachePath = join(dir, "cache.json");
		await writeFile(cachePath, "broken");
		for (const response of [
			Response.json({ name: "other", version: "1.0.0" }),
			Response.json({ name: "neko-harness", version: "1.0.0-beta" }),
			new Response("x".repeat(262145)),
		]) {
			const checker = new UpdateChecker({
				runningVersion: "1.0.0",
				cachePath,
				fetch: (async () => response) as (url: string, options?: RequestInit) => Promise<Response>,
			});
			expect((await checker.check()).checkState).toBe("failed");
			checker.close();
		}
		const checker = new UpdateChecker({
			runningVersion: "1.0.0",
			cachePath,
			timeoutMs: 10,
			fetch: ((_url, options) =>
				new Promise((_resolve, reject) =>
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				)) as (url: string, options?: RequestInit) => Promise<Response>,
		});
		expect((await checker.check()).checkState).toBe("failed");
		checker.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("bounds a stalled response body and stops checks on close", async () => {
	const checker = new UpdateChecker({
		runningVersion: "1.0.0",
		timeoutMs: 10,
		fetch: async () => new Response(new ReadableStream({ start() {} })),
	});
	const start = Date.now();
	expect((await checker.check(true)).checkState).toBe("failed");
	expect(Date.now() - start).toBeLessThan(1000);
	checker.close();
	const closed = new UpdateChecker({
		runningVersion: "1.0.0",
		fetch: async () => {
			throw new Error("closed checker must not request");
		},
	});
	closed.close();
	expect((await closed.check(true)).checkState).toBe("unknown");
});
