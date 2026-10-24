import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { CONTEXT_FIELD_LIMITS, type ContextFieldLimit, PRUNING_DEFAULTS } from "./context-limits.ts";

export { PRUNING_DEFAULTS };

/** Compaction knobs; every field optional so an unset field keeps the native pi-durable policy. */
export type CompactionSettings = {
	/** Automatic compaction; manual compaction always works. */
	readonly enabled?: boolean;
	/** Blocking threshold as a percent of each model's own context window (1-99). */
	readonly triggerPercent?: number;
	readonly keepRecentTokens?: number;
};

/** Tool result pruning knobs (off by default). */
export type PruningSettings = {
	readonly enabled?: boolean;
	/** Context usage, as a percent of the model window, at which old tool results are pruned (1-99). */
	readonly triggerPercent?: number;
	/** The newest tool results kept verbatim. */
	readonly keepRecent?: number;
	/** Results shorter than this many characters are never pruned. */
	readonly minChars?: number;
	/**
	 * A prune is only written once it frees at least this percent of the model window (estimated), so cache-breaking
	 * edits are batched (1-99).
	 */
	readonly minSavePercent?: number;
};

/** The `context` block of the config file. */
export type ContextSettings = {
	readonly compaction?: CompactionSettings;
	readonly pruning?: PruningSettings;
};

export type ContextSettingSource = "default" | "config" | "saved";

/** Resolved values. `triggerPercent: null` for compaction means the native threshold (window minus 16k). */
export type EffectiveContextSettings = {
	readonly compaction: {
		readonly enabled: boolean;
		readonly triggerPercent: number | null;
		readonly keepRecentTokens: number;
	};
	readonly pruning: {
		readonly enabled: boolean;
		readonly triggerPercent: number;
		readonly keepRecent: number;
		readonly minChars: number;
		readonly minSavePercent: number;
	};
};

export type ContextSettingSources = {
	readonly compaction: {
		readonly enabled: ContextSettingSource;
		readonly triggerPercent: ContextSettingSource;
		readonly keepRecentTokens: ContextSettingSource;
	};
	readonly pruning: {
		readonly enabled: ContextSettingSource;
		readonly triggerPercent: ContextSettingSource;
		readonly keepRecent: ContextSettingSource;
		readonly minChars: ContextSettingSource;
		readonly minSavePercent: ContextSettingSource;
	};
};

export type ContextSettingsState = {
	readonly effective: EffectiveContextSettings;
	readonly sources: ContextSettingSources;
};

/** A change request: a value sets the saved override, `null` clears it, `undefined` leaves it alone. */
export type ContextSettingsPatch = {
	readonly compaction?: {
		readonly enabled?: boolean | null;
		readonly triggerPercent?: number | null;
		readonly keepRecentTokens?: number | null;
	};
	readonly pruning?: {
		readonly enabled?: boolean | null;
		readonly triggerPercent?: number | null;
		readonly keepRecent?: number | null;
		readonly minChars?: number | null;
		readonly minSavePercent?: number | null;
	};
};

/** Persisted shape: `null` means never saved. */
export type SavedContextSettings = {
	compaction: { enabled: boolean | null; triggerPercent: number | null; keepRecentTokens: number | null };
	pruning: {
		enabled: boolean | null;
		triggerPercent: number | null;
		keepRecent: number | null;
		minChars: number | null;
		minSavePercent: number | null;
	};
};

export const emptySavedContextSettings = (): SavedContextSettings => ({
	compaction: { enabled: null, triggerPercent: null, keepRecentTokens: null },
	pruning: { enabled: null, triggerPercent: null, keepRecent: null, minChars: null, minSavePercent: null },
});

type Field = ContextFieldLimit;
const SCHEMA = CONTEXT_FIELD_LIMITS;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function describe(field: Field): string {
	return field.kind === "boolean" ? "a boolean" : `an integer between ${field.min} and ${field.max}`;
}

/**
 * Validate a `context`-shaped value and return a copy. `allowNull` accepts `null` for a field (patches);
 * `null` is kept in the result. Errors name the field as `<prefix>.group.field`.
 */
function validateGroups(value: unknown, prefix: string, allowNull: boolean): Record<string, Record<string, unknown>> {
	if (!isObject(value)) throw new Error(`"${prefix}" must be an object.`);
	const out: Record<string, Record<string, unknown>> = {};
	for (const key of Object.keys(value)) {
		if (!(key in SCHEMA)) throw new Error(`"${prefix}.${key}" is not a known setting.`);
	}
	for (const [group, fields] of Object.entries(SCHEMA)) {
		const given = value[group];
		if (given === undefined) continue;
		if (!isObject(given)) throw new Error(`"${prefix}.${group}" must be an object.`);
		const target: Record<string, unknown> = {};
		for (const key of Object.keys(given)) {
			if (!(key in fields)) throw new Error(`"${prefix}.${group}.${key}" is not a known setting.`);
		}
		for (const [name, field] of Object.entries(fields as Record<string, Field>)) {
			const item = given[name];
			if (item === undefined) continue;
			if (item === null && allowNull) {
				target[name] = null;
				continue;
			}
			const ok =
				field.kind === "boolean"
					? typeof item === "boolean"
					: typeof item === "number" && Number.isInteger(item) && item >= field.min && item <= field.max;
			if (!ok) throw new Error(`"${prefix}.${group}.${name}" must be ${describe(field)}.`);
			target[name] = item;
		}
		out[group] = target;
	}
	return out;
}

/** Validate the config file's `context` block. */
export function parseContextSettings(value: unknown, prefix = "context"): ContextSettings {
	return validateGroups(value, prefix, false) as ContextSettings;
}

/** Validate a UI patch (null clears a saved value). */
export function parseContextSettingsPatch(value: unknown): ContextSettingsPatch {
	return validateGroups(value, "context", true) as ContextSettingsPatch;
}

/** Field-level merge of two config layers; `overrides` win. */
export function mergeContextSettings(base: ContextSettings | undefined, overrides: ContextSettings | undefined) {
	if (base === undefined) return overrides;
	if (overrides === undefined) return base;
	return {
		compaction: { ...base.compaction, ...overrides.compaction },
		pruning: { ...base.pruning, ...overrides.pruning },
	} satisfies ContextSettings;
}

/** Apply a patch onto the saved record; the caller persists the result. */
export function applyContextPatch(saved: SavedContextSettings, patch: ContextSettingsPatch): SavedContextSettings {
	const next: SavedContextSettings = {
		compaction: { ...saved.compaction },
		pruning: { ...saved.pruning },
	};
	for (const [key, value] of Object.entries(patch.compaction ?? {})) {
		if (value !== undefined) (next.compaction as Record<string, unknown>)[key] = value;
	}
	for (const [key, value] of Object.entries(patch.pruning ?? {})) {
		if (value !== undefined) (next.pruning as Record<string, unknown>)[key] = value;
	}
	return next;
}

/** Normalise a stored document: anything that no longer validates is treated as never saved. */
export function sanitizeSavedContextSettings(raw: unknown): SavedContextSettings {
	const saved = emptySavedContextSettings();
	if (!isObject(raw)) return saved;
	for (const [group, fields] of Object.entries(SCHEMA)) {
		const stored = raw[group];
		if (!isObject(stored)) continue;
		for (const [name, field] of Object.entries(fields as Record<string, Field>)) {
			const item = stored[name];
			const ok =
				field.kind === "boolean"
					? typeof item === "boolean"
					: typeof item === "number" && Number.isInteger(item) && item >= field.min && item <= field.max;
			if (ok) (saved as Record<string, Record<string, unknown>>)[group]![name] = item;
		}
	}
	return saved;
}

function pick<T>(
	saved: T | null | undefined,
	config: T | undefined,
	fallback: T,
): { readonly value: T; readonly source: ContextSettingSource } {
	if (saved !== null && saved !== undefined) return { value: saved, source: "saved" };
	if (config !== undefined) return { value: config, source: "config" };
	return { value: fallback, source: "default" };
}

/** Resolve saved > config > default, with the source of every value. */
export function resolveContextSettings(
	config: ContextSettings | undefined,
	saved: SavedContextSettings,
): ContextSettingsState {
	const cEnabled = pick(saved.compaction.enabled, config?.compaction?.enabled, DEFAULT_COMPACTION_POLICY.enabled);
	const cTrigger = pick<number | null>(saved.compaction.triggerPercent, config?.compaction?.triggerPercent, null);
	const cKeep = pick(
		saved.compaction.keepRecentTokens,
		config?.compaction?.keepRecentTokens,
		DEFAULT_COMPACTION_POLICY.keepRecentTokens,
	);
	const pEnabled = pick(saved.pruning.enabled, config?.pruning?.enabled, PRUNING_DEFAULTS.enabled as boolean);
	const pTrigger = pick(saved.pruning.triggerPercent, config?.pruning?.triggerPercent, PRUNING_DEFAULTS.triggerPercent);
	const pKeep = pick(saved.pruning.keepRecent, config?.pruning?.keepRecent, PRUNING_DEFAULTS.keepRecent);
	const pMin = pick(saved.pruning.minChars, config?.pruning?.minChars, PRUNING_DEFAULTS.minChars);
	const pSave = pick(saved.pruning.minSavePercent, config?.pruning?.minSavePercent, PRUNING_DEFAULTS.minSavePercent);
	return {
		effective: {
			compaction: { enabled: cEnabled.value, triggerPercent: cTrigger.value, keepRecentTokens: cKeep.value },
			pruning: {
				enabled: pEnabled.value,
				triggerPercent: pTrigger.value,
				keepRecent: pKeep.value,
				minChars: pMin.value,
				minSavePercent: pSave.value,
			},
		},
		sources: {
			compaction: { enabled: cEnabled.source, triggerPercent: cTrigger.source, keepRecentTokens: cKeep.source },
			pruning: {
				enabled: pEnabled.source,
				triggerPercent: pTrigger.source,
				keepRecent: pKeep.source,
				minChars: pMin.source,
				minSavePercent: pSave.source,
			},
		},
	};
}

/** The part of pi-durable's `settings.compaction` this module produces. */
export type CompactionPolicy = {
	enabled?: boolean;
	keepRecentTokens?: number;
	modelOverrides?: Record<string, { reserveTokens: number }>;
};

/**
 * The `settings.compaction` handed to pi-durable. Only fields that were set (config or saved) are returned, so an
 * untouched install keeps the native policy exactly. `windows` maps `"provider/modelId"` to its context window; the
 * trigger percent becomes a per-model `reserveTokens`, so each model compacts at that share of its own window.
 */
export function compactionPolicy(state: ContextSettingsState, windows: ReadonlyMap<string, number>): CompactionPolicy {
	const { effective, sources } = state;
	const policy: CompactionPolicy = {};
	if (sources.compaction.enabled !== "default") policy.enabled = effective.compaction.enabled;
	if (sources.compaction.keepRecentTokens !== "default")
		policy.keepRecentTokens = effective.compaction.keepRecentTokens;
	const percent = effective.compaction.triggerPercent;
	if (percent === null) return policy;
	const overrides: Record<string, { reserveTokens: number }> = {};
	for (const [id, window] of windows)
		if (window > 0) overrides[id] = { reserveTokens: window - Math.floor((window * percent) / 100) };
	if (Object.keys(overrides).length > 0) policy.modelOverrides = overrides;
	return policy;
}

/**
 * `compactionPolicy` bound to a fixed window table, remembering the last result by settings-state identity. The
 * override table is as large as the model catalog and pi-durable reads its settings on every threshold check.
 */
export function createCompactionPolicy(
	windows: ReadonlyMap<string, number>,
): (state: ContextSettingsState) => CompactionPolicy {
	let last: { state: ContextSettingsState; policy: CompactionPolicy } | undefined;
	return (state) => {
		if (last?.state !== state) last = { state, policy: compactionPolicy(state, windows) };
		return last.policy;
	};
}
