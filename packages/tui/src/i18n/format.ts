import { relativeTime as coreRelativeTime } from "@neko-harness/core/session-display";
import { getLanguage, type Language } from "./index.ts";

export const dateLocale = (language: Language): string => (language === "zh" ? "zh-CN" : "en-GB");

/** Absolute time in the interface language (`zh-CN` / `en-GB`). */
export function formatDateTime(ms: number, language: Language = getLanguage()): string {
	return new Date(ms).toLocaleString(dateLocale(language));
}

export function relativeTime(at: number, now: number, language: Language = getLanguage()): string {
	return coreRelativeTime(at, now, language);
}
