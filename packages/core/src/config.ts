import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ContextSettings, mergeContextSettings, parseContextSettings } from "./context-settings.ts";
import type { NekoModelRef } from "./runtime.ts";
import { isSearchProvider, SEARCH_PROVIDERS, type SearchProviderId } from "./search-providers.ts";

export type NekoTheme = "light" | "dark" | "auto";

/** Skill market settings. */
export type NekoSkillsConfig = {
	/** Base URL of the skill market API; defaults to the official market. */
	readonly marketUrl?: string;
};

/** Web search settings. */
export type NekoWebSearchConfig = {
	/** Initial search provider, used until the user saves a choice; defaults to "tavily". */
	readonly provider?: SearchProviderId;
};

/** Gateway listen addresses, consumed by the gateway change (v1 core only carries them). */
export type NekoGatewayConfig = {
	readonly host?: string;
	readonly port?: number;
	/** Unix socket path for the TUI frontend; null disables the Unix transport. */
	readonly socketPath?: string | null;
};

/** Command shell settings; only read on Windows. */
export type NekoShellConfig = {
	/** Git for Windows `bash.exe` used by the bash tool, `job` and subagents; WSL's bash.exe is rejected. */
	readonly path?: string;
};

/** Resolved neko-harness configuration: every field optional, merged from defaults < file < CLI. */
export type NekoConfig = {
	readonly defaultModel?: NekoModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly storagePath?: string;
	readonly gateway?: NekoGatewayConfig;
	readonly theme?: NekoTheme;
	readonly skills?: NekoSkillsConfig;
	readonly webSearch?: NekoWebSearchConfig;
	/** Context management: compaction trigger and tool result pruning. Unset keeps the native behaviour. */
	readonly context?: ContextSettings;
	readonly shell?: NekoShellConfig;
};

export const DEFAULT_SKILL_MARKET_URL = "https://skill.kirineko.tech";

export const NEKO_CONFIG_BASENAME = "neko.config.json";

/** Defaults below CLI flags and config files: only what the code falls back to anyway. */
export const DEFAULT_NEKO_CONFIG: NekoConfig = {
	defaultModel: { provider: "deepseek", modelId: "deepseek-flash" },
	theme: "auto",
	thinkingLevel: "high",
};

/**
 * Walk from `startDir` (default `process.cwd()`) up to the filesystem root looking for
 * `neko.config.json`; fall back to `~/.neko/config.json`. Returns the file path, or
 * `undefined` when neither exists.
 */
export function findNekoConfigFile(startDir: string = process.cwd()): string | undefined {
	let dir = resolve(startDir);
	for (;;) {
		const candidate = join(dir, NEKO_CONFIG_BASENAME);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const fallback = join(homedir(), ".neko", NEKO_CONFIG_BASENAME);
	return existsSync(fallback) ? fallback : undefined;
}

/**
 * Load and validate the configuration. `$NAME` and `${NAME}` references in string values
 * are interpolated from `env` (default `process.env`); a reference to an unset variable
 * throws. A missing file yields `{}` so callers can merge with defaults.
 */
export function loadNekoConfig(startDir?: string, env: NodeJS.ProcessEnv = process.env): NekoConfig {
	const file = findNekoConfigFile(startDir);
	if (file === undefined) return {};
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`neko config: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseNekoConfig(raw, file, env);
}

/** Parse one config document (exported for tests). `source` labels error messages. */
export function parseNekoConfig(raw: string, source: string, env: NodeJS.ProcessEnv = process.env): NekoConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`neko config: ${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`neko config: ${source} must hold a JSON object.`);
	}
	const config = interpolate(parsed, source, env) as Record<string, unknown>;
	validate(config, source);
	return config as NekoConfig;
}

/**
 * Merge `overrides` onto `base` with `undefined` meaning "keep the base value"
 * (CLI flags > config file > defaults). `gateway` merges field by field.
 */
export function mergeNekoConfig(base: NekoConfig, overrides: NekoConfig): NekoConfig {
	return {
		...(base.defaultModel !== undefined || overrides.defaultModel !== undefined
			? { defaultModel: overrides.defaultModel ?? base.defaultModel }
			: {}),
		...(base.thinkingLevel !== undefined || overrides.thinkingLevel !== undefined
			? { thinkingLevel: overrides.thinkingLevel ?? base.thinkingLevel }
			: {}),
		...(base.storagePath !== undefined || overrides.storagePath !== undefined
			? { storagePath: overrides.storagePath ?? base.storagePath }
			: {}),
		...(base.theme !== undefined || overrides.theme !== undefined ? { theme: overrides.theme ?? base.theme } : {}),
		...(base.gateway !== undefined || overrides.gateway !== undefined
			? {
					gateway: mergeGateway(base.gateway, overrides.gateway),
				}
			: {}),
		...(base.skills !== undefined || overrides.skills !== undefined
			? { skills: { ...base.skills, ...overrides.skills } }
			: {}),
		...(base.webSearch !== undefined || overrides.webSearch !== undefined
			? { webSearch: { ...base.webSearch, ...overrides.webSearch } }
			: {}),
		...(base.context !== undefined || overrides.context !== undefined
			? { context: mergeContextSettings(base.context, overrides.context) }
			: {}),
		...(base.shell !== undefined || overrides.shell !== undefined
			? { shell: { ...base.shell, ...overrides.shell } }
			: {}),
	};
}

function mergeGateway(
	base: NekoGatewayConfig | undefined,
	overrides: NekoGatewayConfig | undefined,
): NekoGatewayConfig | undefined {
	if (overrides === undefined) return base;
	if (base === undefined) return overrides;
	return {
		...(base.host !== undefined || overrides.host !== undefined ? { host: overrides.host ?? base.host } : {}),
		...(base.port !== undefined || overrides.port !== undefined ? { port: overrides.port ?? base.port } : {}),
		// null 是显式禁用 Unix 传输的取值，不能被 ?? 吞掉。
		...(base.socketPath !== undefined || overrides.socketPath !== undefined
			? { socketPath: overrides.socketPath !== undefined ? overrides.socketPath : base.socketPath }
			: {}),
	};
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function interpolate(value: unknown, source: string, env: NodeJS.ProcessEnv): unknown {
	if (typeof value === "string") {
		return value.replace(ENV_REFERENCE, (whole: string, braced: string | undefined, bare: string | undefined) => {
			const name = braced ?? bare ?? whole;
			const replacement = env[name];
			if (replacement === undefined) {
				throw new Error(`neko config: ${source} references $${name}, but that environment variable is not set.`);
			}
			return replacement;
		});
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, source, env));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = interpolate(item, source, env);
		return out;
	}
	return value;
}

function validate(config: Record<string, unknown>, source: string): void {
	const model = config.defaultModel;
	if (model !== undefined) {
		if (typeof model !== "object" || model === null) {
			throw new Error(`neko config: ${source}: "defaultModel" must be an object with provider and modelId.`);
		}
		const { provider, modelId } = model as Record<string, unknown>;
		if (typeof provider !== "string" || typeof modelId !== "string" || provider === "" || modelId === "") {
			throw new Error(`neko config: ${source}: "defaultModel" needs non-empty string provider and modelId.`);
		}
	}
	const level = config.thinkingLevel;
	if (level !== undefined && typeof level !== "string") {
		throw new Error(`neko config: ${source}: "thinkingLevel" must be a string.`);
	}
	const storagePath = config.storagePath;
	if (storagePath !== undefined && typeof storagePath !== "string") {
		throw new Error(`neko config: ${source}: "storagePath" must be a string.`);
	}
	const gateway = config.gateway;
	if (gateway !== undefined) {
		if (typeof gateway !== "object" || gateway === null) {
			throw new Error(`neko config: ${source}: "gateway" must be an object.`);
		}
		const { host, port, socketPath } = gateway as Record<string, unknown>;
		if (host !== undefined && typeof host !== "string") {
			throw new Error(`neko config: ${source}: "gateway.host" must be a string.`);
		}
		if (port !== undefined && (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535)) {
			throw new Error(`neko config: ${source}: "gateway.port" must be an integer between 0 and 65535.`);
		}
		if (socketPath !== undefined && socketPath !== null && typeof socketPath !== "string") {
			throw new Error(`neko config: ${source}: "gateway.socketPath" must be a string or null.`);
		}
	}
	const theme = config.theme;
	if (theme !== undefined && theme !== "light" && theme !== "dark" && theme !== "auto") {
		throw new Error(`neko config: ${source}: "theme" must be "light", "dark", or "auto".`);
	}
	const skills = config.skills;
	if (skills !== undefined) {
		if (typeof skills !== "object" || skills === null) {
			throw new Error(`neko config: ${source}: "skills" must be an object.`);
		}
		const { marketUrl } = skills as Record<string, unknown>;
		if (marketUrl !== undefined && typeof marketUrl !== "string") {
			throw new Error(`neko config: ${source}: "skills.marketUrl" must be a string.`);
		}
	}
	const shell = config.shell;
	if (shell !== undefined) {
		if (typeof shell !== "object" || shell === null || Array.isArray(shell)) {
			throw new Error(`neko config: ${source}: "shell" must be an object.`);
		}
		const { path } = shell as Record<string, unknown>;
		if (path !== undefined && typeof path !== "string") {
			throw new Error(`neko config: ${source}: "shell.path" must be a string.`);
		}
	}
	const webSearch = config.webSearch;
	if (webSearch !== undefined) {
		if (typeof webSearch !== "object" || webSearch === null || Array.isArray(webSearch)) {
			throw new Error(`neko config: ${source}: "webSearch" must be an object.`);
		}
		const { provider } = webSearch as Record<string, unknown>;
		if (provider !== undefined && !isSearchProvider(provider)) {
			throw new Error(
				`neko config: ${source}: "webSearch.provider" must be one of ${SEARCH_PROVIDERS.map((item) => `"${item}"`).join(", ")}.`,
			);
		}
	}
	if (config.context !== undefined) {
		try {
			parseContextSettings(config.context);
		} catch (error) {
			throw new Error(`neko config: ${source}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
