import { afterEach, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import type { ContextSettings } from "../src/context-settings.ts";
import { createNekoRuntime } from "../src/runtime.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function open(options: { storagePath?: string; context?: ContextSettings; modelId?: string } = {}) {
	const faux = fauxProvider({
		models: [
			{ id: "small", contextWindow: 1000000 },
			{ id: "narrow", contextWindow: 100000 },
		],
	});
	faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage([fauxText("ok")])));
	return createNekoRuntime({
		storage: options.storagePath === undefined ? "memory" : "sqlite",
		...(options.storagePath !== undefined ? { storagePath: options.storagePath } : {}),
		model: { provider: "faux", modelId: options.modelId ?? "small" },
		providers: [faux.provider],
		...(options.context !== undefined ? { contextSettings: options.context } : {}),
	});
}

async function pump(runtime: Awaited<ReturnType<typeof open>>, turns: number) {
	for (let i = 0; i < turns; i++) await runtime.waitAnswer(await runtime.submit(`turn ${i} ${"x".repeat(60000)}`));
	await Bun.sleep(200);
}

it("keeps the native thresholds when nothing is set", async () => {
	const runtime = await open();
	try {
		const state = await runtime.contextSettings();
		expect(state.effective.compaction.triggerPercent).toBeNull();
		expect(Object.values(state.sources.compaction).every((s) => s === "default")).toBe(true);
		await pump(runtime, 2);
		expect(await runtime.root.compactionRecord()).toBeNull();
	} finally {
		await runtime.close();
	}
}, 30000);

it("applies a config trigger and a saved override without a restart", async () => {
	const runtime = await open({ context: { compaction: { triggerPercent: 1 } } });
	try {
		expect((await runtime.contextSettings()).sources.compaction.triggerPercent).toBe("config");
		await pump(runtime, 2);
		expect((await runtime.root.compactionRecord())?.phase).toBeDefined();
	} finally {
		await runtime.close();
	}
	const off = await open({ context: { compaction: { triggerPercent: 1 } } });
	try {
		const state = await off.setContextSettings({ compaction: { enabled: false } });
		expect(state.sources.compaction.enabled).toBe("saved");
		await pump(off, 2);
		expect(await off.root.compactionRecord()).toBeNull();
		const reset = await off.resetContextSettings();
		expect(reset.sources.compaction.enabled).toBe("default");
		expect(reset.effective.compaction.triggerPercent).toBe(1);
	} finally {
		await off.close();
	}
}, 60000);

it("compacts each model at the trigger percent of its own window", async () => {
	// 20% is 20k tokens for the narrow model and 200k for the wide one (background compaction starts 32k earlier);
	// a turn is about 15k tokens, so two turns pass the first and stay far below the second.
	const context = { compaction: { triggerPercent: 20 } };
	const narrow = await open({ context, modelId: "narrow" });
	try {
		await pump(narrow, 2);
		expect((await narrow.root.compactionRecord())?.phase).toBeDefined();
	} finally {
		await narrow.close();
	}
	// Another, smaller model in the catalog must not pull the wide model's threshold down with it.
	const wide = await open({ context, modelId: "small" });
	try {
		await pump(wide, 2);
		expect(await wide.root.compactionRecord()).toBeNull();
	} finally {
		await wide.close();
	}
}, 60000);

it("rejects invalid patches without changing the state", async () => {
	const runtime = await open();
	try {
		await expect(runtime.setContextSettings({ compaction: { triggerPercent: 100 } })).rejects.toThrow(/triggerPercent/);
		await expect(runtime.setContextSettings({ pruning: { bogus: 1 } } as never)).rejects.toThrow();
		expect((await runtime.contextSettings()).sources.compaction.triggerPercent).toBe("default");
		await runtime.setContextSettings({ pruning: { enabled: true, keepRecent: 3 } });
		const state = await runtime.contextSettings();
		expect(state.effective.pruning).toMatchObject({ enabled: true, keepRecent: 3, minChars: 4000, minSavePercent: 5 });
	} finally {
		await runtime.close();
	}
});

it("keeps saved settings across a restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-context-"));
	dirs.push(dir);
	const storagePath = join(dir, "neko.sqlite");
	const first = await open({ storagePath });
	await first.setContextSettings({ compaction: { triggerPercent: 50 }, pruning: { enabled: true } });
	await first.close();
	const second = await open({ storagePath });
	try {
		const state = await second.contextSettings();
		expect(state.effective.compaction.triggerPercent).toBe(50);
		expect(state.sources.pruning.enabled).toBe("saved");
	} finally {
		await second.close();
	}
});
