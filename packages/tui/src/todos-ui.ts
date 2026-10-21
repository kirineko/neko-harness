import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type TodoStatus, todoProgress } from "@neko-harness/core/interactions";
import { TODOS_UNSUPPORTED } from "@neko-harness/gateway/client-session";
import type { WireTodoList } from "@neko-harness/gateway/contract";
import type { PickerDetail, PickerPanel } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { localizeCoreText } from "./i18n/core-text.ts";
import { t } from "./i18n/index.ts";
import { plainText } from "./plain-text.ts";
import { theme } from "./theme/index.ts";

export const todosEmpty = (): string => t("todos.empty");
export const TODO_GLYPHS: Record<TodoStatus, string> = { pending: "○", in_progress: "◐", completed: "✓" };
const legend = (): string =>
	t("todos.legend", { pending: TODO_GLYPHS.pending, inProgress: TODO_GLYPHS.in_progress, done: TODO_GLYPHS.completed });

/** `Todos 2/5` for the status bar; `undefined` when the gateway has no todos or the list is empty. */
export function todoProgressText(list: WireTodoList | undefined): string | undefined {
	if (!list || list.items.length === 0) return undefined;
	const { completed, total } = todoProgress(list.items);
	return t("todos.progress", { completed, total });
}

const styled = (status: TodoStatus, glyph: string, text: string): string =>
	status === "completed"
		? `${theme.ok(glyph)} ${theme.dim(text)}`
		: status === "in_progress"
			? theme.accent(`${glyph} ${text}`)
			: `${theme.muted(glyph)} ${text}`;

/**
 * Read-only view of the model's todo list: a pinned progress header above the scrolling items. The list is read
 * from `source` at every render, so it follows the latest committed state; users never edit it.
 */
export class TodosDetail implements PickerDetail {
	backCloses = true;
	#source: () => WireTodoList | undefined;
	#offline: () => boolean;
	#offset = 0;
	#max = 0;
	#page = 1;
	constructor(source: () => WireTodoList | undefined, offline: () => boolean = () => false) {
		this.#source = source;
		this.#offline = offline;
	}
	get help(): string {
		return shortcutHints(["↑↓/Wheel", t("action.scroll")], ["PgUp/PgDn", t("action.page")], ["Esc", t("action.close")]);
	}
	scroll(delta: number): void {
		this.#offset = Math.max(0, Math.min(this.#max, this.#offset + delta));
	}
	handleKey(data: string): boolean {
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.#page);
		else if (matchesKey(data, "pageDown")) this.scroll(this.#page);
		else if (matchesKey(data, "home")) this.scroll(-this.#max);
		else if (matchesKey(data, "end")) this.scroll(this.#max);
		else return false;
		return true;
	}
	lines(width: number, height: number): readonly string[] {
		const list = this.#source();
		const wrap = (text: string, style: (line: string) => string) =>
			wrapTextWithAnsi(text, Math.max(1, width)).map(style);
		if (!list) return wrap(localizeCoreText(TODOS_UNSUPPORTED), theme.warning);
		const offline = this.#offline() ? wrap(t("todos.offline"), theme.warning) : [];
		if (list.items.length === 0) return [...offline, ...wrap(todosEmpty(), theme.dim)];
		const { completed, total } = todoProgress(list.items);
		const digits = String(total).length;
		const rows: string[] = [];
		list.items.forEach((item, index) => {
			const glyph = TODO_GLYPHS[item.status];
			const number = `${String(index + 1).padStart(digits)}. `;
			const indent = " ".repeat(glyph.length + 1 + number.length);
			const wrapped = plainText(item.text)
				.split("\n")
				.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - indent.length)));
			wrapped.forEach((line, row) => {
				rows.push(row === 0 ? styled(item.status, glyph, `${number}${line}`) : theme.dim(`${indent}${line}`));
			});
		});
		const legendText = legend();
		const legendRow = height >= 5 && visibleWidth(legendText) <= width ? [theme.dim(legendText)] : [];
		const pinned = offline.length + 1 + legendRow.length;
		const room = Math.max(1, height - pinned);
		this.#max = Math.max(0, rows.length - room);
		this.#page = Math.max(1, room - 1);
		this.#offset = Math.min(this.#offset, this.#max);
		const range =
			this.#max > 0
				? t("todos.range", {
						from: this.#offset + 1,
						to: Math.min(rows.length, this.#offset + room),
						total: rows.length,
					})
				: "";
		const header = truncateToWidth(
			`${theme.accent(t("todos.completedOf", { completed, total }))}${theme.dim(range)}`,
			width,
		);
		return [...offline, header, ...legendRow, ...rows.slice(this.#offset, this.#offset + room)];
	}
}

/**
 * Open the read-only todos panel. An old gateway (no `todos` in the view) gets a notice instead; an empty list
 * opens an empty state. Returns whether the panel opened, so the caller can focus it.
 */
export function showTodos(
	panel: PickerPanel,
	source: () => WireTodoList | undefined,
	options: { offline?: () => boolean; notify: (message: string, level: "warning") => void },
): boolean {
	if (panel.open) return false;
	if (!source()) {
		options.notify(localizeCoreText(TODOS_UNSUPPORTED), "warning");
		return false;
	}
	void panel.show(
		t("todos.title"),
		async () => [],
		async () => {},
	);
	panel.showDetail(new TodosDetail(source, options.offline));
	return true;
}
