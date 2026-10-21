import { en } from "./en.ts";
import { type MessageKey, zh } from "./zh.ts";

export type Language = "zh" | "en";
export type { MessageKey };

export const LANGUAGES: readonly Language[] = ["zh", "en"];
export const DEFAULT_LANGUAGE: Language = "zh";

export type MessageParams = Readonly<Record<string, string | number>>;

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
	? Name | Placeholders<Rest>
	: never;
type ParamNames<K extends MessageKey> = Placeholders<(typeof zh)[K]>;
type ParamsArg<K extends MessageKey> = [ParamNames<K>] extends [never]
	? []
	: [params: { readonly [N in ParamNames<K>]: string | number }];

/** Keys whose message takes no parameters; table-driven code that stores keys must use these. */
export type PlainKey = { [K in MessageKey]: [ParamNames<K>] extends [never] ? K : never }[MessageKey];

const dictionaries: Record<Language, Readonly<Record<MessageKey, string>>> = { zh, en };

let current: Language = DEFAULT_LANGUAGE;
const listeners = new Set<(language: Language) => void>();

export function isLanguage(value: unknown): value is Language {
	return value === "zh" || value === "en";
}

export function getLanguage(): Language {
	return current;
}

/** Switches the process-wide language and tells subscribers; setting the current language is a no-op. */
export function setLanguage(language: Language): void {
	if (language === current) return;
	current = language;
	for (const listener of [...listeners]) listener(language);
}

export function onLanguageChange(listener: (language: Language) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Replaces `{name}` placeholders; a missing parameter is a programming error and throws. */
export function formatMessage(template: string, params: MessageParams = {}): string {
	return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
		const value = params[name];
		if (value === undefined) throw new Error(`Missing i18n parameter "${name}" for "${template}"`);
		return String(value);
	});
}

export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
	return formatMessage(dictionaries[language][key], params);
}

/** Message for the current language; dictionaries are `zh` (authoritative) and `en`. */
export function t<K extends MessageKey>(key: K, ...args: ParamsArg<K>): string {
	return translate(current, key, args[0] as MessageParams | undefined);
}
