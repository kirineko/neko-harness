import { useSyncExternalStore } from "react";

/**
 * Web 外观偏好（主题 + 聊天排版）：只存浏览器本地，不经 gateway。
 * 取值列表只在此处维护；`index.html` 的首屏脚本只搬运字符串到 data-* 属性，
 * 样式表不认识的值等于默认，所以两处不需要共享列表。
 */

export const APPEARANCE_KEY = "neko.appearance";

export const THEMES = ["sakura", "light", "dark"] as const;
export const FONTS = ["sans", "serif", "mono"] as const;
export const SIZES = ["13", "14", "16", "18"] as const;
export const WEIGHTS = ["regular", "medium", "semibold"] as const;
export const LEADINGS = ["compact", "normal", "relaxed"] as const;

export type Theme = (typeof THEMES)[number];
export type ChatFont = (typeof FONTS)[number];
export type ChatSize = (typeof SIZES)[number];
export type ChatWeight = (typeof WEIGHTS)[number];
export type ChatLeading = (typeof LEADINGS)[number];

export type Appearance = {
	readonly theme: Theme;
	readonly font: ChatFont;
	readonly size: ChatSize;
	readonly weight: ChatWeight;
	readonly leading: ChatLeading;
};

export const DEFAULT_APPEARANCE: Appearance = {
	theme: "sakura",
	font: "sans",
	size: "14",
	weight: "regular",
	leading: "normal",
};

/** 每个偏好字段对应 <html> 上的 data-* 属性名（与 index.html 首屏脚本一致）。 */
export const ATTRIBUTES = {
	theme: "data-theme",
	font: "data-chat-font",
	size: "data-chat-size",
	weight: "data-chat-weight",
	leading: "data-chat-leading",
} as const satisfies Record<keyof Appearance, string>;

const VALUES: { readonly [K in keyof Appearance]: readonly Appearance[K][] } = {
	theme: THEMES,
	font: FONTS,
	size: SIZES,
	weight: WEIGHTS,
	leading: LEADINGS,
};

const FIELDS = Object.keys(VALUES) as (keyof Appearance)[];

function pick<K extends keyof Appearance>(field: K, raw: unknown): Appearance[K] {
	const allowed: readonly unknown[] = VALUES[field];
	return allowed.includes(raw) ? (raw as Appearance[K]) : DEFAULT_APPEARANCE[field];
}

/** 逐项校验：缺失、损坏或不在预设范围内的字段回落为默认，其余保留。 */
export function parseAppearance(raw: string | null | undefined): Appearance {
	let data: unknown;
	try {
		data = raw ? JSON.parse(raw) : undefined;
	} catch {
		data = undefined;
	}
	const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
	return {
		theme: pick("theme", record.theme),
		font: pick("font", record.font),
		size: pick("size", record.size),
		weight: pick("weight", record.weight),
		leading: pick("leading", record.leading),
	};
}

export function serializeAppearance(value: Appearance): string {
	return JSON.stringify({ v: 1, ...value });
}

export function isDefaultAppearance(value: Appearance): boolean {
	return FIELDS.every((field) => value[field] === DEFAULT_APPEARANCE[field]);
}

export function readStoredAppearance(storage: Pick<Storage, "getItem"> = localStorage): Appearance {
	try {
		return parseAppearance(storage.getItem(APPEARANCE_KEY));
	} catch {
		return DEFAULT_APPEARANCE;
	}
}

/** 默认值的偏好直接删除存储项，避免遗留。浏览器禁用存储时只在当前页面生效。 */
export function writeStoredAppearance(
	value: Appearance,
	storage: Pick<Storage, "setItem" | "removeItem"> = localStorage,
): void {
	try {
		if (isDefaultAppearance(value)) storage.removeItem(APPEARANCE_KEY);
		else storage.setItem(APPEARANCE_KEY, serializeAppearance(value));
	} catch {
		// 浏览器禁用存储时只是不记忆。
	}
}

/** 写 <html> 的 data-* 属性（默认值省略属性，让样式表回落默认）与 meta color-scheme。 */
export function applyAppearance(value: Appearance, doc: Document = document): void {
	const root = doc.documentElement;
	for (const field of FIELDS) {
		if (value[field] === DEFAULT_APPEARANCE[field]) root.removeAttribute(ATTRIBUTES[field]);
		else root.setAttribute(ATTRIBUTES[field], value[field]);
	}
	doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", value.theme === "dark" ? "dark" : "light");
}

type Listener = () => void;

/** 内存快照 + storage 事件同步；快照对象引用稳定，供 useSyncExternalStore 使用。 */
export function createAppearanceStore(
	options: {
		storage?: Storage;
		doc?: Document;
		target?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
	} = {},
) {
	const storage = options.storage ?? localStorage;
	const doc = options.doc ?? document;
	const target = options.target ?? window;
	let current = readStoredAppearance(storage);
	const listeners = new Set<Listener>();

	function commit(next: Appearance): void {
		const same = FIELDS.every((field) => next[field] === current[field]);
		if (same) return;
		current = next;
		applyAppearance(current, doc);
		for (const listener of listeners) listener();
	}

	const onStorage = (event: Event): void => {
		const key = (event as StorageEvent).key;
		// key 为 null 表示整个存储被清空。
		if (key === null || key === APPEARANCE_KEY) commit(readStoredAppearance(storage));
	};

	return {
		get: (): Appearance => current,
		set(patch: Partial<Appearance>): void {
			const next = parseAppearance(serializeAppearance({ ...current, ...patch }));
			writeStoredAppearance(next, storage);
			commit(next);
		},
		reset(): void {
			writeStoredAppearance(DEFAULT_APPEARANCE, storage);
			commit(DEFAULT_APPEARANCE);
		},
		/** 启动时调用：把已保存偏好写到页面（首屏脚本已做过一次，这里同步 meta 与后续订阅）。 */
		start(): void {
			current = readStoredAppearance(storage);
			applyAppearance(current, doc);
			target.addEventListener("storage", onStorage);
		},
		stop(): void {
			target.removeEventListener("storage", onStorage);
		},
		subscribe(listener: Listener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export type AppearanceStore = ReturnType<typeof createAppearanceStore>;

let shared: AppearanceStore | undefined;

export function appearanceStore(): AppearanceStore {
	shared ??= createAppearanceStore();
	return shared;
}

export function useAppearance(store: AppearanceStore = appearanceStore()): Appearance {
	return useSyncExternalStore(store.subscribe, store.get, () => DEFAULT_APPEARANCE);
}
