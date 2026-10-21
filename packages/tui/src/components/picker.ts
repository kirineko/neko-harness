import {
	type Component,
	Input,
	isKeyRelease,
	matchesKey,
	type SelectItem,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { t } from "../i18n/index.ts";
import { labels } from "../labels.ts";
import { style, theme } from "../theme/index.ts";
import { shortcutHints } from "./shortcut-hints.ts";

export type PickerItem = SelectItem & {
	rightLabel?: string;
	searchText?: string;
	header?: boolean;
	/** Visible but not confirmable: Enter shows this hint instead of picking. */
	blockedHint?: string;
};

/**
 * An in-panel detail view (list stays underneath; Esc pops back to the list).
 * Used by the skill market for skill details / preview / inline confirms.
 */
export type PickerDetail = {
	close?(): void;
	handleMouse?(event: TuiMouseEvent): boolean;
	backCloses?: boolean;
	scroll?(delta: number): void;
	/** Body lines for the current width/height budget. */
	lines(width: number, height: number): readonly string[];
	/** Footer hint shown while the view is open. */
	help: string;
	/** Return true when the key was consumed; Esc/ctrl+c are reserved for popping the view. */
	handleKey(data: string): boolean;
};

const newFilterInput = () => new Input({ prompt: "❯ ", placeholder: t("common.filterPlaceholder") });

/** A single searchable panel. Async generations cannot reopen a closed panel. */
export class PickerPanel implements Component {
	pointerSelection = false;
	agentNavigation = false;
	/** Shown instead of "No results" when the unfiltered list is empty. */
	emptyText: string | undefined;
	/** Keep group headers (only those with matches) while filtering. Reset when the panel closes. */
	groupedFilter = false;
	/** Pre-filter for list keys (e.g. `S`, `←`); return true to consume. Reset when the panel closes. */
	listKey: ((data: string, value: string | undefined) => boolean) | undefined;
	/** Ready-state footer replacing the default select hints (e.g. extra `D` key). Reset when the panel closes. */
	help: string | undefined;
	search = newFilterInput();
	#items: readonly PickerItem[] = [];
	#index = 0;
	#pointerRows = new Map<number, number>();
	#generation = 0;
	#state: "closed" | "loading" | "ready" | "error" | "applying" = "closed";
	#error = "";
	#hint = "";
	#title = "";
	#load: (() => Promise<readonly PickerItem[]>) | undefined;
	// biome-ignore lint/suspicious/noConfusingVoidType: pick 要么无返回（关闭面板）要么返回详情视图
	#pick: ((value: string) => Promise<void | PickerDetail>) | undefined;
	height = 10;
	readonly changed: () => void;
	readonly closed: () => void;
	constructor(changed: () => void, closed: () => void) {
		this.changed = changed;
		this.closed = closed;
	}
	get open(): boolean {
		return this.#state !== "closed";
	}
	get focused(): boolean {
		return this.search.focused;
	}
	set focused(value: boolean) {
		this.search.focused = value;
	}
	/** One-shot message shown below the list until the next keypress (listKey handlers explain a no-op). */
	set hint(value: string) {
		this.#hint = value;
	}
	invalidate(): void {}
	async show(
		title: string,
		load: () => Promise<readonly PickerItem[]>,
		// biome-ignore lint/suspicious/noConfusingVoidType: pick 要么无返回（关闭面板）要么返回详情视图
		pick: (value: string) => Promise<void | PickerDetail>,
	): Promise<void> {
		if (this.open) return;
		this.#title = title;
		this.#load = load;
		this.#pick = pick;
		// A fresh input picks up the placeholder of the current interface language.
		const focused = this.search.focused;
		this.search = newFilterInput();
		this.search.focused = focused;
		this.#index = 0;
		await this.reload();
	}
	async reload(): Promise<void> {
		const generation = ++this.#generation;
		this.#state = "loading";
		this.changed();
		try {
			const items = await this.#load!();
			if (generation !== this.#generation) return;
			this.#items = items;
			this.#state = "ready";
		} catch (error) {
			if (generation !== this.#generation) return;
			this.#error = error instanceof Error ? error.message : String(error);
			this.#state = "error";
		}
		this.changed();
	}
	update(items: readonly PickerItem[]): void {
		if (this.#state !== "ready") return;
		const value = this.#filtered()[this.#index]?.value;
		this.#items = items;
		const filtered = this.#filtered();
		const index = filtered.findIndex((item) => item.value === value);
		this.#index = index < 0 ? Math.max(0, Math.min(this.#index, filtered.length - 1)) : index;
		this.changed();
	}
	close(): void {
		this.pointerSelection = false;
		this.agentNavigation = false;
		this.emptyText = undefined;
		this.groupedFilter = false;
		this.help = undefined;
		this.#hint = "";
		this.listKey = undefined;
		++this.#generation;
		for (const detail of this.#details) detail.close?.();
		this.#details = [];
		this.#state = "closed";
		this.closed();
		this.changed();
	}
	/** Push a detail view above the current content (Esc pops one level at a time). */
	showDetail(detail: PickerDetail): void {
		if (!this.open) return;
		this.#details.push(detail);
		this.changed();
	}
	/** Pop the top detail view, back to the previous view or the list. */
	popDetail(): void {
		if (this.#details.length === 0) return;
		this.#details.pop()?.close?.();
		this.changed();
	}
	get detailOpen(): boolean {
		return this.#details.length > 0;
	}
	get #detail(): PickerDetail | undefined {
		return this.#details[this.#details.length - 1];
	}
	#details: PickerDetail[] = [];
	#filtered(): readonly PickerItem[] {
		const query = this.search.getValue().toLowerCase();
		if (query === "") return this.#items;
		if (!this.groupedFilter) return this.#items.filter((item) => !item.header && this.#matches(item, query));
		// 分组过滤：保留含命中项的组头。
		const result: PickerItem[] = [];
		let header: PickerItem | undefined;
		for (const item of this.#items) {
			if (item.header) header = item;
			else if (this.#matches(item, query)) {
				if (header) result.push(header);
				header = undefined;
				result.push(item);
			}
		}
		return result;
	}
	#matches(item: PickerItem, query: string): boolean {
		return `${item.label} ${item.description ?? ""} ${item.searchText ?? ""}`.toLowerCase().includes(query);
	}
	/** 第一个可选中（非组头）下标。 */
	#firstSelectable(items: readonly PickerItem[]): number {
		return items.findIndex((item) => !item.header);
	}
	#move(delta: -1 | 1): void {
		const items = this.#filtered();
		let next = this.#index + delta;
		while (next >= 0 && next < items.length && items[next]?.header) next += delta;
		this.#index = Math.max(0, Math.min(Math.max(0, items.length - 1), next));
		if (items[this.#index]?.header) this.#index = this.#firstSelectable(items);
	}
	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.agentNavigation && matchesKey(data, "left")) {
			this.close();
			return;
		}
		if (this.agentNavigation && !this.detailOpen && this.search.getValue() === "" && matchesKey(data, "right"))
			data = "\r";
		// 详情视图：Esc 弹回列表，其余键先交给视图。
		if (this.#detail !== undefined) {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				if (this.#detail.backCloses) this.close();
				else this.popDetail();
			} else if (this.#detail.handleKey(data)) {
				this.changed();
			}
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (this.#state === "error") {
			if (matchesKey(data, "enter")) void this.reload();
			return;
		}
		if (this.#state !== "ready") return;
		this.#hint = "";
		const items = this.#filtered();
		if (this.listKey?.(data, items[this.#index]?.value)) {
			this.changed();
			return;
		}
		if (matchesKey(data, "up")) this.#move(-1);
		else if (matchesKey(data, "down")) this.#move(1);
		else if (matchesKey(data, "enter")) {
			const item = items[this.#index];
			if (!item || item.header) return;
			if (item.blockedHint) {
				this.#hint = item.blockedHint;
				this.changed();
				return;
			}
			const generation = this.#generation;
			this.#state = "applying";
			void this.#pick!(item.value).then(
				(result) => {
					if (generation !== this.#generation) {
						if (result && typeof result === "object") result.close?.();
						return;
					}
					// pick 返回 PickerDetail 时进入详情视图而不是关闭（市场详情页）。
					if (result !== undefined && typeof result === "object" && "lines" in result) {
						this.#state = "ready";
						this.showDetail(result as PickerDetail);
						this.changed();
						return;
					}
					this.close();
				},
				(error) => {
					if (generation !== this.#generation) return;
					this.#error = error instanceof Error ? error.message : String(error);
					this.#state = "error";
					this.changed();
				},
			);
		} else {
			this.search.handleInput(data);
			this.#index = this.#firstSelectable(this.#filtered());
		}
		this.changed();
	}
	scrollDetail(delta: number): boolean {
		if (!this.#detail?.scroll) return false;
		this.#detail.scroll(delta);
		this.changed();
		return true;
	}
	handleMouse(event: TuiMouseEvent) {
		if (!this.open) return;
		if (this.#detail?.handleMouse?.({ ...event, x: event.x - 1, y: event.y - 1 })) {
			this.changed();
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left" && this.pointerSelection && !this.detailOpen) {
			const index = this.#pointerRows.get(event.y);
			if (index === undefined) return;
			this.#index = index;
			this.handleInput("\r");
			return { handled: true };
		}
		if (event.type !== "wheel") return;
		if (this.scrollDetail(event.wheelDelta ?? 0)) return { handled: true };
		else if (this.pointerSelection && !this.detailOpen) this.#move((event.wheelDelta ?? 0) < 0 ? -1 : 1);
		else return;
		this.changed();
		return { handled: true };
	}
	render(width: number): string[] {
		this.#pointerRows.clear();
		const height = Math.max(1, this.height);
		const w = Math.max(1, width - 2);
		const rows = [
			`${theme.accent(style.bold(this.#title))}${this.#state === "ready" && !this.#detail?.backCloses ? theme.muted(` (${this.#items.length})`) : ""}`,
		];
		if (this.#detail !== undefined) {
			const hints = wrapTextWithAnsi(this.#detail.help, w).slice(0, Math.max(1, height - 2));
			const body = this.#detail.lines(w, Math.max(1, height - 1 - hints.length));
			rows.push(...body);
			while (rows.length < height - hints.length) rows.push("");
			// 详情视图的 help 由视图自行配色（键位 accent、说明 dim），面板不再整体压暗。
			if (height > 1) rows.push(...hints);
			return rows.slice(0, height).map((line) => theme.panel(` ${truncateToWidth(line, w, "...", true)} `));
		}
		if (height >= 4) rows.push(...this.search.render(w).slice(0, 1));
		const help =
			this.#state === "error"
				? labels.retry
				: this.#state === "ready"
					? this.agentNavigation
						? shortcutHints(["↑↓", t("action.select")], ["→/Enter", t("action.open")], ["←", t("action.main")])
						: (this.help ?? labels.select)
					: labels.close;
		const hint = this.#state === "ready" && height >= 5 ? this.#hint : "";
		const available = Math.max(1, height - rows.length - 1 - (hint ? 1 : 0));
		if (this.#state !== "ready")
			rows.push(
				this.#state === "error"
					? theme.error(t("common.error", { message: this.#error }))
					: this.#state === "applying"
						? labels.applying
						: labels.loading,
			);
		else {
			const items = this.#filtered();
			this.#index = Math.min(this.#index, Math.max(0, items.length - 1));
			if (items[this.#index]?.header) {
				const first = this.#firstSelectable(items);
				if (first >= 0) this.#index = first;
			}
			const selected = items[this.#index];
			const details =
				height >= 9 && !hint && selected?.description ? wrapTextWithAnsi(selected.description, w).slice(0, 2) : [];
			const count = Math.max(1, available - details.length);
			const start = Math.max(0, Math.min(this.#index - Math.floor(count / 2), items.length - count));
			for (const [i, item] of items.slice(start, start + count).entries()) {
				if (item.header) {
					rows.push(theme.dim(` ${item.label}`));
					continue;
				}
				const right = item.rightLabel ?? "";
				const leftWidth = Math.max(1, w - 3 - visibleWidth(right));
				const left = truncateToWidth(item.label, leftWidth, "...");
				const label = right ? `${left}${" ".repeat(Math.max(1, leftWidth - visibleWidth(left) + 1))}${right}` : left;
				const rendered = start + i === this.#index ? theme.selection(`❯ ${label}`) : `  ${label}`;
				if (this.pointerSelection) this.#pointerRows.set(rows.length, start + i);
				rows.push(rendered);
			}
			if (items.length === 0)
				rows.push(this.emptyText !== undefined && this.#items.length === 0 ? this.emptyText : labels.noResults);
			while (rows.length < height - 1 - details.length - (hint ? 1 : 0)) rows.push("");
			rows.push(...details.map((line) => theme.dim(line)));
			if (hint) rows.push(theme.warning(hint));
		}
		while (rows.length < height - 1) rows.push("");
		if (height > 1) rows.push(help);
		return rows.slice(0, height).map((line) => theme.panel(` ${truncateToWidth(line, w, "...", true)} `));
	}
}
