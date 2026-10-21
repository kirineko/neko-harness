import { relativeTime } from "@neko-harness/core/session-display";
import { getLanguage, type Language } from "../language.ts";

/** zh → zh-CN, en → en-GB; every date shown in the UI goes through these helpers so locales never mix. */
export const LOCALES: Record<Language, string> = { zh: "zh-CN", en: "en-GB" };

export function formatDateTime(ms: number, language: Language = getLanguage()): string {
	return new Date(ms).toLocaleString(LOCALES[language]);
}

export function formatDate(ms: number, language: Language = getLanguage()): string {
	return new Date(ms).toLocaleDateString(LOCALES[language]);
}

/** Relative time such as `5m` / `5 分钟前`; older than 30 days falls back to the absolute date. */
export function formatRelative(at: number, now: number, language: Language = getLanguage()): string {
	return relativeTime(at, now, language);
}
