import { matchesKey, type TuiMouseEvent, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolApproval } from "@neko-harness/core";
import type { NekoGatewayConnection } from "@neko-harness/gateway/client-session";

type SubagentClient = ReturnType<NekoGatewayConnection["subagent"]>;

import type { PickerDetail } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { t } from "./i18n/index.ts";
import { theme } from "./theme/index.ts";

const approvalStatus = (status: ToolApproval["status"]): string => {
	switch (status) {
		case "pending":
			return t("approval.status.pending");
		case "allowed":
			return t("approval.status.allowed");
		case "denied":
			return t("approval.status.denied");
		default:
			return t("approval.status.cancelled");
	}
};

export const approvalText = (text: string) =>
	[...text]
		.map((c) => {
			const n = c.charCodeAt(0);
			return (n < 32 && n !== 9 && n !== 10) ||
				(n >= 127 && n <= 159) ||
				(n >= 8234 && n <= 8238) ||
				(n >= 8294 && n <= 8297)
				? `\\u${n.toString(16).padStart(4, "0")}`
				: c;
		})
		.join("");
/** A separate review surface binds every action to the visible request. */
export class ApprovalDetail implements PickerDetail {
	#item: ToolApproval;
	#stop: () => void;
	#offset = 0;
	#max = 0;
	#height = 1;
	#actionRow = -1;
	#busy = false;
	#error = "";
	#service: SubagentClient;
	#changed: () => void;
	#compact: boolean;
	constructor(item: ToolApproval, service: SubagentClient, changed: () => void, compact = false) {
		this.#compact = compact;
		this.#item = item;
		this.#service = service;
		this.#changed = changed;
		this.#stop = service.view.subscribe((view) => {
			const latest = view?.approvals?.find((a) => a.id === this.#item.id);
			if (latest) this.#item = latest;
			changed();
		});
	}
	close() {
		this.#stop();
	}
	get help() {
		return shortcutHints(
			["↑↓/Wheel", t("action.scroll")],
			...((this.#service.view.value?.approvals?.filter((a) => a.status === "pending").length ?? 0) > 1
				? [["[/]", t("action.request")] as const]
				: []),
			...(this.#item.status === "pending"
				? ([
						["A", t("approval.allowOnce")],
						["D", t("approval.deny")],
					] as const)
				: []),
			["Esc", t("action.back")],
		);
	}
	scroll(delta: number) {
		this.#offset = Math.max(0, Math.min(this.#max, this.#offset + delta));
	}
	async decide(decision: "allowed" | "denied") {
		if (this.#busy || this.#item.status !== "pending") return;
		this.#busy = true;
		this.#changed();
		try {
			const status = await this.#service.decideApproval({ id: this.#item.id, version: this.#item.version, decision });
			this.#item = { ...this.#item, status };
		} catch (e) {
			this.#error = String(e);
		} finally {
			this.#busy = false;
			this.#changed();
		}
	}
	handleKey(key: string) {
		if (key === "[" || key === "]") {
			const pending = this.#service.view.value?.approvals?.filter((a) => a.status === "pending") ?? [];
			if (this.#busy || pending.length < 1) return false;
			const index = pending.findIndex((a) => a.id === this.#item.id);
			this.#item = pending[(index + (key === "]" ? 1 : -1) + pending.length) % pending.length]!;
			this.#offset = 0;
			this.#error = "";
		} else if (key.toLowerCase() === "a") void this.decide("allowed");
		else if (key.toLowerCase() === "d") void this.decide("denied");
		else if (matchesKey(key, "up")) this.scroll(-1);
		else if (matchesKey(key, "down")) this.scroll(1);
		else if (matchesKey(key, "pageUp")) this.scroll(-this.#height);
		else if (matchesKey(key, "pageDown")) this.scroll(this.#height);
		else return false;
		return true;
	}
	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "click" || event.button !== "left" || event.y !== this.#actionRow || event.x < 0 || event.x > 21)
			return false;
		void this.decide(event.x < 16 ? "allowed" : "denied");
		return true;
	}
	lines(width: number, height: number) {
		this.#height = height;
		const a = this.#item;
		const timeout = a.timeout ?? t("approval.timeoutDefault");
		const rows = [
			...(this.#compact
				? []
				: [
						theme.accent(
							t("approval.title", { status: this.#busy ? t("approval.submitting") : approvalStatus(a.status) }),
						),
					]),
			...wrapTextWithAnsi(
				approvalText(
					this.#compact
						? `${t("approval.cwdTimeout", { cwd: a.cwd, timeout })}\n${a.command}`
						: `${t("approval.cwd", { cwd: a.cwd })}\n${t("approval.timeout", { timeout })}\n\n${a.command}`,
				),
				width,
			),
		];
		if (this.#error) rows.push(...wrapTextWithAnsi(approvalText(this.#error), width));
		const actionable = a.status === "pending" && !this.#busy;
		const bodyHeight = Math.max(1, height - (actionable ? 1 : 0));
		this.#max = Math.max(0, rows.length - bodyHeight);
		this.#offset = Math.min(this.#offset, this.#max);
		const visible = rows.slice(this.#offset, this.#offset + bodyHeight);
		this.#actionRow = -1;
		if (actionable && height > 1) {
			this.#actionRow = visible.length;
			visible.push(shortcutHints(["A", t("approval.allowOnce")], ["D", t("approval.deny")]));
		}
		return visible;
	}
}
