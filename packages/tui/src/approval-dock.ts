import { matchesKey, SelectList, Text, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type { Delegation } from "@neko-harness/core";
import { ApprovalQueue, type NekoGatewayConnection } from "@neko-harness/gateway/client-session";
import { approvalText } from "./approval-ui.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { getLanguage, t } from "./i18n/index.ts";
import { getSelectListTheme, theme } from "./theme/index.ts";

/** An automatically focused Pi selection list above the editor. */
export class ApprovalDock {
	height = 8;
	#queue: ApprovalQueue;
	#id: number | undefined;
	#presented: number | undefined;
	#changed: () => void;
	#choices: SelectList;
	#choicesLanguage = getLanguage();
	#offset = 0;
	#max = 0;
	#choiceRow = 0;
	#busy = new Set<number>();
	#settled = new Set<number>();
	#error = "";
	constructor(connect: NekoGatewayConnection["subagent"], changed: () => void) {
		this.#changed = changed;
		this.#choices = this.#newChoices(0);
		this.#queue = new ApprovalQueue(connect, () => {
			this.#sync();
			changed();
		});
	}
	#newChoices(selected: number): SelectList {
		const choices = new SelectList(
			[
				{ value: "allowed", label: t("approval.allowOnce") },
				{ value: "denied", label: t("approval.deny") },
			],
			2,
			getSelectListTheme(),
		);
		choices.onSelect = ({ value }) => {
			void this.#decide(value as "allowed" | "denied");
		};
		choices.setSelectedIndex(selected);
		return choices;
	}
	get #pending() {
		return this.#queue.pending.filter(({ item }) => !this.#settled.has(item.id));
	}
	get visible() {
		return this.#pending.length > 0 || !!this.#queue.error;
	}
	get focused() {
		return this.#pending.length > 0;
	}
	update(entries: readonly Delegation[]) {
		this.#queue.update(entries);
	}
	close() {
		this.#queue.close();
		this.#settled.clear();
	}
	#sync() {
		const pending = this.#pending;
		const selected = pending.find(({ item }) => item.id === this.#id) ?? pending[0];
		if (selected?.item.id === this.#id) return;
		this.#id = selected?.item.id;
		this.#presented = undefined;
		this.#offset = 0;
		this.#error = "";
		this.#choices.setSelectedIndex(0);
	}
	async #decide(decision: "allowed" | "denied") {
		const request = this.#pending.find(({ item }) => item.id === this.#id);
		if (!request || this.#presented !== request.item.id || this.#busy.has(request.item.id)) return;
		const { item, service } = request;
		this.#busy.add(item.id);
		this.#changed();
		try {
			const status = await service.decideApproval({ id: item.id, version: item.version, decision });
			if (status !== "pending") this.#settled.add(item.id);
			this.#sync();
		} catch (error) {
			if (this.#id === item.id) this.#error = String(error);
		} finally {
			this.#busy.delete(item.id);
			this.#changed();
		}
	}
	scroll(delta: number) {
		this.#offset = Math.max(0, Math.min(this.#max, this.#offset + delta));
		this.#changed();
	}
	handleInput(data: string): boolean {
		if (!this.focused || matchesKey(data, "ctrl+c")) return false;
		if (matchesKey(data, "pageUp")) this.scroll(-Math.max(1, this.height - 4));
		else if (matchesKey(data, "pageDown")) this.scroll(Math.max(1, this.height - 4));
		else if (data === "[" || data === "]") {
			const pending = this.#pending;
			const index = pending.findIndex(({ item }) => item.id === this.#id);
			const next = pending[(index + (data === "]" ? 1 : -1) + pending.length) % pending.length];
			if (next && next.item.id !== this.#id) {
				this.#id = next.item.id;
				this.#presented = undefined;
				this.#offset = 0;
				this.#error = "";
				this.#choices.setSelectedIndex(0);
			}
		} else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter"))
			this.#choices.handleInput(data);
		this.#changed();
		return true;
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type === "wheel") {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (event.y >= this.#choiceRow && event.y < this.#choiceRow + 2) {
			const result = this.#choices.handleMouse({ ...event, y: event.y - this.#choiceRow, height: 2 });
			this.#changed();
			return { ...result, handled: true };
		}
		return { handled: true };
	}
	render(width: number): string[] {
		if (!this.visible) return [];
		if (this.#choicesLanguage !== getLanguage()) {
			const selected = this.#choices.getSelectedItem()?.value === "denied" ? 1 : 0;
			this.#choices = this.#newChoices(selected);
			this.#choicesLanguage = getLanguage();
		}
		const pending = this.#pending;
		const selected = pending.find(({ item }) => item.id === this.#id);
		if (!selected) return new Text(approvalText(this.#queue.error ?? t("common.loading")), 0, 0).render(width);
		const { item, title } = selected;
		this.#presented = item.id;
		const header = theme.accent(
			truncateToWidth(
				approvalText(t("approval.header", { index: pending.indexOf(selected) + 1, total: pending.length, title })),
				width,
			),
		);
		const timeout = item.timeout ?? t("approval.timeoutDefault");
		const body = new Text(
			approvalText(
				`${item.command}\n${t("approval.cwd", { cwd: item.cwd })}\n${t("approval.timeout", { timeout })}${this.#error ? `\n${this.#error}` : ""}`,
			),
			0,
			0,
		).render(width);
		const bodyHeight = Math.max(1, this.height - 4);
		this.#max = Math.max(0, body.length - bodyHeight);
		this.#offset = Math.min(this.#offset, this.#max);
		const rows = [header, ...body.slice(this.#offset, this.#offset + bodyHeight)];
		this.#choiceRow = rows.length;
		rows.push(
			...(this.#busy.has(item.id) ? [theme.dim(t("approval.submittingDots")), ""] : this.#choices.render(width)),
		);
		rows.push(
			truncateToWidth(
				shortcutHints(["↑↓", t("action.select")], ["Enter", t("action.confirm")], ["PgUp/PgDn", t("action.scroll")]),
				width,
			),
		);
		return rows;
	}
	invalidate() {
		this.#choices.invalidate();
	}
}
