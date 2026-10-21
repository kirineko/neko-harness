import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "./i18n/index.ts";

export const TUI_SETTINGS_FILENAME = "tui.json";

export const tuiSettingsPath = (nekoDir: string): string => join(nekoDir, TUI_SETTINGS_FILENAME);

function readDocument(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The saved language, or `undefined` when the file is missing, unreadable, corrupted or holds an invalid value. */
export function readSavedLanguage(nekoDir: string): Language | undefined {
	const value = readDocument(tuiSettingsPath(nekoDir))?.language;
	return isLanguage(value) ? value : undefined;
}

export type SaveLanguageResult = { readonly ok: true } | { readonly ok: false; readonly error: Error };

/**
 * Writes `language` into `<nekoDir>/tui.json`, keeping unknown fields, via a temp file and rename. A corrupted
 * existing file is replaced. Failures are returned, never thrown, so the caller can still apply the language.
 */
export function saveLanguage(nekoDir: string, language: Language): SaveLanguageResult {
	const path = tuiSettingsPath(nekoDir);
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const document = { ...readDocument(path), language };
		writeFileSync(temp, `${JSON.stringify(document, null, "\t")}\n`);
		renameSync(temp, path);
		return { ok: true };
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// The temp file may never have been created (for example when the directory could not be made).
		}
		return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
	}
}

/** `--lang` value; anything but zh / en is an argument error. */
export function parseLanguageFlag(value: string): Language {
	if (isLanguage(value)) return value;
	throw new Error(`--lang must be zh or en; received: ${value}`);
}

/** `NEKO_LANG`; an invalid or empty value is ignored. */
export function parseLanguageEnv(value: string | undefined): Language | undefined {
	return isLanguage(value) ? value : undefined;
}

/** Priority: `--lang` > `NEKO_LANG` > saved value > `zh`; a value that is not zh / en is skipped. */
export function resolveLanguage(input: {
	readonly flag?: string | undefined;
	readonly env?: string | undefined;
	readonly saved?: string | undefined;
}): Language {
	for (const value of [input.flag, input.env, input.saved]) if (isLanguage(value)) return value;
	return DEFAULT_LANGUAGE;
}
