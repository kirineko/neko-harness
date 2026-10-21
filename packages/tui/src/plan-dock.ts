import {
	type Component,
	type Focusable,
	Input,
	isKeyRelease,
	isKeyRepeat,
	Markdown,
	matchesKey,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PLAN_LIMITS } from "@neko-harness/core/interactions";
import type { PlanClient } from "@neko-harness/gateway/client-session";
import type { WirePlanDecision, WirePlanRecord, WirePlanView } from "@neko-harness/gateway/contract";
import type { NoticeLevel } from "./components/notice.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { plainLine, plainText } from "./plain-text.ts";
import { getActiveThemeMode, getMarkdownTheme, style, theme } from "./theme/index.ts";

/** The expanded panel never takes more rows than this; the layout may grant fewer. */
export const PLAN_MAX_ROWS = 16;
/** Spacer, header, one body row, three action rows, status row and hints: below this the panel cannot be operated. */
export const PLAN_MIN_ROWS = 8;

type Zone = "list" | "text";
type State = { cursor: number; zone: Zone; input: Input; scroll: number };
type Note = { text: string; tone: "error" | "warn" };
type Found = { record: WirePlanRecord; checking: boolean };
type Info = { text: string; tone: "ok" | "warn" | "dim" };

const STATUS_LABELS: Partial<Record<WirePlanRecord["status"], string>> = {
	approved: "Approved",
	revision_requested: "Changes requested",
	superseded: "Superseded",
	cancelled: "Cancelled",
};
const APPROVE_ROW = 0;
const REVISE_ROW = 1;
const EXIT_ROW = 2;
const ACTION_LABELS = ["Approve and execute", "Request changes", "Cancel and exit plan mode"] as const;

export type PlanDockOptions = {
	changed: () => void;
	notify: (message: string, level: NoticeLevel) => void;
	/** A line for the panel's status row when nothing else needs it, e.g. that an approval is waiting. */
	aside?: () => string | undefined;
	/** The panel opened or closed; the owner moves the terminal focus accordingly. */
	opened?: (open: boolean) => void;
	now?: () => number;
};

const keyOf = (session: string, version: string) => `${session}\u0000${version}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the saved record says happened to a plan, whoever decided. */
export function planSettlementText(record: WirePlanRecord): Info {
	switch (record.status) {
		case "approved":
			return { text: "Already approved: the assistant is executing the plan.", tone: "ok" };
		case "revision_requested":
			return {
				text: `Changes were already requested${record.feedback ? `: ${plainLine(record.feedback, 300)}` : "."}`,
				tone: "dim",
			};
		case "superseded":
			return { text: "This plan was replaced by a newer one.", tone: "dim" };
		case "cancelled":
			return { text: "Cancelled: the run was stopped or the session closed.", tone: "warn" };
		default:
			return { text: "Waiting for your decision", tone: "dim" };
	}
}

/** Whether the saved record is the very decision the user made (otherwise someone else won the race). */
export function sameDecision(decision: WirePlanDecision, saved: WirePlanRecord): boolean {
	if (decision.kind === "approve") return saved.status === "approved";
	return saved.status === "revision_requested" && saved.feedback === decision.feedback;
}

/**
 * The assistant's plan above the editor, shown only while open (a footer hint says one is waiting). It owns the
 * keys while open: Enter chooses the highlighted row, A approves, R asks for changes with a typed note, Esc only
 * closes. The decision is bound to the plan version; the saved record decides what is shown afterwards.
 */
export class PlanDock implements Component, Focusable {
	/** Row budget from the layout. */
	height = PLAN_MAX_ROWS;
	#opts: PlanDockOptions;
	#session = "";
	#client: PlanClient | undefined;
	#online = true;
	#view: WirePlanView | undefined;
	#open = false;
	#focused = false;
	#shown: WirePlanRecord | undefined;
	#closedAt = 0;
	#rows = new Map<number, number>();
	/** Rendered body lines per plan version and width; Markdown parsing is not free and the panel redraws often. */
	#bodyCache = new Map<string, string[]>();
	#bodyPage = 1;
	#states = new Map<string, State>();
	#notes = new Map<string, Note>();
	#busy = new Set<string>();
	#checked = new Map<string, WirePlanRecord | null>();
	#checking = new Set<string>();
	/** Plan versions that already had their one chance to open by themselves. */
	#considered = new Set<string>();
	/** Records a decision returned, which are authoritative until the view catches up. */
	#saved = new Map<string, WirePlanRecord>();

	constructor(options: PlanDockOptions) {
		this.#opts = options;
	}

	get open(): boolean {
		return this.#open;
	}
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#syncFocus();
	}
	/** Whether the gateway reports plan mode at all (an old gateway does not). */
	get supported(): boolean {
		return this.#view !== undefined;
	}
	get mode(): "normal" | "plan" | undefined {
		return this.#view?.mode;
	}
	/** A submitted plan is waiting for the user's decision. */
	get awaiting(): boolean {
		return this.#view?.current?.status === "awaiting_approval";
	}
	get canExpand(): boolean {
		return this.height >= PLAN_MIN_ROWS;
	}

	/** Attach to a session (or none): closes the panel and forgets what was shown; feedback drafts are dropped. */
	bind(session: string, client: PlanClient | undefined): void {
		this.closePanel();
		this.#session = session;
		this.#client = client;
		this.#online = client !== undefined;
		this.#view = undefined;
		this.#shown = undefined;
		this.#states.clear();
		this.#notes.clear();
		this.#checked.clear();
		this.#saved.clear();
		this.#considered.clear();
	}
	/** The gateway link is gone: decisions cannot be sent, and nothing is resent after a reconnect. */
	setOnline(online: boolean): void {
		this.#online = online;
		this.#opts.changed();
	}
	dispose(): void {
		this.closePanel();
		this.#client = undefined;
		this.#online = false;
	}

	/** Reconcile with the view's plan; `undefined` means the gateway has no plan mode. */
	update(view: WirePlanView | undefined): void {
		this.#view = view;
		if (!this.#open) return;
		const shown = this.#shown;
		if (!view || !shown) {
			this.closePanel();
			return;
		}
		if (view.current?.version !== shown.version) this.#check(shown);
	}

	/**
	 * A newly waiting plan opens by itself, once per version, when the caller says nothing else holds the keys
	 * (empty editor, no picker or approval). Otherwise the footer hint is all that shows, and `/plan` opens it.
	 */
	autoOpen(allowed: boolean): boolean {
		const current = this.#view?.current;
		if (!current || current.status !== "awaiting_approval") return false;
		const key = keyOf(this.#session, current.version);
		if (this.#considered.has(key)) return false;
		this.#considered.add(key);
		if (!allowed || this.#open || !this.canExpand) return false;
		return this.openPanel();
	}
	openPanel(): boolean {
		const current = this.#view?.current;
		if (!current || current.status !== "awaiting_approval") return false;
		if (this.#open) return true;
		this.#open = true;
		this.#shown = current;
		this.#ensureState(current);
		this.#syncFocus();
		this.#opts.opened?.(true);
		this.#opts.changed();
		return true;
	}
	closePanel(): void {
		if (!this.#open) return;
		this.#open = false;
		this.#closedAt = this.#now();
		this.#syncFocus();
		this.#opts.opened?.(false);
		this.#opts.changed();
	}
	/** Auto-repeat of the Esc that just closed the panel must not fall through and stop the run. */
	swallowEscRepeat(data: string): boolean {
		return isKeyRepeat(data) && matchesKey(data, "escape") && this.#now() - this.#closedAt < 400;
	}
	#now(): number {
		return this.#opts.now?.() ?? Date.now();
	}

	/** The record to show: the live one while its version is current, otherwise what the gateway says it became. */
	#record(): Found | undefined {
		const shown = this.#shown;
		if (!shown) return undefined;
		const key = keyOf(this.#session, shown.version);
		const saved = this.#saved.get(key);
		if (saved) return { record: saved, checking: false };
		const current = this.#view?.current;
		if (current && current.version === shown.version) return { record: current, checking: false };
		if (this.#checked.has(key)) {
			const found = this.#checked.get(key);
			return { record: found ?? { ...shown, status: "superseded" }, checking: false };
		}
		return { record: shown, checking: true };
	}

	#check(shown: WirePlanRecord): void {
		const client = this.#client;
		const key = keyOf(this.#session, shown.version);
		if (!client || !this.#online || this.#checked.has(key) || this.#checking.has(key)) return;
		const session = this.#session;
		this.#checking.add(key);
		void client
			.get(shown.version)
			.then((record) => {
				if (session === this.#session) this.#checked.set(key, record);
			})
			.catch(() => {
				if (session === this.#session) this.#checked.set(key, null);
			})
			.finally(() => {
				this.#checking.delete(key);
				this.#opts.changed();
			});
	}

	#ensureState(record: WirePlanRecord): State {
		const key = keyOf(this.#session, record.version);
		const existing = this.#states.get(key);
		if (existing) return existing;
		const state: State = {
			cursor: APPROVE_ROW,
			zone: "list",
			input: new Input({ prompt: "✎ ", placeholder: "What should change?", placeholderStyle: theme.dim }),
			scroll: 0,
		};
		this.#states.set(key, state);
		return state;
	}

	#syncFocus(): void {
		const shown = this.#shown;
		const current = shown && this.#states.get(keyOf(this.#session, shown.version));
		for (const state of this.#states.values())
			state.input.focused = this.#focused && this.#open && state === current && state.zone === "text";
	}

	/** The panel can be operated: the plan is still waiting, nothing is being sent and the panel is tall enough. */
	#form(): { record: WirePlanRecord; state: State; key: string } | undefined {
		const found = this.#record();
		if (!found || found.checking || found.record.status !== "awaiting_approval" || !this.canExpand) return undefined;
		const key = keyOf(this.#session, found.record.version);
		if (this.#busy.has(key)) return undefined;
		return { record: found.record, state: this.#ensureState(found.record), key };
	}

	#note(key: string, text: string, tone: Note["tone"]): void {
		this.#notes.set(key, { text, tone });
		this.#opts.changed();
	}

	async #decide(decision: WirePlanDecision): Promise<void> {
		const form = this.#form();
		if (!form) return;
		const { record, key, state } = form;
		const client = this.#client;
		if (!this.#online || !client) {
			this.#note(key, "Gateway unavailable. Restart to reconnect; nothing is sent automatically.", "error");
			return;
		}
		const session = this.#session;
		this.#busy.add(key);
		this.#notes.delete(key);
		this.#opts.changed();
		try {
			const saved = await client.respond({ version: record.version, decision });
			if (session !== this.#session) return;
			if (sameDecision(decision, saved)) {
				this.#states.delete(key);
				this.#opts.notify(
					decision.kind === "approve"
						? "Plan approved. Executing."
						: "Changes requested. The assistant will revise the plan.",
					"info",
				);
				this.#shown = undefined;
				this.closePanel();
			} else {
				state.zone = "list";
				this.#syncFocus();
				this.#saved.set(key, saved);
				if (this.#open) this.#shown = saved;
				else this.#opts.notify(planSettlementText(saved).text, "warning");
			}
		} catch (error) {
			if (session === this.#session) this.#notes.set(key, { text: messageOf(error), tone: "error" });
		} finally {
			this.#busy.delete(key);
			this.#opts.changed();
		}
	}

	/** Leaves plan mode, which cancels the waiting plan; shares the busy guard with approve/revise. */
	async #exitPlan(form: { key: string }): Promise<void> {
		const { key } = form;
		const client = this.#client;
		if (!this.#online || !client) {
			this.#note(key, "Gateway unavailable. Restart to reconnect; nothing is sent automatically.", "error");
			return;
		}
		const session = this.#session;
		this.#busy.add(key);
		this.#notes.delete(key);
		this.#opts.changed();
		try {
			await client.setMode("normal");
			if (session !== this.#session) return;
			this.#states.delete(key);
			this.#opts.notify("Plan cancelled. Plan mode off.", "info");
			this.#shown = undefined;
			this.closePanel();
		} catch (error) {
			if (session === this.#session) this.#notes.set(key, { text: messageOf(error), tone: "error" });
		} finally {
			this.#busy.delete(key);
			this.#opts.changed();
		}
	}

	#revise(form: { key: string; state: State }): void {
		const feedback = form.state.input.getValue();
		if (feedback.trim() === "") {
			this.#note(form.key, "Type what should change, then press Enter.", "warn");
			return;
		}
		if (feedback.length > PLAN_LIMITS.feedbackChars) {
			this.#note(form.key, `Feedback is too long (${feedback.length}/${PLAN_LIMITS.feedbackChars}).`, "warn");
			return;
		}
		void this.#decide({ kind: "revise", feedback });
	}

	scroll(delta: number): void {
		const found = this.#record();
		if (!found) return;
		const state = this.#ensureState(found.record);
		state.scroll = Math.max(0, state.scroll + delta);
		this.#opts.changed();
	}

	/**
	 * Returns whether the key was consumed. While open every key is consumed except Ctrl+C, which keeps its global
	 * meaning (stop the run or exit); Esc only closes the panel.
	 */
	handleInput(data: string): boolean {
		if (!this.#open) return false;
		if (matchesKey(data, "ctrl+c")) return false;
		if (isKeyRelease(data)) return true;
		if (matchesKey(data, "escape")) {
			this.closePanel();
			return true;
		}
		if (matchesKey(data, "pageUp")) this.scroll(-this.#bodyPage);
		else if (matchesKey(data, "pageDown")) this.scroll(this.#bodyPage);
		else {
			const form = this.#form();
			if (form) this.#formKey(data, form);
			else this.#infoKey(data);
		}
		this.#opts.changed();
		return true;
	}

	#infoKey(data: string): void {
		const current = this.#view?.current;
		if (!matchesKey(data, "enter") || !current || current.status !== "awaiting_approval") return;
		if (current.version === this.#shown?.version) return;
		this.#shown = current;
		this.#ensureState(current);
		this.#syncFocus();
	}

	#formKey(data: string, form: { record: WirePlanRecord; state: State; key: string }): void {
		const { state } = form;
		this.#notes.delete(form.key);
		const switchZone = (zone: Zone) => {
			state.zone = zone;
			this.#syncFocus();
		};
		if (state.zone === "text") {
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab") || matchesKey(data, "up")) switchZone("list");
			else if (matchesKey(data, "enter")) this.#revise(form);
			else state.input.handleInput(data);
			return;
		}
		if (matchesKey(data, "up")) state.cursor = Math.max(APPROVE_ROW, state.cursor - 1);
		else if (matchesKey(data, "down")) state.cursor = Math.min(EXIT_ROW, state.cursor + 1);
		else if (data === "1") state.cursor = APPROVE_ROW;
		else if (data === "2") state.cursor = REVISE_ROW;
		else if (data === "3") state.cursor = EXIT_ROW;
		else if (data === "a" || data === "A") void this.#decide({ kind: "approve" });
		else if (data === "x" || data === "X") void this.#exitPlan(form);
		else if (data === "r" || data === "R") {
			state.cursor = REVISE_ROW;
			switchZone("text");
		} else if (matchesKey(data, "enter")) {
			if (state.cursor === APPROVE_ROW) void this.#decide({ kind: "approve" });
			else if (state.cursor === EXIT_ROW) void this.#exitPlan(form);
			else switchZone("text");
		}
	}

	handleMouse(event: TuiMouseEvent) {
		if (!this.#open) return { handled: true };
		if (event.type === "wheel") {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		const index = this.#rows.get(event.y);
		const form = this.#form();
		if (event.type === "click" && event.button === "left" && index !== undefined && form) {
			form.state.cursor = index;
			form.state.zone = index === REVISE_ROW ? "text" : "list";
			this.#syncFocus();
			this.#opts.changed();
		}
		return { handled: true };
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.#rows.clear();
		if (!this.#open || !this.#shown) return [];
		const rows = this.#panel(width).map((line) => truncateToWidth(line, width));
		// A blank row keeps the panel apart from the transcript above it, like the gaps between transcript blocks.
		if (this.height < PLAN_MIN_ROWS) return rows;
		this.#rows = new Map([...this.#rows].map(([row, index]) => [row + 1, index]));
		return ["", ...rows];
	}

	/** Title in bold, steps and note as Markdown (control characters stripped first; nothing else is trusted more). */
	#bodyLines(record: WirePlanRecord, width: number): string[] {
		const cacheKey = `${keyOf(this.#session, record.version)}\u0000${width}\u0000${getActiveThemeMode()}`;
		const cached = this.#bodyCache.get(cacheKey);
		if (cached) return cached;
		const lines: string[] = [];
		const markdown = (text: string, indent: number): string[] => {
			const rows = new Markdown(plainText(text), 0, 0, getMarkdownTheme()).render(Math.max(1, width - indent));
			while (rows.length > 0 && visibleWidth(rows[rows.length - 1] ?? "") === 0) rows.pop();
			return rows;
		};
		const title = plainLine(record.title, PLAN_LIMITS.titleChars);
		for (const row of wrapTextWithAnsi(title, Math.max(1, width))) lines.push(style.bold(row));
		record.steps.forEach((step, index) => {
			const marker = `${index + 1}. `;
			const pad = " ".repeat(marker.length);
			markdown(step, marker.length).forEach((row, i) => {
				lines.push(`${i === 0 ? marker : pad}${row}`);
			});
		});
		if (record.note.trim() !== "") {
			lines.push("", theme.dim("Note"));
			lines.push(...markdown(record.note, 0));
		}
		if (this.#bodyCache.size > 24) this.#bodyCache.clear();
		this.#bodyCache.set(cacheKey, lines);
		return lines;
	}

	#panel(width: number): string[] {
		const found = this.#record();
		if (!found) return [];
		const { record, checking } = found;
		const total = Math.max(1, Math.floor(this.height) - 1);
		if (this.height < PLAN_MIN_ROWS)
			return [
				theme.warning(` 📋 Assistant plan · enlarge the terminal to decide · ${shortcutHints(["Esc", "Close"])}`),
			];
		const key = keyOf(this.#session, record.version);
		const state = this.#ensureState(record);
		const form = !checking && record.status === "awaiting_approval";
		const busy = this.#busy.has(key);
		const note = this.#notes.get(key);
		const aside = this.#opts.aside?.();
		const statusText = busy
			? theme.dim("Submitting…")
			: note
				? (note.tone === "error" ? theme.error : theme.warning)(plainLine(note.text, 400))
				: form && !this.#online
					? theme.warning("Offline: decisions cannot be sent until the gateway is back.")
					: aside !== undefined
						? theme.warning(plainLine(aside, 400))
						: undefined;
		const settled = checking
			? ({ text: "Checking the result…", tone: "dim" } as Info)
			: form
				? undefined
				: planSettlementText(record);
		const infoLines = settled ? wrapTextWithAnsi(plainText(settled.text), Math.max(1, width - 2)) : [];
		const inputRow = form && (state.zone === "text" || state.input.getValue() !== "");
		const actionRows = form ? ACTION_LABELS.length + (inputRow ? 1 : 0) : Math.min(2, infoLines.length);
		const fixed = 2 + (statusText !== undefined ? 1 : 0);
		const bodyRows = Math.max(1, total - fixed - actionRows);

		const bodyLines = this.#bodyLines(record, Math.max(1, width - 2));
		const shownRows = Math.min(bodyRows, bodyLines.length);
		const maxScroll = Math.max(0, bodyLines.length - shownRows);
		state.scroll = Math.min(state.scroll, maxScroll);
		this.#bodyPage = Math.max(1, shownRows - 1);
		const range = `${state.scroll + 1}-${state.scroll + shownRows}/${bodyLines.length}`;
		const label = form || checking ? "Awaiting approval" : (STATUS_LABELS[record.status] ?? "");
		const title = theme.warning(style.bold("📋 Assistant plan"));
		const headers = [
			[label, maxScroll > 0 ? `lines ${range}` : ""],
			[label, maxScroll > 0 ? range : ""],
			["", maxScroll > 0 ? range : ""],
			["", ""],
		].map(
			([a, b]) =>
				title +
				theme.dim(
					[a, b]
						.filter(Boolean)
						.map((part) => ` · ${part}`)
						.join(""),
				),
		);
		const rows = [headers.find((header) => visibleWidth(header) <= width) ?? headers.at(-1) ?? title];
		for (const line of bodyLines.slice(state.scroll, state.scroll + shownRows)) rows.push(`${theme.dim("│ ")}${line}`);

		if (form) {
			for (const [index, text] of ACTION_LABELS.entries()) {
				this.#rows.set(rows.length, index);
				rows.push(this.#actionRow(state, index, text, width));
			}
			if (inputRow) {
				const marker = state.zone === "text" && !busy ? theme.accent("▸ ") : "  ";
				rows.push(marker + (state.input.render(Math.max(1, width - 2))[0] ?? ""));
			}
		} else if (settled) {
			const tone = { ok: theme.ok, warn: theme.warning, dim: theme.dim }[settled.tone];
			for (const line of infoLines.slice(0, actionRows)) rows.push(tone(` ${line}`));
		}
		if (statusText !== undefined) rows.push(` ${statusText}`);
		rows.push(this.#hints(form ? state : undefined, maxScroll > 0, width));
		return rows;
	}

	#actionRow(state: State, index: number, text: string, width: number): string {
		const atCursor = index === state.cursor;
		const marker = atCursor ? (state.zone === "list" ? "❯" : "›") : " ";
		const row = truncateToWidth(`${marker} ${index + 1}. ${text}`, width, "…");
		return atCursor && state.zone === "list" ? theme.selection(row) : row;
	}

	#hints(state: State | undefined, scrollable: boolean, width: number): string {
		type Hint = readonly [string, string];
		const close: Hint = ["Esc", "Close"];
		const scrollHint: Hint[] = scrollable ? [["PgUp/PgDn", "Scroll"]] : [];
		const newer = this.#view?.current;
		let candidates: Hint[][];
		if (state) {
			candidates =
				state.zone === "text"
					? [
							[["Enter", "Send"], ["Tab", "Options"], ...scrollHint, close],
							[["Enter", "Send"], close],
						]
					: [
							[
								["↑↓", "Move"],
								["Enter", "Choose"],
								["A", "Approve"],
								["R", "Changes"],
								["X", "Exit plan"],
								...scrollHint,
								close,
							],
							[["Enter", "Choose"], ["A", "Approve"], ["R", "Changes"], ["X", "Exit plan"], close],
							[["Enter", "Choose"], ["A", "Approve"], ["R", "Changes"], ["X", "Exit"], close],
							[["Enter", "Choose"], close],
						];
		} else {
			const enter: Hint[] =
				newer?.status === "awaiting_approval" && newer.version !== this.#shown?.version
					? [["Enter", "Newest plan"]]
					: [];
			candidates = [[...enter, ...scrollHint, close], [close]];
		}
		const lines = candidates.map((parts) => ` ${shortcutHints(...parts)}`);
		return lines.find((line) => visibleWidth(line) <= width) ?? truncateToWidth(lines.at(-1) ?? "", width);
	}
}
