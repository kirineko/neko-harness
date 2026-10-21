import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { WireQueuedInput, WireSteerResult, WireWithdrawResult } from "@neko-harness/gateway/contract";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { t } from "./i18n/index.ts";
import { theme } from "./theme/index.ts";

/** Item rows above the editor; one more row carries the key hint, so the block is at most `QUEUE_ROWS + 1` lines. */
export const QUEUE_ROWS = 2;
export const QUEUE_BLOCK_LINES = QUEUE_ROWS + 1;

const modeLabel = (mode: WireQueuedInput["mode"]) => (mode === "steer" ? t("queue.steer") : t("queue.queued"));
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const content = (item: WireQueuedInput) =>
	oneLine(item.preview) ||
	(item.images > 0 ? t(item.images > 1 ? "queue.imagesMany" : "queue.imagesOne", { count: item.images }) : "");

/**
 * Messages accepted while the run is busy and not yet in the transcript. The newest ones sit next to the editor;
 * Alt+Up selects them, and while one is selected Enter steers it and Esc withdraws it (the run is never stopped).
 */
export class QueueRow implements Component {
	#items: readonly WireQueuedInput[] = [];
	#selected: number | undefined;

	setItems(items: readonly WireQueuedInput[]): void {
		this.#items = items;
		if (items.length === 0) this.#selected = undefined;
		else if (this.#selected !== undefined) this.#selected = Math.min(this.#selected, items.length - 1);
	}
	get visible(): boolean {
		return this.#items.length > 0;
	}
	get selecting(): boolean {
		return this.#selected !== undefined;
	}
	get current(): WireQueuedInput | undefined {
		return this.#selected === undefined ? undefined : this.#items[this.#selected];
	}
	/** Start selecting at the newest message. */
	select(): boolean {
		if (this.#items.length === 0) return false;
		this.#selected = this.#items.length - 1;
		return true;
	}
	clear(): void {
		this.#selected = undefined;
	}
	/** Move toward older (-1) or newer (+1) messages; moving past the newest one leaves the selection. */
	move(delta: -1 | 1): void {
		if (this.#selected === undefined) return;
		const next = this.#selected + delta;
		if (next >= this.#items.length) this.#selected = undefined;
		else this.#selected = Math.max(0, next);
	}

	render(width: number): string[] {
		const total = this.#items.length;
		if (total === 0) return [];
		const end = this.#selected === undefined ? total : Math.max(this.#selected + 1, Math.min(total, QUEUE_ROWS));
		const start = Math.max(0, end - QUEUE_ROWS);
		const rows = this.#items.slice(start, end).map((item, offset) => {
			const picked = start + offset === this.#selected;
			const text = `${modeLabel(item.mode)} · ${content(item)}`;
			return truncateToWidth(picked ? ` ${theme.accent(`› ${text}`)}` : `   ${theme.muted(text)}`, width);
		});
		const earlier = start > 0 ? t("queue.earlier", { count: start }) : "";
		const later = end < total ? t("queue.newer", { count: total - end }) : "";
		const hint =
			this.#selected === undefined
				? shortcutHints(["Alt+↑", t("action.selectQueued")])
				: shortcutHints(["Enter", t("queue.steer")], ["Esc", t("action.withdraw")], ["↑/↓", t("action.move")]);
		rows.push(truncateToWidth(theme.dim(` ${earlier}${later}${hint}`), width));
		return rows;
	}
	invalidate(): void {}
}

export type QueueKeyAction = "select" | "up" | "down" | "steer" | "withdraw" | "leave";

/**
 * What a key does to the queue selection. `undefined` means the key is not about the queue. While a message is
 * selected Esc only withdraws it (callers must not also stop the run); any key not listed leaves the selection
 * and still reaches the editor.
 */
export function queueKeyAction(row: QueueRow, data: string, autocompleteOpen: boolean): QueueKeyAction | undefined {
	if (!row.selecting) return matchesKey(data, "alt+up") && row.visible && !autocompleteOpen ? "select" : undefined;
	if (matchesKey(data, "up")) return "up";
	if (matchesKey(data, "down")) return "down";
	if (matchesKey(data, "enter")) return "steer";
	if (matchesKey(data, "escape")) return "withdraw";
	return "leave";
}

/** A withdrawn message returns to the editor; below existing text it goes on a new line so nothing typed is lost. */
export function restoreText(existing: string, text: string): string {
	return existing.trim() ? `${existing}\n${text}` : text;
}

export function steerNotice(outcome: { result: WireSteerResult["result"] }): {
	message: string;
	level: "info" | "warning";
} {
	if (outcome.result === "steered") return { message: t("queue.steered"), level: "info" };
	if (outcome.result === "withdrawn") return { message: t("queue.steerWithdrawn"), level: "warning" };
	if (outcome.result === "unknown") return { message: t("queue.gone"), level: "warning" };
	return { message: t("queue.steerSettled"), level: "warning" };
}

export function withdrawNotice(outcome: { result: WireWithdrawResult["result"]; images?: number | undefined }): {
	message: string;
	level: "info" | "warning";
} {
	if (outcome.result === "withdrawn")
		return outcome.images
			? { message: t("queue.withdrawnImages"), level: "warning" }
			: { message: t("queue.withdrawn"), level: "info" };
	if (outcome.result === "unknown") return { message: t("queue.gone"), level: "warning" };
	return { message: t("queue.withdrawSettled"), level: "warning" };
}
