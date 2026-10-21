import {
	type Component,
	type Focusable,
	Input,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	describeSettlement,
	draftProblem,
	draftResponse,
	emptyQuestionDraft,
	type QuestionDraft,
	toggleDraftOption,
	validateQuestionResponse,
} from "@neko-harness/core/interactions";
import type { QuestionsClient } from "@neko-harness/gateway/client-session";
import type { WireQuestionList, WireQuestionRecord, WireQuestionSummary } from "@neko-harness/gateway/contract";
import type { NoticeLevel } from "./components/notice.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { localizeCoreText, localizeError } from "./i18n/core-text.ts";
import { getLanguage, type Language, t } from "./i18n/index.ts";
import { plainLine, plainText } from "./plain-text.ts";
import { style, theme } from "./theme/index.ts";

/** The expanded panel never takes more rows than this; the layout may grant fewer. */
export const QUESTION_MAX_ROWS = 14;
/** Header, one body row, one list row, note row, status row and hints: below this the panel cannot be operated. */
export const QUESTION_MIN_ROWS = 6;
export const skipLabel = (): string => t("question.skip");
/** Key that opens or closes the panel; chosen to be free in the editor, the pickers and the queue/agents keys. */
export const QUESTION_KEY = "ctrl+o";

/** What else could hold the keys when a question first appears. */
export type FocusState = {
	online: boolean;
	usable: boolean;
	editorText: string;
	autocomplete: boolean;
	overlayOpen: boolean;
	approvalFocused: boolean;
	sessionOperation: boolean;
	queueSelecting: boolean;
	/** The plan panel owns the keys. */
	planOpen?: boolean;
};

/**
 * A new question may open by itself only when the user is not in the middle of something: empty editor without
 * completion, no picker/login/approval, no queue selection and a usable terminal. Otherwise only the bar shows.
 */
export const canAutoOpen = (focus: FocusState): boolean =>
	focus.online &&
	focus.usable &&
	focus.editorText === "" &&
	!focus.autocomplete &&
	!focus.overlayOpen &&
	!focus.approvalFocused &&
	!focus.sessionOperation &&
	!focus.queueSelecting &&
	!focus.planOpen;

type Zone = "list" | "text";
type State = { draft: QuestionDraft; cursor: number; zone: Zone; input: Input; language: Language };
type Note = { text: string; tone: "error" | "warn" };
type Entry = { key: string; id: number; version: string; preview: string };
type Settled = { record: WireQuestionRecord; mine: boolean };
type Mode =
	| { kind: "form"; record: WireQuestionRecord; state: State }
	| { kind: "info"; text: string; tone: "ok" | "warn" | "dim" | "error"; retry?: boolean };

export type QuestionDockOptions = {
	changed: () => void;
	notify: (message: string, level: NoticeLevel) => void;
	/** A line for the panel's status row when nothing else needs it, e.g. that an approval is waiting. */
	aside?: () => string | undefined;
	/** The panel opened or closed; the owner moves the terminal focus accordingly. */
	opened?: (open: boolean) => void;
	now?: () => number;
};

const keyOf = (session: string, id: number, version: string) => `${session}\u0000${id}\u0000${version}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The saved record says what really happened, whoever decided. */
export function settlementText(record: WireQuestionRecord, mine: boolean): string {
	if (record.status === "answered") {
		const answer = plainLine(describeSettlement(record));
		return mine ? t("question.answered", { answer }) : t("question.alreadyAnswered", { answer });
	}
	if (record.status === "skipped") return mine ? t("question.skipped") : t("question.alreadySkipped");
	if (record.status === "cancelled") return t("question.cancelled");
	return t("question.waiting");
}

function sameDecision(
	record: WireQuestionRecord,
	response: { kind: "answer"; optionIds?: string[]; text?: string } | { kind: "skip" },
	saved: WireQuestionRecord,
): boolean {
	if (response.kind === "skip") return saved.status === "skipped";
	if (saved.status !== "answered" || !saved.answer) return false;
	try {
		const mine = validateQuestionResponse(record, response);
		if (mine.kind !== "answer") return false;
		return (
			mine.text === saved.answer.text &&
			mine.optionIds.length === saved.answer.optionIds.length &&
			mine.optionIds.every((id, index) => id === saved.answer?.optionIds[index])
		);
	} catch {
		return false;
	}
}

/**
 * The assistant's question above the editor: a one-line prompt bar while closed, the full answer panel while
 * open. Selecting only edits a draft; Enter submits, the last list row skips, Esc only closes (never skips or
 * stops the run). Drafts live in memory per session/question/version.
 */
export class QuestionDock implements Component, Focusable {
	/** Row budget from the layout. */
	height = QUESTION_MAX_ROWS;
	#opts: QuestionDockOptions;
	#session = "";
	#client: QuestionsClient | undefined;
	#online = true;
	#supported = false;
	#pending: readonly WireQuestionSummary[] = [];
	#open = false;
	#focused = false;
	#shown: Entry | undefined;
	#tomb: Entry | undefined;
	#closedAt = 0;
	#rows = new Map<number, number>();
	#bodyPage = 1;
	#records = new Map<string, WireQuestionRecord>();
	#states = new Map<string, State>();
	#scrolls = new Map<string, number>();
	#notes = new Map<string, Note>();
	#loading = new Set<string>();
	#loadErrors = new Map<string, string>();
	#results = new Map<string, Settled>();
	#gone = new Set<string>();
	#busy = new Set<string>();
	#considered = new Set<string>();

	constructor(options: QuestionDockOptions) {
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
	/** Whether the gateway reports questions at all (an old gateway does not). */
	get supported(): boolean {
		return this.#supported;
	}
	/** There is something to show: the prompt bar, or the panel with its current question. */
	get visible(): boolean {
		return this.#supported && this.#entries().length > 0;
	}
	/** Questions waiting for an answer in the active session. */
	get pendingCount(): number {
		return this.#entries().filter((entry) => entry.key !== this.#tomb?.key).length;
	}
	get canExpand(): boolean {
		return this.height >= QUESTION_MIN_ROWS;
	}

	/** Attach to a session (or none): closes the panel and forgets the live list; drafts stay in memory. */
	bind(session: string, client: QuestionsClient | undefined): void {
		this.closePanel();
		this.#session = session;
		this.#client = client;
		this.#online = client !== undefined;
		this.#supported = false;
		this.#pending = [];
		this.#shown = undefined;
		this.#tomb = undefined;
	}
	/** The gateway link is gone: answers cannot be sent, and nothing is resent after a reconnect. */
	setOnline(online: boolean): void {
		this.#online = online;
		this.#opts.changed();
	}
	dispose(): void {
		this.closePanel();
		this.#client = undefined;
		this.#online = false;
	}

	/** Reconcile with the view's pending list; `undefined` means the gateway has no questions. */
	update(list: WireQuestionList | undefined): void {
		this.#supported = list !== undefined;
		this.#pending = list?.pending ?? [];
		const shown = this.#shown;
		if (shown && !this.#entries().some((entry) => entry.key === shown.key)) {
			if (this.#open) {
				this.#tomb = shown;
				this.#resolve(shown);
			} else this.#shown = undefined;
		}
		const entries = this.#entries();
		if (!this.#shown || !entries.some((entry) => entry.key === this.#shown?.key)) this.#shown = entries[0];
		if (entries.length === 0 && this.#open) this.closePanel();
		this.#load(this.#shown);
	}

	/**
	 * Decide, once per question, whether it opens by itself. Callers pass whether nothing else holds the focus
	 * (empty editor, no panel, no approval); a question that appears while the user is busy only shows the bar.
	 */
	autoOpen(allowed: boolean): boolean {
		if (!this.#supported) return false;
		const fresh = this.#entries().filter((entry) => entry.key !== this.#tomb?.key && !this.#considered.has(entry.key));
		for (const entry of fresh) this.#considered.add(entry.key);
		const first = fresh[0];
		if (!allowed || !first || this.#open || !this.canExpand) return false;
		this.#shown = first;
		return this.openPanel();
	}
	openPanel(): boolean {
		if (!this.visible) return false;
		if (this.#open) return true;
		this.#open = true;
		const entries = this.#entries();
		if (!this.#shown || !entries.some((entry) => entry.key === this.#shown?.key)) this.#shown = entries[0];
		this.#load(this.#shown);
		this.#syncFocus();
		this.#opts.opened?.(true);
		this.#opts.changed();
		return true;
	}
	closePanel(): void {
		if (!this.#open) return;
		this.#open = false;
		this.#closedAt = this.#now();
		if (this.#tomb) {
			this.#tomb = undefined;
			this.#shown = this.#entries()[0];
		}
		this.#syncFocus();
		this.#opts.opened?.(false);
		this.#opts.changed();
	}
	toggle(): boolean {
		if (this.#open) {
			this.closePanel();
			return false;
		}
		return this.openPanel();
	}
	/** Auto-repeat of the Esc that just closed the panel must not fall through and stop the run. */
	swallowEscRepeat(data: string): boolean {
		return isKeyRepeat(data) && matchesKey(data, "escape") && this.#now() - this.#closedAt < 400;
	}
	#now(): number {
		return this.#opts.now?.() ?? Date.now();
	}

	#entries(): Entry[] {
		const tomb = this.#tomb;
		const live = this.#pending
			.map((s) => ({ key: keyOf(this.#session, s.id, s.version), id: s.id, version: s.version, preview: s.preview }))
			.filter((entry) => !this.#results.has(entry.key) || entry.key === tomb?.key);
		return tomb && !live.some((entry) => entry.key === tomb.key) ? [...live, tomb] : live;
	}

	#mode(entry: Entry): Mode {
		const settled = this.#results.get(entry.key);
		if (settled) {
			const status = settled.record.status;
			return {
				kind: "info",
				text: settlementText(settled.record, settled.mine),
				tone: status === "answered" ? "ok" : status === "cancelled" ? "warn" : "dim",
			};
		}
		if (this.#gone.has(entry.key)) return { kind: "info", text: t("question.gone"), tone: "dim" };
		if (this.#tomb?.key === entry.key) return { kind: "info", text: t("question.checking"), tone: "dim" };
		const record = this.#records.get(entry.key);
		const state = this.#states.get(entry.key);
		if (record && state) return { kind: "form", record, state };
		const error = this.#loadErrors.get(entry.key);
		if (error)
			return {
				kind: "info",
				text: t("question.loadFailed", { error: plainLine(localizeError(error)) }),
				tone: "error",
				retry: true,
			};
		return { kind: "info", text: t("question.loading"), tone: "dim" };
	}

	/** The panel can be operated: loaded, still pending, not sending, and tall enough to see what is being done. */
	#form(): { entry: Entry; record: WireQuestionRecord; state: State } | undefined {
		const entry = this.#shown;
		if (!entry || this.#busy.has(entry.key) || !this.canExpand) return undefined;
		const mode = this.#mode(entry);
		return mode.kind === "form" ? { entry, record: mode.record, state: mode.state } : undefined;
	}

	#load(entry: Entry | undefined): void {
		const client = this.#client;
		if (!entry || !client || !this.#online || !this.#supported) return;
		const { key } = entry;
		if (
			this.#tomb?.key === key ||
			this.#records.has(key) ||
			this.#loading.has(key) ||
			this.#results.has(key) ||
			this.#gone.has(key) ||
			this.#loadErrors.has(key)
		)
			return;
		const session = this.#session;
		this.#loading.add(key);
		void client
			.get(entry.id)
			.then((record) => {
				if (session !== this.#session) return;
				if (!record) this.#gone.add(key);
				else if (record.status !== "pending") this.#settledElsewhere(entry, record);
				else {
					this.#records.set(key, record);
					this.#ensureState(key, record);
				}
			})
			.catch((error) => {
				if (session === this.#session) this.#loadErrors.set(key, messageOf(error));
			})
			.finally(() => {
				this.#loading.delete(key);
				this.#opts.changed();
			});
	}

	#ensureState(key: string, record: WireQuestionRecord): State {
		const existing = this.#states.get(key);
		if (existing) return existing;
		const input = this.#newInput(record);
		const recommended = record.options.findIndex((option) => option.recommended);
		const state: State = {
			draft: emptyQuestionDraft(),
			// Recommended is only where the cursor starts; nothing is selected for the user.
			cursor: Math.max(0, recommended),
			zone: record.options.length ? "list" : "text",
			input,
			language: getLanguage(),
		};
		this.#states.set(key, state);
		this.#syncFocus();
		return state;
	}

	#newInput(record: WireQuestionRecord): Input {
		return new Input({
			prompt: "✎ ",
			placeholder: record.options.length ? t("question.notePlaceholder") : t("question.answerPlaceholder"),
			placeholderStyle: theme.dim,
		});
	}

	/** The placeholder follows the interface language; the typed text is kept. */
	#refreshInput(record: WireQuestionRecord, state: State): void {
		if (state.language === getLanguage()) return;
		const text = state.input.getValue();
		const focused = state.input.focused;
		state.input = this.#newInput(record);
		state.input.setValue(text);
		state.input.focused = focused;
		state.language = getLanguage();
	}

	#settledElsewhere(entry: Entry, record: WireQuestionRecord): void {
		this.#results.set(entry.key, { record, mine: false });
		if (this.#open && this.#shown?.key === entry.key) this.#tomb = entry;
		else if (this.#shown?.key === entry.key) this.#shown = this.#entries()[0];
	}

	#resolve(entry: Entry): void {
		const { key } = entry;
		if (this.#results.has(key) || this.#busy.has(key) || this.#gone.has(key)) return;
		const client = this.#client;
		if (!client || !this.#online) {
			this.#gone.add(key);
			return;
		}
		const session = this.#session;
		void client
			.get(entry.id)
			.then((record) => {
				if (session !== this.#session) return;
				if (record && record.status !== "pending") this.#results.set(key, { record, mine: false });
				else this.#gone.add(key);
			})
			.catch(() => {
				if (session === this.#session) this.#gone.add(key);
			})
			.finally(() => this.#opts.changed());
	}

	#syncFocus(): void {
		const current = this.#shown && this.#states.get(this.#shown.key);
		for (const state of this.#states.values())
			state.input.focused = this.#focused && this.#open && state === current && state.zone === "text";
	}

	#note(key: string, text: string, tone: Note["tone"]): void {
		this.#notes.set(key, { text, tone });
		this.#opts.changed();
	}

	async #submit(skip: boolean): Promise<void> {
		const form = this.#form();
		if (!form) return;
		const { entry, record, state } = form;
		const { key } = entry;
		if (record.status !== "pending" || this.#results.has(key)) return;
		if (!this.#online || !this.#client) {
			this.#note(key, t("gateway.unavailableNoSend"), "error");
			return;
		}
		const response = skip ? ({ kind: "skip" } as const) : draftResponse(state.draft);
		if (!response) {
			const hint = record.options.length ? t("question.hintChoose") : t("question.hintType");
			this.#note(key, hint, "warn");
			return;
		}
		const problem = skip ? null : draftProblem(record, state.draft);
		if (problem) {
			this.#note(key, localizeCoreText(problem), "warn");
			return;
		}
		const session = this.#session;
		this.#busy.add(key);
		this.#notes.delete(key);
		this.#opts.changed();
		try {
			const saved = await this.#client.respond({ id: entry.id, version: entry.version, response });
			this.#results.set(key, { record: saved, mine: sameDecision(record, response, saved) });
			if (session !== this.#session) return;
			const mine = this.#results.get(key)?.mine === true;
			if (mine) {
				this.#states.delete(key);
				this.#opts.notify(settlementText(saved, true), "info");
				if (this.#tomb?.key === key) this.#tomb = undefined;
				if (this.#shown?.key === key) {
					this.#shown = this.#entries().filter((e) => e.key !== key)[0];
					this.closePanel();
				}
			} else if (this.#open && this.#shown?.key === key) this.#tomb = entry;
			else this.#opts.notify(settlementText(saved, false), "warning");
		} catch (error) {
			if (session === this.#session) {
				this.#notes.set(key, { text: messageOf(error), tone: "error" });
				if (!this.#entries().some((e) => e.key === key && e.key !== this.#tomb?.key)) this.#resolve(entry);
			}
		} finally {
			this.#busy.delete(key);
			this.#opts.changed();
		}
	}

	#move(delta: 1 | -1): void {
		const entries = this.#entries();
		const index = entries.findIndex((entry) => entry.key === this.#shown?.key);
		const next = entries[(index + delta + entries.length) % entries.length];
		if (!next || next.key === this.#shown?.key) return;
		if (this.#tomb) this.#tomb = undefined;
		this.#shown = next;
		this.#load(next);
		this.#syncFocus();
	}

	scroll(delta: number): void {
		const key = this.#shown?.key;
		if (key === undefined) return;
		this.#scrolls.set(key, Math.max(0, (this.#scrolls.get(key) ?? 0) + delta));
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
		if (matchesKey(data, "escape") || matchesKey(data, QUESTION_KEY)) {
			this.closePanel();
			return true;
		}
		const entry = this.#shown;
		if (!entry) return true;
		const form = this.#form();
		const zone = form?.state.zone;
		if (matchesKey(data, "pageUp")) this.scroll(-this.#bodyPage);
		else if (matchesKey(data, "pageDown")) this.scroll(this.#bodyPage);
		else if ((data === "[" || data === "]") && zone !== "text") this.#move(data === "]" ? 1 : -1);
		else if (!form) {
			if (matchesKey(data, "enter") && this.#loadErrors.has(entry.key) && !this.#busy.has(entry.key)) {
				this.#loadErrors.delete(entry.key);
				this.#load(entry);
			}
		} else this.#formKey(data, form);
		this.#opts.changed();
		return true;
	}

	#formKey(data: string, { entry, record, state }: { entry: Entry; record: WireQuestionRecord; state: State }): void {
		const rows = record.options.length + 1;
		this.#notes.delete(entry.key);
		const switchZone = (zone: Zone) => {
			state.zone = zone;
			this.#syncFocus();
		};
		if (data.includes("\x1b[200~") && state.zone === "list") switchZone("text");
		if (state.zone === "text") {
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab") || matchesKey(data, "up")) switchZone("list");
			else if (matchesKey(data, "enter")) void this.#submit(false);
			else {
				state.input.handleInput(data);
				state.draft = { ...state.draft, text: state.input.getValue() };
			}
			return;
		}
		if (matchesKey(data, "up")) state.cursor = Math.max(0, state.cursor - 1);
		else if (matchesKey(data, "down")) state.cursor = Math.min(rows - 1, state.cursor + 1);
		else if (matchesKey(data, "home")) state.cursor = 0;
		else if (matchesKey(data, "end")) state.cursor = rows - 1;
		else if (/^[1-9]$/.test(data)) {
			if (Number(data) <= record.options.length) state.cursor = Number(data) - 1;
		} else if (data === " " || matchesKey(data, "space")) {
			const option = record.options[state.cursor];
			if (option) state.draft = toggleDraftOption(record, state.draft, option.id);
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) switchZone("text");
		else if (matchesKey(data, "enter")) void this.#submit(state.cursor === record.options.length);
	}

	handleMouse(event: TuiMouseEvent) {
		if (!this.#open) {
			if (event.type === "click" && event.button === "left") {
				this.openPanel();
				return { handled: true };
			}
			return { handled: true };
		}
		if (event.type === "wheel") {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		const index = this.#rows.get(event.y);
		const form = this.#form();
		if (event.type === "click" && event.button === "left" && index !== undefined && form) {
			form.state.cursor = index;
			form.state.zone = "list";
			const option = form.record.options[index];
			if (option) form.state.draft = toggleDraftOption(form.record, form.state.draft, option.id);
			this.#syncFocus();
			this.#opts.changed();
		}
		return { handled: true };
	}

	invalidate(): void {}

	render(width: number): string[] {
		const entries = this.#entries();
		this.#rows.clear();
		if (!this.#supported || entries.length === 0) return [];
		if (!this.#open) return [this.#bar(entries.length - (this.#tomb ? 1 : 0), width)];
		return this.#panel(entries, width).map((line) => truncateToWidth(line, width));
	}

	#bar(count: number, width: number): string {
		const n = Math.max(1, count);
		const candidates = [
			t("question.bar.long", { count: n }),
			t("question.bar.medium", { count: n }),
			t("question.bar.short", { count: n }),
			t("question.bar.min"),
		];
		const text = candidates.find((candidate) => visibleWidth(candidate) <= width - 1) ?? candidates.at(-1) ?? "";
		return theme.warning(truncateToWidth(` ${text}`, width));
	}

	#panel(entries: Entry[], width: number): string[] {
		const entry = this.#shown ?? entries[0];
		if (!entry) return [];
		const total = Math.max(1, Math.floor(this.height));
		if (total < QUESTION_MIN_ROWS)
			return [theme.warning(` ${t("question.tooSmall", { hint: shortcutHints(["Esc", t("action.close")]) })}`)];
		const mode = this.#mode(entry);
		const form = mode.kind === "form" ? mode : undefined;
		if (form) this.#refreshInput(form.record, form.state);
		const busy = this.#busy.has(entry.key);
		const note = this.#notes.get(entry.key);
		const aside = this.#opts.aside?.();
		const statusText = busy
			? theme.dim(t("common.submitting"))
			: note
				? (note.tone === "error" ? theme.error : theme.warning)(plainLine(localizeError(note.text), 400))
				: form && !this.#online
					? theme.warning(t("question.offline"))
					: aside !== undefined
						? theme.warning(plainLine(aside, 400))
						: undefined;

		const bodyWidth = Math.max(1, width - 3);
		const source = form ? form.record.question : (this.#records.get(entry.key)?.question ?? entry.preview);
		const bodyLines = plainText(source)
			.split("\n")
			.flatMap((line) => wrapTextWithAnsi(line, bodyWidth));
		const listWanted = form ? form.record.options.length + 1 : 0;
		const infoLines = mode.kind === "info" ? wrapTextWithAnsi(plainText(mode.text), Math.max(1, width - 2)) : [];
		const fixed = 2 + (form ? 1 : 0) + (statusText !== undefined ? 1 : 0);
		const avail = Math.max(2, total - fixed);
		const side = form ? listWanted : Math.min(infoLines.length, Math.max(1, avail - 1));
		const share = Math.min(bodyLines.length, Math.max(1, Math.ceil(avail / 2)));
		let listRows = side === 0 ? 0 : Math.min(side, Math.max(1, avail - share));
		const bodyRows = Math.max(1, Math.min(bodyLines.length, avail - listRows));
		if (bodyRows + listRows > avail) listRows = Math.max(side === 0 ? 0 : 1, avail - bodyRows);
		const spare = avail - bodyRows - listRows;

		const maxScroll = Math.max(0, bodyLines.length - bodyRows);
		const scroll = Math.min(this.#scrolls.get(entry.key) ?? 0, maxScroll);
		this.#scrolls.set(entry.key, scroll);
		this.#bodyPage = Math.max(1, bodyRows - 1);

		const kind = form
			? form.record.options.length === 0
				? t("question.kindText")
				: form.record.multiple
					? t("question.kindMultiple")
					: t("question.kindSingle")
			: "";
		const position =
			entries.length > 1 ? ` ${entries.findIndex((e) => e.key === entry.key) + 1}/${entries.length}` : "";
		const range = `${scroll + 1}-${scroll + bodyRows}/${bodyLines.length}`;
		const title = theme.warning(style.bold(t("question.title", { position })));
		// Long headers give up detail before the position of a scrolled question.
		const headers = [
			[kind, maxScroll > 0 ? t("question.lines", { range }) : ""],
			[kind, maxScroll > 0 ? range : ""],
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
		for (const line of bodyLines.slice(scroll, scroll + bodyRows)) rows.push(`${theme.dim("│ ")}${line}`);

		if (form) {
			const { record, state } = form;
			const start = Math.max(0, Math.min(state.cursor - Math.floor(listRows / 2), listWanted - listRows));
			for (let index = start; index < start + listRows; index++) {
				this.#rows.set(rows.length, index);
				rows.push(this.#listRow(record, state, index, width));
			}
			const option = record.options[state.cursor];
			if (option?.description && spare > 0) {
				const wrapped = wrapTextWithAnsi(plainText(option.description), Math.max(1, width - 4));
				const shown = wrapped.slice(0, Math.min(2, spare));
				if (wrapped.length > shown.length && shown.length > 0)
					shown[shown.length - 1] = `${truncateToWidth(shown[shown.length - 1] ?? "", Math.max(1, width - 5))}…`;
				for (const line of shown) rows.push(theme.dim(`    ${line}`));
			}
			const marker = state.zone === "text" && !busy ? theme.accent("▸ ") : "  ";
			rows.push(marker + (state.input.render(Math.max(1, width - 2))[0] ?? ""));
		} else {
			const tone =
				mode.kind === "info"
					? { ok: theme.ok, warn: theme.warning, dim: theme.dim, error: theme.error }[mode.tone]
					: theme.dim;
			for (const line of infoLines.slice(0, listRows)) rows.push(tone(` ${line}`));
		}
		if (statusText !== undefined) rows.push(` ${statusText}`);
		rows.push(this.#hints(entries.length, mode, maxScroll > 0, width));
		return rows;
	}

	#listRow(record: WireQuestionRecord, state: State, index: number, width: number): string {
		const atCursor = index === state.cursor;
		const marker = atCursor ? (state.zone === "list" ? "❯" : "›") : " ";
		const option = record.options[index];
		if (!option) {
			const row = `${marker} ↷ ${skipLabel()}`;
			return atCursor && state.zone === "list" ? theme.selection(row) : theme.muted(row);
		}
		const chosen = state.draft.optionIds.includes(option.id);
		const mark = record.multiple ? (chosen ? "[x]" : "[ ]") : chosen ? "(●)" : "( )";
		const number = index < 9 ? `${index + 1}.` : "  ";
		const badge = option.recommended ? t("question.recommended") : "";
		const row = truncateToWidth(`${marker} ${mark} ${number} ${badge}${plainLine(option.label, 200)}`, width, "…");
		if (atCursor && state.zone === "list") return theme.selection(row);
		return chosen ? theme.accent(row) : row;
	}

	#hints(count: number, mode: Mode, scrollable: boolean, width: number): string {
		type Hint = readonly [string, string];
		const close: Hint = ["Esc", t("action.close")];
		const switchHint: Hint[] = count > 1 ? [["[ ]", t("action.switch")]] : [];
		const scrollHint: Hint[] = scrollable ? [["PgUp/PgDn", t("action.scroll")]] : [];
		let candidates: Hint[][];
		if (mode.kind === "form") {
			const state = this.#shown && this.#states.get(this.#shown.key);
			const noOptions = mode.record.options.length === 0;
			const onSkip = state?.cursor === mode.record.options.length;
			const enter: Hint = ["Enter", state?.zone === "list" && onSkip ? t("action.skip") : t("action.submit")];
			const pick: Hint = ["Space", mode.record.multiple ? t("action.toggle") : t("action.select")];
			const toList: Hint = ["Tab", noOptions ? t("action.skipRow") : t("action.options")];
			const toAnswer: Hint = ["Tab", t("action.answer")];
			const toNote: Hint = ["Tab", t("action.note")];
			candidates =
				state?.zone === "text"
					? [
							[toList, enter, ...scrollHint, close],
							[toList, enter, close],
							[enter, close],
						]
					: noOptions
						? [[toAnswer, enter, ...switchHint, ...scrollHint, close], [toAnswer, enter, close], [close]]
						: [
								[["↑↓", t("action.move")], pick, toNote, enter, ...switchHint, ...scrollHint, close],
								[pick, toNote, enter, ...scrollHint, close],
								[pick, toNote, enter, close],
								[enter, close],
							];
		} else {
			candidates = [
				[...(mode.retry ? ([["Enter", t("action.retry")]] as const) : []), ...switchHint, ...scrollHint, close],
				[close],
			];
		}
		const lines = candidates.map((parts) => ` ${shortcutHints(...parts)}`);
		return lines.find((line) => visibleWidth(line) <= width) ?? truncateToWidth(lines.at(-1) ?? "", width);
	}
}
