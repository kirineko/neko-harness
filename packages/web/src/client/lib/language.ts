import { useSyncExternalStore } from "react";

/**
 * Web 界面语言偏好：只存浏览器本地（localStorage `neko.language`），不经 gateway。
 * `index.html` 的首屏脚本按同一键名在渲染前设置 `<html lang>`（test/language.test.ts 对拍）。
 * 缺失、损坏或非法取值一律回退中文；不提供「跟随系统」。
 */

export const LANGUAGE_KEY = "neko.language";

export const LANGUAGES = ["zh", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "zh";

/** `<html lang>` 取值。 */
export const HTML_LANG: Record<Language, string> = { zh: "zh-CN", en: "en" };

export function parseLanguage(raw: unknown): Language {
	return raw === "zh" || raw === "en" ? raw : DEFAULT_LANGUAGE;
}

export function readStoredLanguage(storage: Pick<Storage, "getItem"> | undefined = defaultStorage()): Language {
	try {
		return parseLanguage(storage?.getItem(LANGUAGE_KEY));
	} catch {
		return DEFAULT_LANGUAGE;
	}
}

/** 默认值直接删除存储项，避免遗留。浏览器禁用存储时只在当前页面生效。 */
export function writeStoredLanguage(
	language: Language,
	storage: Pick<Storage, "setItem" | "removeItem"> | undefined = defaultStorage(),
): void {
	try {
		if (language === DEFAULT_LANGUAGE) storage?.removeItem(LANGUAGE_KEY);
		else storage?.setItem(LANGUAGE_KEY, language);
	} catch {
		// 浏览器禁用存储时只是不记忆。
	}
}

/** 同步 <html lang>。 */
export function applyLanguage(language: Language, doc: Document | undefined = defaultDocument()): void {
	doc?.documentElement.setAttribute("lang", HTML_LANG[language]);
}

function defaultStorage(): Storage | undefined {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

function defaultDocument(): Document | undefined {
	return typeof document === "undefined" ? undefined : document;
}

type Listener = () => void;
type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** 内存快照 + storage 事件同步；非 React 代码（notice、lib/*）经 `get()` 读取当前语言。 */
export function createLanguageStore(options: { storage?: Storage; doc?: Document; target?: Target } = {}) {
	const storage = options.storage ?? defaultStorage();
	const doc = options.doc ?? defaultDocument();
	const target: Target | undefined = options.target ?? (typeof window === "undefined" ? undefined : window);
	let current = readStoredLanguage(storage);
	const listeners = new Set<Listener>();

	function commit(next: Language): void {
		if (next === current) return;
		current = next;
		applyLanguage(current, doc);
		for (const listener of listeners) listener();
	}

	const onStorage = (event: Event): void => {
		const key = (event as StorageEvent).key;
		// key 为 null 表示整个存储被清空。
		if (key === null || key === LANGUAGE_KEY) commit(readStoredLanguage(storage));
	};

	return {
		get: (): Language => current,
		set(language: Language): void {
			const next = parseLanguage(language);
			writeStoredLanguage(next, storage);
			commit(next);
		},
		/** 恢复默认并清除保存值（测试用）。 */
		reset(): void {
			writeStoredLanguage(DEFAULT_LANGUAGE, storage);
			commit(DEFAULT_LANGUAGE);
		},
		/** 启动时调用：读取保存值、同步 <html lang> 并订阅其他标签页的变更。 */
		start(): void {
			current = readStoredLanguage(storage);
			applyLanguage(current, doc);
			target?.addEventListener("storage", onStorage);
		},
		stop(): void {
			target?.removeEventListener("storage", onStorage);
		},
		subscribe(listener: Listener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export type LanguageStore = ReturnType<typeof createLanguageStore>;

let shared: LanguageStore | undefined;

export function languageStore(): LanguageStore {
	shared ??= createLanguageStore();
	return shared;
}

export function getLanguage(): Language {
	return languageStore().get();
}

export function useLanguage(store: LanguageStore = languageStore()): Language {
	return useSyncExternalStore(store.subscribe, store.get, () => DEFAULT_LANGUAGE);
}
