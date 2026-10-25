/**
 * Codemode modes and limits. Pure module (subpath `@neko-harness/core/codemode-mode`) shared by core, the gateway
 * contract and the frontends, so no consumer hard-codes the values.
 */

/** Name of the codemode tool, its extension and its prompt section. */
export const CODEMODE_NAME = "codemode";

/** `off`: no codemode tool. `on`: alongside the normal tools. `only`: the model sees codemode (plus main-only tools). */
export const CODEMODE_MODES = ["off", "on", "only"] as const;
export type CodemodeMode = (typeof CODEMODE_MODES)[number];

export const DEFAULT_CODEMODE_MODE: CodemodeMode = "off";

export const isCodemodeMode = (value: unknown): value is CodemodeMode =>
	typeof value === "string" && (CODEMODE_MODES as readonly string[]).includes(value);

/** Where the effective mode comes from. */
export type CodemodeSettingSource = "default" | "config" | "saved";

export type CodemodeSettings = { readonly mode?: CodemodeMode };

export type CodemodeSettingsState = {
	readonly effective: { readonly mode: CodemodeMode };
	readonly source: CodemodeSettingSource;
};

/** Sandbox limits. Edit `docs`/specs together with these numbers. */
export const CODEMODE_LIMITS = {
	/** Memory of one script's VM. */
	memoryLimitBytes: 256 * 1024 * 1024,
	/** Scripts running at the same time in the whole process; further scripts wait. */
	maxWorkers: 2,
	/** How long a script waits for a free worker before it fails with "sandbox busy". */
	waitMs: 60_000,
} as const;

/** Bounds of the nested call list shown to clients. */
export const CODEMODE_VIEW_LIMITS = {
	/** Nested calls per codemode item; the rest is only counted in `omitted`. */
	maxCalls: 100,
	/** Characters of one call's argument preview. */
	argsChars: 200,
	/** Characters of one call's error text. */
	errorChars: 200,
} as const;

/** Validates a mode coming from a file or a client; the message names `field`. */
export function parseCodemodeMode(value: unknown, field = "codemode.mode"): CodemodeMode {
	if (!isCodemodeMode(value)) throw new Error(`"${field}" must be one of ${CODEMODE_MODES.join(", ")}.`);
	return value;
}

/** Validates the `codemode` block of the configuration file. */
export function parseCodemodeSettings(value: unknown, prefix = "codemode"): CodemodeSettings {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`"${prefix}" must be an object.`);
	const { mode, ...rest } = value as Record<string, unknown>;
	const unknown = Object.keys(rest)[0];
	if (unknown !== undefined) throw new Error(`"${prefix}.${unknown}" is not a known setting.`);
	return mode === undefined ? {} : { mode: parseCodemodeMode(mode, `${prefix}.mode`) };
}

/** Saved value > configuration file > `off`. */
export function resolveCodemodeSettings(
	config: CodemodeSettings | undefined,
	saved: CodemodeMode | null | undefined,
): CodemodeSettingsState {
	if (isCodemodeMode(saved)) return { effective: { mode: saved }, source: "saved" };
	if (config?.mode !== undefined) return { effective: { mode: config.mode }, source: "config" };
	return { effective: { mode: DEFAULT_CODEMODE_MODE }, source: "default" };
}
