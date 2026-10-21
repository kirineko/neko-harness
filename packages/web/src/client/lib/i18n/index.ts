import { useMemo } from "react";
import { getLanguage, type Language, useLanguage } from "../language.ts";
import { en } from "./en.ts";
import { zh } from "./zh.ts";

export { getLanguage, type Language, useLanguage };

export type Zh = typeof zh;
export type MessageKey = keyof Zh;

type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer R}` ? P | ParamNames<R> : never;
type ParamValue = string | number;

/** Keys without placeholders take no params; others require exactly the names written as `{name}` in zh. */
export type TranslateArgs<K extends MessageKey> = [ParamNames<Zh[K]>] extends [never]
	? []
	: [params: Record<ParamNames<Zh[K]>, ParamValue>];

export type Translate = <K extends MessageKey>(key: K, ...args: TranslateArgs<K>) => string;

/** Keys without placeholders: safe to keep in data tables and translate at render time with `t(key)`. */
export type PlainKey = { [K in MessageKey]: [ParamNames<Zh[K]>] extends [never] ? K : never }[MessageKey];

export const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { zh, en };

const PLACEHOLDER = /\{(\w+)\}/g;

/** Missing params throw so a wrong call is caught in development; extra params are ignored. */
export function format(template: string, params: Record<string, ParamValue> | undefined, key = ""): string {
	return template.replace(PLACEHOLDER, (_match, name: string) => {
		const value = params?.[name];
		if (value === undefined) throw new Error(`i18n: missing param "${name}" for "${key}"`);
		return String(value);
	});
}

export function translator(language: Language): Translate {
	const dictionary = DICTIONARIES[language];
	return ((key: MessageKey, params?: Record<string, ParamValue>) =>
		format(dictionary[key], params, key)) as unknown as Translate;
}

/** 非 React 代码用：按调用时刻的当前语言取译文函数（不要在模块加载期缓存结果）。 */
export function getT(): Translate {
	return translator(getLanguage());
}

/** 组件用：语言切换时重新渲染。 */
export function useT(): Translate {
	const language = useLanguage();
	return useMemo(() => translator(language), [language]);
}
