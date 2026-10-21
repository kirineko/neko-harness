import { type Component, matchesKey } from "@earendil-works/pi-tui";
import {
	type ChatItem,
	type ChatView,
	type Delegation,
	mergeTranscriptItems,
	type SubagentSummary,
	summarizeSubagents,
} from "@neko-harness/core";
import { downloadImage } from "@neko-harness/core/image-transfer";
import type { NekoGatewayConnection } from "@neko-harness/gateway/client-session";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { HistoryImage } from "./components/history-image.ts";
import type { PickerDetail, PickerPanel } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { ThemedText } from "./components/themed-text.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { t } from "./i18n/index.ts";
import { theme } from "./theme/index.ts";

const statusLabel = (status: Delegation["status"]): string => {
	switch (status) {
		case "queued":
			return t("subagent.queued");
		case "running":
			return t("subagent.running");
		case "completed":
			return t("subagent.done");
		case "failed":
			return t("subagent.failed");
		default:
			return t("subagent.stopped");
	}
};
const liveStatus = (status: SubagentSummary["status"]): string =>
	status === "idle" ? t("subagent.idle") : status === "queued" ? t("subagent.queued") : t("subagent.running");
export const subagentItems = (entries: readonly Delegation[], summaries = summarizeSubagents(entries)) =>
	summaries.map((d) => ({
		value: d.agentId,
		label: `${d.role} · ${d.title}`,
		description: `${d.historyThrough !== undefined ? t("subagent.snapshot") : ""}${d.taskTitle} · ${t("subagent.rounds", { count: d.roundCount })}`,
		rightLabel: d.approvalCount ? t("footer.approval", { count: d.approvalCount }) : liveStatus(d.status),
	}));
export class SubagentDetail implements PickerDetail {
	get help() {
		const canStop = this.identity
			? this.identity.activeRoundId !== null && this.identity.historyThrough === undefined
			: this.entry?.historyThrough === undefined &&
				(this.entry?.status === "running" || this.entry?.status === "queued");
		return shortcutHints(
			["←", t("action.main")],
			["↑↓/Wheel", t("action.scroll")],
			["E", t("action.expand")],
			...(canStop ? [["S", t("action.stop")] as const] : []),
		);
	}
	#view: ChatView | undefined;
	#entries = new Map<string, ChatItem>();
	#components = new Map<string, Component>();
	#images = new Map<string, HistoryImage>();
	#offset = 0;
	#maxOffset = 0;
	#pageSize = 10;
	#prependOffset: number | undefined;
	#follow = true;
	#expanded = false;
	#before: number | null | undefined;
	#error = "";
	#loading = false;
	#stop: (() => void) | undefined;
	#service: ReturnType<NekoGatewayConnection["subagent"]>;
	#changed: () => void;
	#panel: PickerPanel;
	#active = false;
	entry: Delegation | undefined;
	identity: SubagentSummary | undefined;
	#targetRound: number | undefined;
	#locating = false;
	#epoch = 0;
	constructor(client: NekoGatewayConnection, taskId: number | string, panel: PickerPanel, changed: () => void) {
		this.#service = client.subagent(taskId);
		this.#changed = changed;
		this.#panel = panel;
	}
	open() {
		if (this.#active) return this;
		this.#epoch++;
		this.#before = undefined;
		this.#active = true;
		this.#stop = this.#service.view.subscribe((view) => {
			if (!this.#active) return;
			this.#error = this.#service.error ?? "";
			if (!view) {
				this.#changed();
				return;
			}
			if (this.#entries.size && !view.items.some((item) => this.#entries.has(item.key)))
				this.#before = view.historyBefore;
			this.#view = view;
			if (this.#before === undefined) this.#before = view.historyBefore;
			this.#entries = new Map(
				mergeTranscriptItems([...this.#entries.values()], view.items).map((item) => [item.key, item]),
			);
			void this.#loadTarget();
			this.#changed();
		});
		return this;
	}
	locate(taskId: number) {
		this.#targetRound = taskId;
		void this.#loadTarget();
		this.#changed();
	}
	async #loadTarget() {
		if (this.#locating || !this.#active || this.#targetRound === undefined) return;
		const entryId = this.#view?.rounds?.find((r) => r.taskId === this.#targetRound)?.inputEntryId;
		if (entryId === undefined) return;
		this.#locating = true;
		try {
			while (this.#active && !this.#entries.has(`e${entryId}`) && this.#before != null && !this.#loading) {
				const before = this.#before;
				await this.history();
				if (before === this.#before) break;
			}
		} finally {
			this.#locating = false;
			this.#changed();
		}
	}
	close() {
		this.#epoch++;
		this.#active = false;
		this.#stop?.();
		this.#stop = undefined;
		for (const image of this.#images.values()) image.setVisible(false);
	}
	async history() {
		if (this.#loading || this.#before == null) return;
		this.#loading = true;
		const epoch = this.#epoch;
		try {
			const result = await this.#service.history(this.#before === undefined ? {} : { before: this.#before });
			if (!this.#active || epoch !== this.#epoch) return;
			this.#prependOffset = this.#maxOffset;
			this.#entries = new Map(
				mergeTranscriptItems([...this.#entries.values()], result.items).map((item) => [item.key, item]),
			);
			this.#before = result.next;
			this.#follow = false;
		} catch (e) {
			if (this.#active) this.#error = String(e);
		} finally {
			this.#loading = false;
			this.#changed();
		}
	}
	scroll(delta: number) {
		this.#offset = Math.max(0, Math.min(this.#maxOffset, this.#offset + delta));
		this.#follow = delta > 0 && this.#offset === this.#maxOffset;
		if (delta < 0 && this.#offset === 0) void this.history();
	}
	handleKey(data: string) {
		if (matchesKey(data, "up")) {
			this.scroll(-1);
		} else if (matchesKey(data, "down")) {
			this.scroll(1);
		} else if (matchesKey(data, "pageUp")) {
			this.scroll(-this.#pageSize);
		} else if (matchesKey(data, "pageDown")) {
			this.scroll(this.#pageSize);
		} else if (data.toLowerCase() === "e") {
			this.#expanded = !this.#expanded;
			for (const component of this.#components.values()) {
				if (component instanceof ToolExecutionComponent) component.setExpanded(this.#expanded);
				if (component instanceof AssistantMessageComponent) component.setThinkingExpanded(this.#expanded);
			}
		} else if (
			data.toLowerCase() === "s" &&
			this.entry?.historyThrough === undefined &&
			(this.identity?.activeRoundId != null ||
				(!this.identity && (this.entry?.status === "running" || this.entry?.status === "queued")))
		) {
			const stopTaskId = this.identity?.activeRoundId ?? this.entry?.taskId;
			this.#panel.showDetail({
				help: shortcutHints(["Enter", t("action.stop")], ["Esc", t("action.back")]),
				lines: () => [theme.warning(t("subagent.confirmStop"))],
				handleKey: (key) => {
					if (!matchesKey(key, "enter")) return false;
					void this.#service
						.stop(stopTaskId === undefined ? null : { taskId: stopTaskId })
						.catch((e) => {
							this.#error = String(e);
						})
						.finally(() => {
							this.#panel.popDetail();
							this.#changed();
						});
					return true;
				},
			});
		} else return false;
		return true;
	}
	#component(item: ChatItem): Component {
		let existing = this.#components.get(item.key);
		if (!existing) {
			existing =
				item.type === "assistant"
					? new AssistantMessageComponent()
					: item.type === "tool"
						? new ToolExecutionComponent(item)
						: item.type === "user"
							? new UserMessageComponent(item.text, item.skill, item.defaultImagePrompt)
							: new ThemedText(item.text, theme.dim, 1, 0);
			this.#components.set(item.key, existing);
			if (existing instanceof ToolExecutionComponent) existing.setExpanded(this.#expanded);
			if (existing instanceof AssistantMessageComponent) existing.setThinkingExpanded(this.#expanded);
		}
		if (item.type === "assistant" && existing instanceof AssistantMessageComponent)
			existing.updateContent({ thinking: item.thinking, text: item.text, note: item.note });
		if (item.type === "tool" && existing instanceof ToolExecutionComponent) existing.sync(item);
		return existing;
	}
	lines(width: number, height: number): readonly string[] {
		this.#pageSize = Math.max(1, height - 1);
		const entry = this.entry;
		const rows: string[] = entry
			? [
					theme.accent(`${entry.role} · ${this.identity?.title ?? entry.title}`),
					theme.dim(
						`${entry.historyThrough !== undefined ? t("subagent.snapshot") : ""}${this.identity ? liveStatus(this.identity.status) : statusLabel(entry.status)} · ${Math.max(0, Math.round(((entry.endedAt ?? Date.now()) - entry.createdAt) / 1000))}s`,
					),
					"",
				]
			: [];
		if (this.#view)
			rows.push(
				theme.dim(
					t("subagent.total", {
						input: this.#view.usage.input,
						output: this.#view.usage.output,
						cost: `$${this.#view.usage.cost.toFixed(4)}`,
					}),
				),
				"",
			);
		const imageRows: { image: HistoryImage; start: number; end: number }[] = [];
		let targetOffset: number | undefined;
		for (const item of [...this.#entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
			if (item.type === "user") {
				const round = this.#view?.rounds?.find((r) => r.inputEntryId === item.id || r.taskId === item.subagentRoundId);
				if (round?.taskId === this.#targetRound) targetOffset = rows.length;
				if (round) {
					rows.push(
						theme.accent(
							t("subagent.task", { round: round.round ?? "", title: round.title, status: statusLabel(round.status) }),
						),
					);
					const u = round.roundUsage;
					rows.push(
						theme.dim(
							u
								? t("subagent.roundUsage", {
										input: u.input,
										output: u.output,
										cacheRead: u.cacheRead,
										cacheWrite: u.cacheWrite,
										cost: `$${u.cost.toFixed(4)}`,
									})
								: t("subagent.roundUsageNone"),
						),
					);
				}
			}
			rows.push(...this.#component(item).render(width));
			if (item.type === "tool") {
				for (const approval of this.#view?.approvals ?? [])
					if (approval.callId === item.callId && approval.status !== "pending")
						rows.push(
							theme.dim(
								t("subagent.approval", {
									status:
										approval.status === "allowed"
											? t("subagent.allowedOnce")
											: approval.status === "denied"
												? t("subagent.denied")
												: t("subagent.cancelled"),
								}),
							),
						);
			}
			rows.push("");
			if (item.type === "user" || item.type === "tool")
				for (const image of item.images ?? []) {
					const key = `${image.entryId}:${image.contentIndex}`;
					let component = this.#images.get(key);
					if (!component) {
						component = new HistoryImage(
							image,
							() =>
								downloadImage((offset) =>
									this.#service.getImage({ entryId: image.entryId, contentIndex: image.contentIndex, offset }),
								),
							this.#changed,
						);
						this.#images.set(key, component);
					}
					const start = rows.length;
					rows.push(...component.measure(width));
					imageRows.push({ image: component, start, end: rows.length });
				}
		}
		const stream = this.#view?.streaming;
		if (stream) {
			let component = this.#components.get("live");
			if (!(component instanceof AssistantMessageComponent)) {
				component = new AssistantMessageComponent();
				this.#components.set("live", component);
			}
			(component as AssistantMessageComponent).updateContent(
				{ thinking: stream.thinking, text: stream.text, note: null },
				true,
			);
			rows.push(...component.render(width));
			for (const call of stream.toolCalls) {
				const saved = [...this.#entries.values()].find((i) => i.type === "tool" && i.callId === call.callId);
				if (saved) continue;
				rows.push(
					...new ToolExecutionComponent({ ...call, isError: false, result: null, durationMs: null, note: null }).render(
						width,
					),
				);
			}
		}
		if (this.#error) rows.push(theme.error(this.#error));
		if (!rows.length) rows.push(theme.dim(t("common.loading")));
		this.#maxOffset = Math.max(0, rows.length - height);
		if (this.#prependOffset !== undefined) {
			this.#offset += Math.max(0, this.#maxOffset - this.#prependOffset);
			this.#prependOffset = undefined;
		}
		if (targetOffset !== undefined) {
			this.#offset = targetOffset;
			this.#follow = false;
			this.#targetRound = undefined;
		}
		this.#offset = this.#follow ? this.#maxOffset : Math.min(this.#offset, this.#maxOffset);
		for (const image of imageRows) {
			image.image.setVisible(this.#active && image.start < this.#offset + height && image.end > this.#offset);
			rows.splice(image.start, image.end - image.start, ...image.image.render(width));
		}
		return rows.slice(this.#offset, this.#offset + height);
	}
}
