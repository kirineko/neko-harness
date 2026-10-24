import { expect, it } from "bun:test";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import {
	applyContextPatch,
	compactionPolicy,
	createCompactionPolicy,
	emptySavedContextSettings,
	parseContextSettingsPatch,
	resolveContextSettings,
	sanitizeSavedContextSettings,
} from "../src/context-settings.ts";

it("resolves saved > config > default with sources", () => {
	const none = resolveContextSettings(undefined, emptySavedContextSettings());
	expect(none.effective.compaction).toEqual({
		enabled: true,
		triggerPercent: null,
		keepRecentTokens: DEFAULT_COMPACTION_POLICY.keepRecentTokens,
	});
	expect(none.effective.pruning).toEqual({
		enabled: false,
		triggerPercent: 35,
		keepRecent: 10,
		minChars: 4000,
		minSavePercent: 5,
	});
	expect(Object.values(none.sources.compaction).every((s) => s === "default")).toBe(true);

	const saved = applyContextPatch(emptySavedContextSettings(), { compaction: { triggerPercent: 40 } });
	const state = resolveContextSettings({ compaction: { triggerPercent: 60, keepRecentTokens: 1000 } }, saved);
	expect(state.effective.compaction.triggerPercent).toBe(40);
	expect(state.sources.compaction.triggerPercent).toBe("saved");
	expect(state.effective.compaction.keepRecentTokens).toBe(1000);
	expect(state.sources.compaction.keepRecentTokens).toBe("config");
});

it("only overrides pi-durable fields that were set", () => {
	const none = resolveContextSettings(undefined, emptySavedContextSettings());
	const windows = new Map([["a/big", 1_000_000]]);
	expect(compactionPolicy(none, windows)).toEqual({});
	const set = resolveContextSettings(
		{ compaction: { triggerPercent: 50, enabled: false, keepRecentTokens: 5000 } },
		emptySavedContextSettings(),
	);
	expect(compactionPolicy(set, windows)).toEqual({
		enabled: false,
		keepRecentTokens: 5000,
		modelOverrides: { "a/big": { reserveTokens: 500_000 } },
	});
	expect(compactionPolicy(set, new Map())).toEqual({ enabled: false, keepRecentTokens: 5000 });
});

it("derives the blocking threshold from each model's own window", () => {
	const state = resolveContextSettings({ compaction: { triggerPercent: 80 } }, emptySavedContextSettings());
	const windows = new Map([
		["a/small", 32_000],
		["a/big", 1_000_000],
		["a/unknown", 0],
	]);
	const policy = compactionPolicy(state, windows);
	expect(policy).toEqual({
		modelOverrides: { "a/small": { reserveTokens: 6_400 }, "a/big": { reserveTokens: 200_000 } },
	});
	// Percent of the window is the threshold, whatever the other models are.
	for (const [id, window] of windows) {
		const reserve = policy.modelOverrides?.[id]?.reserveTokens;
		if (window > 0) expect(window - (reserve ?? 0)).toBe(Math.floor(window * 0.8));
		else expect(reserve).toBeUndefined();
	}
});

it("returns the same overrides while the settings state and window table are unchanged", () => {
	const state = resolveContextSettings({ compaction: { triggerPercent: 50 } }, emptySavedContextSettings());
	const windows = new Map([["a/big", 1_000_000]]);
	const cached = createCompactionPolicy(windows);
	expect(cached(state).modelOverrides).toBe(cached(state).modelOverrides);
	const next = resolveContextSettings({ compaction: { triggerPercent: 60 } }, emptySavedContextSettings());
	expect(cached(next).modelOverrides).toEqual({ "a/big": { reserveTokens: 400_000 } });
});

it("patches: null clears, undefined keeps, invalid is rejected", () => {
	const a = applyContextPatch(emptySavedContextSettings(), {
		compaction: { triggerPercent: 50 },
		pruning: { enabled: true },
	});
	const b = applyContextPatch(a, { compaction: { triggerPercent: null }, pruning: { minChars: 100 } });
	expect(b.compaction.triggerPercent).toBeNull();
	expect(b.pruning).toMatchObject({ enabled: true, minChars: 100 });
	expect(parseContextSettingsPatch({ compaction: { triggerPercent: null } })).toEqual({
		compaction: { triggerPercent: null },
	});
	for (const bad of [{ compaction: { triggerPercent: 100 } }, { pruning: { x: 1 } }, { nope: {} }, "x"])
		expect(() => parseContextSettingsPatch(bad)).toThrow();
});

it("ignores invalid stored values", () => {
	const saved = sanitizeSavedContextSettings({
		compaction: { triggerPercent: 500, enabled: false },
		pruning: "bad",
	});
	expect(saved.compaction).toEqual({ enabled: false, triggerPercent: null, keepRecentTokens: null });
	expect(saved.pruning.enabled).toBeNull();
});
