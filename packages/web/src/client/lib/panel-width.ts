import { useSyncExternalStore } from "react";
import { clampSidePanelWidth, SIDE_PANEL_WIDTH } from "./layout.ts";

/**
 * 右侧面板（工作区 / 后台任务 / 子 agent）共用宽度偏好：只存浏览器本地（localStorage `neko.panelWidth`），
 * 不经 gateway。拖拽过程中只改内存（`set`），调整结束才写盘（`commit`）。
 */
export const PANEL_WIDTH_KEY = "neko.panelWidth";

/** 缺失、非数字或非有限值回落默认；越界值夹到最近的合法边界。 */
export function parsePanelWidth(raw: string | null | undefined): number {
	if (raw === null || raw === undefined || raw.trim() === "") return SIDE_PANEL_WIDTH.initial;
	const value = Number(raw);
	return Number.isFinite(value) ? clampSidePanelWidth(value) : SIDE_PANEL_WIDTH.initial;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Listener = () => void;

function browserStorage(): StorageLike | undefined {
	try {
		return localStorage;
	} catch {
		// 浏览器禁用存储时访问 localStorage 本身就会抛错。
		return undefined;
	}
}

export function createPanelWidthStore(
	options: { storage?: StorageLike; target?: Pick<EventTarget, "addEventListener" | "removeEventListener"> } = {},
) {
	const storage = options.storage ?? browserStorage();
	const read = (): number => {
		try {
			return parsePanelWidth(storage?.getItem(PANEL_WIDTH_KEY));
		} catch {
			return SIDE_PANEL_WIDTH.initial;
		}
	};
	let current = read();
	const listeners = new Set<Listener>();
	const notify = (next: number): void => {
		if (next === current) return;
		current = next;
		for (const listener of listeners) listener();
	};
	const write = (): void => {
		try {
			if (current === SIDE_PANEL_WIDTH.initial) storage?.removeItem(PANEL_WIDTH_KEY);
			else storage?.setItem(PANEL_WIDTH_KEY, String(current));
		} catch {
			// 存储不可用时只在当前页面内生效。
		}
	};
	const onStorage = (event: Event): void => {
		const key = (event as StorageEvent).key;
		// key 为 null 表示整个存储被清空。
		if (key === null || key === PANEL_WIDTH_KEY) notify(read());
	};
	const target = options.target ?? (typeof window === "undefined" ? undefined : window);
	return {
		get: (): number => current,
		/** 只更新内存并通知（拖拽中）。 */
		set(width: number): void {
			notify(clampSidePanelWidth(width));
		},
		/** 把当前宽度写入存储（调整结束）。 */
		commit(): void {
			write();
		},
		/** 恢复默认宽度并写入存储。 */
		reset(): void {
			notify(SIDE_PANEL_WIDTH.initial);
			write();
		},
		subscribe(listener: Listener): () => void {
			if (listeners.size === 0) target?.addEventListener("storage", onStorage);
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) target?.removeEventListener("storage", onStorage);
			};
		},
	};
}

export type PanelWidthStore = ReturnType<typeof createPanelWidthStore>;

let shared: PanelWidthStore | undefined;

export function panelWidthStore(): PanelWidthStore {
	shared ??= createPanelWidthStore();
	return shared;
}

export function usePanelWidth(store: PanelWidthStore = panelWidthStore()) {
	const width = useSyncExternalStore(store.subscribe, store.get, () => SIDE_PANEL_WIDTH.initial);
	return { width, set: store.set, commit: store.commit, reset: store.reset };
}
