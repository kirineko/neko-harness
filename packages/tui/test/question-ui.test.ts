import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import {
	Container,
	CURSOR_MARKER,
	ScrollView,
	stripTerminalSequences,
	type Terminal,
	Text,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { validateQuestionResponse } from "@neko-harness/core/interactions";
import type { QuestionsClient } from "@neko-harness/gateway/client-session";
import type {
	WireQuestionList,
	WireQuestionRecord,
	WireQuestionResponse,
	WireQuestionSummary,
	WireQueuedInput,
} from "@neko-harness/gateway/contract";
import { BoundedEditor } from "../src/components/editor.ts";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { ToolExecutionComponent } from "../src/components/tool-execution.ts";
import { helpLines } from "../src/help-ui.ts";
import { createInputRouter, type InputHost } from "../src/input-router.ts";
import { commands } from "../src/labels.ts";
import { createAppLayout } from "../src/layout.ts";
import { plainLine, plainText } from "../src/plain-text.ts";
import { canAutoOpen, QUESTION_MAX_ROWS, QuestionDock } from "../src/question-dock.ts";
import { QueueRow, queueKeyAction } from "../src/queue-ui.ts";
import { getEditorTheme, setActiveTheme } from "../src/theme/index.ts";
import { sessionPickerItems } from "../src/workspace.ts";

setActiveTheme("light");

const ESC = "\x1b";
const ESC_REPEAT = "\x1b[27;1:2u";
const ENTER = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const END = "\x1b[F";
const SPACE = " ";
const CTRL_O = "\x0f";
const CTRL_C = "\x03";
const ALT_UP = "\x1b[1;3A";

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");
const tick = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const record = (id: number, extra: Partial<WireQuestionRecord> = {}): WireQuestionRecord => ({
	id,
	callId: `call-${id}`,
	version: `v${id}`,
	question: `Question ${id}: which database should we use?`,
	multiple: false,
	options: [
		{ id: "mysql", label: "MySQL" },
		{ id: "pg", label: "Postgres", recommended: true },
		{ id: "sqlite", label: "SQLite", description: "Embedded, zero configuration" },
	],
	status: "pending",
	answer: null,
	createdAt: 1000 + id,
	settledAt: null,
	...extra,
});
const summary = (r: WireQuestionRecord): WireQuestionSummary => ({
	id: r.id,
	version: r.version,
	preview: r.question.slice(0, 256),
	multiple: r.multiple,
	optionCount: r.options.length,
	createdAt: r.createdAt,
});
const list = (...records: WireQuestionRecord[]): WireQuestionList => ({ revision: 1, pending: records.map(summary) });

type Fake = {
	client: QuestionsClient;
	records: Map<number, WireQuestionRecord>;
	gets: number[];
	responds: Array<{ id: number; version: string; response: WireQuestionResponse }>;
	respond: ((input: Fake["responds"][number]) => Promise<WireQuestionRecord>) | undefined;
};
/** The first valid decision wins: a later respond returns the saved record unchanged. */
function fake(...records: WireQuestionRecord[]): Fake {
	const state: Fake = {
		records: new Map(records.map((r) => [r.id, r])),
		gets: [],
		responds: [],
		respond: undefined,
		client: {
			supported: true,
			revision: 1,
			pending: () => [],
			get: async (id) => {
				state.gets.push(id);
				return state.records.get(id) ?? null;
			},
			respond: async (input) => {
				state.responds.push(input);
				if (state.respond) return state.respond(input);
				const current = state.records.get(input.id)!;
				if (current.status !== "pending") return current;
				const normalized = validateQuestionResponse(current, input.response);
				const saved: WireQuestionRecord =
					normalized.kind === "skip"
						? { ...current, status: "skipped", settledAt: 2000 }
						: {
								...current,
								status: "answered",
								answer: { optionIds: normalized.optionIds, text: normalized.text },
								settledAt: 2000,
							};
				state.records.set(input.id, saved);
				return saved;
			},
		},
	};
	return state;
}

function setup(...records: WireQuestionRecord[]) {
	const f = fake(...records);
	const events = {
		renders: 0,
		notices: [] as Array<[string, string]>,
		opened: [] as boolean[],
		aside: undefined as string | undefined,
		now: 1000,
	};
	const dock = new QuestionDock({
		changed: () => {
			events.renders++;
		},
		notify: (message, level) => events.notices.push([message, level]),
		opened: (open) => events.opened.push(open),
		aside: () => events.aside,
		now: () => events.now,
	});
	dock.height = QUESTION_MAX_ROWS;
	dock.bind("s1", f.client);
	return { dock, f, events };
}
const view = (dock: QuestionDock, width = 80) => plain(dock.render(width));
const open = async (dock: QuestionDock, ...records: WireQuestionRecord[]) => {
	dock.update(list(...records));
	expect(dock.openPanel()).toBe(true);
	await tick();
};

it("starts the cursor on the recommended option without selecting anything, and Enter with no choice sends nothing", async () => {
	const q = record(1);
	const { dock, f, events } = setup(q);
	await open(dock, q);
	const first = view(dock);
	expect(first).toContain("Assistant question");
	expect(first).toContain("Single choice");
	expect(first).toContain("Question 1: which database");
	expect(first).toContain("❯ ( ) 2. [Recommended] Postgres");
	expect(first).not.toContain("(●)");
	expect(first).toContain("Skip this question");
	expect(first).not.toContain("Allow once");
	expect(first).not.toContain("Deny");
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([]);
	expect(view(dock)).toContain("Choose an option");
	expect(dock.open).toBe(true);
	dock.handleInput(SPACE);
	expect(view(dock)).toContain("❯ (●) 2. [Recommended] Postgres");
	expect(f.responds).toEqual([]);
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([{ id: 1, version: "v1", response: { kind: "answer", optionIds: ["pg"] } }]);
	expect(dock.open).toBe(false);
	expect(events.notices).toEqual([["Answered: Postgres", "info"]]);
});

it("moves with arrows and digits, selects with Space, switches to the note with Tab and submits with Enter", async () => {
	const q = record(1);
	const { dock, f } = setup(q);
	await open(dock, q);
	dock.handleInput(UP);
	expect(view(dock)).toContain("❯ ( ) 1. MySQL");
	dock.handleInput(DOWN);
	expect(view(dock)).toContain("❯ ( ) 2. [Recommended] Postgres");
	dock.handleInput(UP);
	dock.handleInput(UP);
	expect(view(dock)).toContain("❯ ( ) 1. MySQL");
	dock.handleInput("3");
	expect(view(dock)).toContain("❯ ( ) 3. SQLite");
	expect(view(dock)).toContain("Embedded, zero configuration");
	dock.handleInput("9");
	expect(view(dock)).toContain("❯ ( ) 3. SQLite");
	dock.handleInput(SPACE);
	dock.handleInput("1");
	dock.handleInput(SPACE);
	const swapped = view(dock);
	expect(swapped).toContain("❯ (●) 1. MySQL");
	expect(swapped).toContain("( ) 3. SQLite");
	dock.handleInput(TAB);
	dock.handleInput("w");
	dock.handleInput("3");
	dock.handleInput("]");
	dock.handleInput(SPACE);
	dock.handleInput("x");
	const typing = view(dock);
	expect(typing).toContain("✎ w3] x");
	expect(typing).toContain("▸");
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([
		{ id: 1, version: "v1", response: { kind: "answer", optionIds: ["mysql"], text: "w3] x" } },
	]);
});

it("toggles several options in a multiple-choice question and reports options in the question's order", async () => {
	const q = record(1, { multiple: true });
	const { dock, f, events } = setup(q);
	await open(dock, q);
	expect(view(dock)).toContain("Multiple choice");
	dock.handleInput("3");
	dock.handleInput(SPACE);
	dock.handleInput("1");
	dock.handleInput(SPACE);
	const text = view(dock);
	expect(text).toContain("[x] 1. MySQL");
	expect(text).toContain("[x] 3. SQLite");
	expect(text).toContain("[ ] 2. [Recommended] Postgres");
	dock.handleInput(SPACE);
	expect(view(dock)).toContain("[ ] 1. MySQL");
	dock.handleInput(SPACE);
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds[0]?.response).toEqual({ kind: "answer", optionIds: ["sqlite", "mysql"] });
	expect(events.notices).toEqual([["Answered: MySQL, SQLite", "info"]]);
});

it("answers a question without options only with text, never with blank text, and skip is its own row", async () => {
	const q = record(1, { options: [], question: "What should the project be called?" });
	const { dock, f } = setup(q);
	await open(dock, q);
	expect(view(dock)).toContain("Text answer");
	expect(view(dock)).toContain("✎");
	dock.handleInput(ENTER);
	dock.handleInput(SPACE);
	dock.handleInput(SPACE);
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([]);
	expect(view(dock)).toContain("Type your answer, then press Enter.");
	dock.handleInput("n");
	dock.handleInput("e");
	dock.handleInput("k");
	dock.handleInput("o");
	dock.handleInput(ENTER);
	await tick();
	// The text is sent as typed; only the blank check ignores whitespace.
	expect(f.responds[0]?.response).toEqual({ kind: "answer", text: "  neko" });
});

it("skips only from the dedicated last row, and closing never skips", async () => {
	const q = record(1);
	const { dock, f, events } = setup(q);
	await open(dock, q);
	dock.handleInput(SPACE);
	dock.handleInput(ESC);
	expect(dock.open).toBe(false);
	expect(f.responds).toEqual([]);
	expect(dock.openPanel()).toBe(true);
	dock.handleInput(END);
	expect(view(dock)).toContain("❯ ↷ Skip this question");
	expect(view(dock)).toContain("Enter Skip");
	dock.handleInput(SPACE);
	expect(f.responds).toEqual([]);
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([{ id: 1, version: "v1", response: { kind: "skip" } }]);
	expect(events.notices).toEqual([["Skipped", "info"]]);
	expect(dock.open).toBe(false);
});

it("scrolls a long question with PgUp/PgDn inside the row budget and reports the position", async () => {
	const question = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
	const q = record(1, { question });
	const { dock } = setup(q);
	dock.height = 10;
	await open(dock, q);
	const top = dock.render(60);
	expect(top.length).toBeLessThanOrEqual(10);
	expect(plain(top)).toContain("line 1\n");
	expect(plain(top)).toContain("lines 1-");
	expect(plain(top)).not.toContain("line 40");
	for (let i = 0; i < 30; i++) dock.handleInput(PGDN);
	const bottom = view(dock, 60);
	expect(bottom).toContain("line 40");
	expect(bottom).not.toContain("line 1\n");
	expect(bottom).toContain("/40");
	for (let i = 0; i < 30; i++) dock.handleInput(PGUP);
	expect(view(dock, 60)).toContain("line 1\n");
	dock.scroll(3);
	expect(view(dock, 60)).not.toContain("line 1\n");
});

it("switches between several waiting questions with [ and ], wrapping around", async () => {
	const a = record(1, { question: "First question?" });
	const b = record(2, { question: "Second question?" });
	const c = record(3, { question: "Third question?" });
	const { dock } = setup(a, b, c);
	await open(dock, a, b, c);
	expect(view(dock)).toContain("Assistant question 1/3");
	expect(view(dock)).toContain("First question?");
	dock.handleInput("]");
	await tick();
	expect(view(dock)).toContain("Assistant question 2/3");
	expect(view(dock)).toContain("Second question?");
	dock.handleInput("]");
	dock.handleInput("]");
	await tick();
	expect(view(dock)).toContain("First question?");
	dock.handleInput("[");
	await tick();
	expect(view(dock)).toContain("Third question?");
	expect(dock.pendingCount).toBe(3);
});

it("keeps answer drafts per session, question and version, across closing and reopening", async () => {
	const q = record(1);
	const { dock, f } = setup(q);
	await open(dock, q);
	dock.handleInput(SPACE);
	dock.handleInput(TAB);
	dock.handleInput("n");
	dock.handleInput("o");
	dock.handleInput("t");
	dock.handleInput("e");
	dock.handleInput(ESC);
	expect(dock.open).toBe(false);
	expect(dock.openPanel()).toBe(true);
	const again = view(dock);
	expect(again).toContain("(●) 2. [Recommended] Postgres");
	expect(again).toContain("✎ note");

	dock.bind("s2", f.client);
	dock.update(list(q));
	expect(dock.openPanel()).toBe(true);
	await tick();
	const other = view(dock);
	expect(other).not.toContain("(●)");
	expect(other).not.toContain("note");
	dock.closePanel();

	const newer = record(1, { version: "v1b" });
	f.records.set(1, newer);
	dock.bind("s1", f.client);
	dock.update(list(newer));
	dock.openPanel();
	await tick();
	expect(view(dock)).not.toContain("(●)");
	dock.closePanel();

	dock.update(list(q));
	dock.openPanel();
	await tick();
	const kept = view(dock);
	expect(kept).toContain("(●) 2. [Recommended] Postgres");
	expect(kept).toContain("✎ note");
});

it("opens by itself once, only when nothing else holds the focus, and never again after being closed", async () => {
	const q = record(1);
	const { dock, events } = setup(q);
	dock.update(list(q));
	expect(dock.autoOpen(false)).toBe(false);
	expect(dock.open).toBe(false);
	expect(events.opened).toEqual([]);
	expect(view(dock)).toContain("Awaiting answer");
	expect(dock.autoOpen(true)).toBe(false);
	expect(dock.open).toBe(false);

	const next = record(2);
	dock.update(list(q, next));
	expect(dock.autoOpen(true)).toBe(true);
	expect(dock.open).toBe(true);
	expect(events.opened).toEqual([true]);
	await tick();
	expect(view(dock)).toContain("Assistant question 2/2");
	dock.handleInput(ESC);
	expect(events.opened).toEqual([true, false]);
	dock.update(list(q, next));
	expect(dock.autoOpen(true)).toBe(false);
	expect(dock.open).toBe(false);

	const third = record(3);
	dock.update(list(q, next, third));
	expect(dock.autoOpen(true)).toBe(true);
	expect(view(dock)).toContain("Assistant question 3/3");
	expect(dock.pendingCount).toBe(3);
});

it("opens itself only when the editor is empty and no picker, approval, queue selection or completion is active", () => {
	const idle = {
		online: true,
		usable: true,
		editorText: "",
		autocomplete: false,
		overlayOpen: false,
		approvalFocused: false,
		sessionOperation: false,
		queueSelecting: false,
	};
	expect(canAutoOpen(idle)).toBe(true);
	for (const blocked of [
		{ online: false },
		{ usable: false },
		{ editorText: "half-written message" },
		{ editorText: " " },
		{ autocomplete: true },
		{ overlayOpen: true },
		{ approvalFocused: true },
		{ sessionOperation: true },
		{ queueSelecting: true },
	])
		expect(canAutoOpen({ ...idle, ...blocked })).toBe(false);
});

it("does not open on a short terminal or when the gateway has no questions", async () => {
	const q = record(1);
	const { dock } = setup(q);
	dock.height = 4;
	dock.update(list(q));
	expect(dock.autoOpen(true)).toBe(false);
	expect(dock.open).toBe(false);

	const old = setup();
	old.dock.update(undefined);
	expect(old.dock.supported).toBe(false);
	expect(old.dock.visible).toBe(false);
	expect(old.dock.render(80)).toEqual([]);
	expect(old.dock.openPanel()).toBe(false);
	expect(old.dock.autoOpen(true)).toBe(false);
	old.dock.update({ revision: 1, pending: [] });
	expect(old.dock.supported).toBe(true);
	expect(old.dock.visible).toBe(false);
});

it("shows a one-line prompt bar that fits every width while the panel is closed", () => {
	const q = record(1);
	const { dock } = setup(q);
	dock.update(list(q));
	for (const width of [30, 40, 60, 100, 160]) {
		const rows = dock.render(width);
		expect(rows).toHaveLength(1);
		expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
		expect(plain(rows)).toContain("Awaiting answer");
	}
	expect(view(dock, 160)).toContain("The assistant is waiting for your answer");
	expect(view(dock, 160)).toContain("/question");
	expect(view(dock, 160)).toContain("queue until after the answer");
	expect(view(dock, 160)).toContain("Ctrl+O");
});

// —— 焦点路由：问题面板 / 审批 / 队列 / 聊天输入 ——

const queued = (id: number, preview: string): WireQueuedInput => ({ id, mode: "followUp", preview, images: 0 });

function routing(options: {
	busy?: boolean;
	approval?: boolean;
	queue?: WireQueuedInput[];
	records?: WireQuestionRecord[];
}) {
	const records = options.records ?? [record(1)];
	const { dock, f, events } = setup(...records);
	dock.update(list(...records));
	const editor = new BoundedEditor(new TuiAltScreen({ columns: 80, rows: 24 } as Terminal), getEditorTheme(), {
		paddingX: 1,
	});
	editor.focused = true;
	editor.setText("draft in progress");
	const queue = new QueueRow();
	queue.setItems(options.queue ?? []);
	const approval = {
		focused: options.approval ?? false,
		keys: [] as string[],
		handleInput(data: string) {
			if (!this.focused || data === CTRL_C) return false;
			this.keys.push(data);
			return true;
		},
	};
	const log = { aborts: 0, exits: 0, queueActs: [] as string[], sessions: 0 };
	const state = { busy: options.busy ?? true };
	const host: InputHost = {
		size: () => ({ columns: 80, rows: 24 }),
		editor,
		approval,
		question: dock,
		overlayOpen: () => false,
		busy: () => state.busy,
		compactionActive: () => false,
		compactionStoppable: () => false,
		sessionOperation: () => false,
		queueKey: (data) => {
			const action = queueKeyAction(queue, data, editor.isShowingAutocomplete());
			if (action === undefined) return undefined;
			log.queueActs.push(action);
			if (action === "select") queue.select();
			else if (action === "up") queue.move(-1);
			else if (action === "down") queue.move(1);
			else if (action === "leave") {
				queue.clear();
				return undefined;
			}
			return { consume: true };
		},
		hasSubagents: () => false,
		showAgents: () => {},
		toggleQuestion: () => {
			dock.toggle();
			queue.clear();
		},
		clipboardKey: () => false,
		pasteImages: () => false,
		openSessions: () => {
			log.sessions++;
		},
		abort: () => {
			log.aborts++;
		},
		exit: () => {
			log.exits++;
		},
	};
	const route = createInputRouter(host);
	/** Like the TUI: a key nobody consumed goes to the focused editor. */
	const press = (data: string) => {
		const result = route(data);
		if (result === undefined) editor.handleInput(data);
		return result;
	};
	return { dock, f, events, editor, queue, approval, log, state, press };
}

it("Esc in the open panel only closes it: consumed, the run is not stopped, drafts stay; a later Esc stops as before", async () => {
	const h = routing({});
	expect(h.press(CTRL_O)).toEqual({ consume: true });
	await tick();
	expect(h.dock.open).toBe(true);
	h.press(SPACE);
	expect(h.press(ESC)).toEqual({ consume: true });
	expect(h.dock.open).toBe(false);
	expect(h.log.aborts).toBe(0);
	expect(h.f.responds).toEqual([]);
	expect(h.editor.getText()).toBe("draft in progress");

	h.events.now += 100;
	expect(h.press(ESC_REPEAT)).toEqual({ consume: true });
	expect(h.log.aborts).toBe(0);
	h.events.now += 1000;
	expect(h.press(ESC)).toEqual({ consume: true });
	expect(h.log.aborts).toBe(1);

	h.press(CTRL_O);
	expect(view(h.dock)).toContain("(●) 2. [Recommended] Postgres");
});

it("keeps Ctrl+C's global meaning inside the panel: stop while running, exit when idle", async () => {
	const h = routing({ busy: true });
	h.press(CTRL_O);
	await tick();
	expect(h.press(CTRL_C)).toEqual({ consume: true });
	expect(h.log.aborts).toBe(1);
	expect(h.log.exits).toBe(0);
	expect(h.dock.open).toBe(true);
	h.state.busy = false;
	h.press(CTRL_C);
	expect(h.log.exits).toBe(1);
	expect(h.f.responds).toEqual([]);
});

it("keeps the chat draft apart from the answer: typing in the panel never reaches the editor", async () => {
	const h = routing({});
	h.press(CTRL_O);
	await tick();
	h.press(TAB);
	for (const key of "my answer") h.press(key);
	expect(h.editor.getText()).toBe("draft in progress");
	expect(h.press(ESC)).toEqual({ consume: true });
	expect(h.editor.getText()).toBe("draft in progress");
	h.events.now += 1000;
	h.press("!");
	expect(h.editor.getText()).toBe("draft in progress!");
	h.press(CTRL_O);
	expect(view(h.dock)).toContain("✎ my answer");
});

it("gives each key to one owner: question panel > approval > queue > editor", async () => {
	const h = routing({ approval: true, queue: [queued(1, "first"), queued(2, "second")] });
	// Closed question, waiting approval: the approval keeps Enter and Esc.
	expect(h.press(ENTER)).toEqual({ consume: true });
	expect(h.approval.keys).toEqual([ENTER]);
	expect(h.dock.open).toBe(false);
	expect(h.f.responds).toEqual([]);
	// Ctrl+O is the explicit switch to the question.
	expect(h.press(CTRL_O)).toEqual({ consume: true });
	await tick();
	expect(h.dock.open).toBe(true);
	expect(h.approval.keys).toEqual([ENTER]);
	// While it is open, nothing reaches the approval, the queue or the editor.
	h.press(SPACE);
	h.press(ENTER);
	await tick();
	expect(h.f.responds).toHaveLength(1);
	expect(h.approval.keys).toEqual([ENTER]);
	expect(h.log.queueActs).toEqual([]);
	expect(h.editor.getText()).toBe("draft in progress");
	expect(h.dock.open).toBe(false);
	expect(h.log.aborts).toBe(0);
	// With the panel gone, the approval owns the next Enter again.
	h.events.now += 1000;
	h.press(ENTER);
	expect(h.approval.keys).toEqual([ENTER, ENTER]);
});

it("keeps Alt+Up queue selection working and unaffected while the question panel is open or closed", async () => {
	const h = routing({ approval: false, queue: [queued(1, "first"), queued(2, "second")] });
	expect(h.press(ALT_UP)).toEqual({ consume: true });
	expect(h.queue.selecting).toBe(true);
	expect(h.log.queueActs).toEqual(["select"]);
	// Opening the question clears the selection, so a later Enter cannot steer a queued message.
	h.press(CTRL_O);
	await tick();
	expect(h.queue.selecting).toBe(false);
	h.press(ALT_UP);
	h.press(UP);
	h.press(ESC);
	expect(h.log.queueActs).toEqual(["select"]);
	expect(h.queue.selecting).toBe(false);
	expect(h.dock.open).toBe(false);
	expect(h.log.aborts).toBe(0);
	// Closed again: Alt+Up selects, and Esc only withdraws; the run keeps going.
	h.events.now += 1000;
	h.press(ALT_UP);
	expect(h.queue.selecting).toBe(true);
	h.press(ESC);
	expect(h.log.queueActs).toEqual(["select", "select", "withdraw"]);
	expect(h.log.aborts).toBe(0);
});

it("lets an approval that arrives mid-answer wait: the answer's Enter never approves a command", async () => {
	const h = routing({});
	h.press(CTRL_O);
	await tick();
	h.approval.focused = true;
	h.press(SPACE);
	h.press(ENTER);
	await tick();
	expect(h.f.responds).toHaveLength(1);
	expect(h.approval.keys).toEqual([]);
});

it("hands the keys to the approval once the question panel closes, and says so in the panel", async () => {
	const h = routing({ approval: true });
	h.press(CTRL_O);
	await tick();
	h.events.aside = "Approval waiting: Esc closes this panel to review it.";
	expect(view(h.dock)).toContain("Approval waiting");
	h.press(ESC);
	expect(h.dock.open).toBe(false);
	expect(h.approval.keys).toEqual([]);
	h.events.now += 1000;
	h.press("a");
	expect(h.approval.keys).toEqual(["a"]);
});

// —— 提交失败、重复提交、断线 ——

it("ignores repeated Enter while submitting and shows Submitting…", async () => {
	const q = record(1);
	const { dock, f } = setup(q);
	await open(dock, q);
	let release: (r: WireQuestionRecord) => void = () => {};
	f.respond = () =>
		new Promise<WireQuestionRecord>((resolve) => {
			release = resolve;
		});
	dock.handleInput(SPACE);
	dock.handleInput(ENTER);
	await tick();
	expect(view(dock)).toContain("Submitting…");
	dock.handleInput(ENTER);
	dock.handleInput(ENTER);
	dock.handleInput(SPACE);
	await tick();
	expect(f.responds).toHaveLength(1);
	release({ ...q, status: "answered", answer: { optionIds: ["pg"], text: null }, settledAt: 5 });
	await tick();
	expect(dock.open).toBe(false);
});

it("keeps the draft and shows the error when submitting fails, and resends only on an explicit Enter", async () => {
	const q = record(1);
	const { dock, f, events } = setup(q);
	await open(dock, q);
	f.respond = async () => {
		throw new Error("gateway exploded");
	};
	dock.handleInput(SPACE);
	dock.handleInput(TAB);
	dock.handleInput("o");
	dock.handleInput("k");
	dock.handleInput(ENTER);
	await tick();
	const failed = view(dock);
	expect(failed).toContain("gateway exploded");
	expect(failed).toContain("(●) 2. [Recommended] Postgres");
	expect(failed).toContain("✎ ok");
	expect(dock.open).toBe(true);
	expect(events.notices).toEqual([]);
	await tick();
	expect(f.responds).toHaveLength(1);
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toHaveLength(2);
	expect(f.responds[1]?.response).toEqual({ kind: "answer", optionIds: ["pg"], text: "ok" });
});

it("disables submit when the gateway is gone and never sends after it comes back", async () => {
	const q = record(1);
	const { dock, f } = setup(q);
	await open(dock, q);
	dock.handleInput(SPACE);
	dock.setOnline(false);
	expect(view(dock)).toContain("Offline");
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([]);
	expect(view(dock)).toContain("Gateway unavailable");
	dock.setOnline(true);
	await tick();
	expect(f.responds).toEqual([]);
	expect(view(dock)).toContain("(●) 2. [Recommended] Postgres");
});

// —— 其他端结算与停止 ——

it("shows the real result and disables the controls when another client settled the question", async () => {
	const q = record(1);
	const { dock, f } = setup(q);
	await open(dock, q);
	dock.handleInput(SPACE);
	f.records.set(1, { ...q, status: "answered", answer: { optionIds: ["sqlite"], text: "pinned" }, settledAt: 3 });
	dock.update({ revision: 2, pending: [] });
	await tick();
	expect(dock.open).toBe(true);
	const settled = view(dock);
	expect(settled).toContain("Already answered: SQLite, pinned");
	expect(settled).not.toContain("(●)");
	expect(settled).not.toContain("Submit");
	dock.handleInput(ENTER);
	dock.handleInput(SPACE);
	await tick();
	expect(f.responds).toEqual([]);
	dock.handleInput(ESC);
	expect(dock.open).toBe(false);
	expect(dock.visible).toBe(false);
	expect(dock.render(80)).toEqual([]);
});

it("reports a stopped run as cancelled and a skip elsewhere as skipped", async () => {
	const q = record(1);
	const stopped = setup(q);
	await open(stopped.dock, q);
	stopped.f.records.set(1, { ...q, status: "cancelled", settledAt: 3 });
	stopped.dock.update({ revision: 2, pending: [] });
	await tick();
	expect(view(stopped.dock)).toContain("Cancelled");
	expect(view(stopped.dock)).toContain("Esc Close");

	const skipped = setup(q);
	await open(skipped.dock, q);
	skipped.f.records.set(1, { ...q, status: "skipped", settledAt: 3 });
	skipped.dock.update({ revision: 2, pending: [] });
	await tick();
	expect(view(skipped.dock)).toContain("Already skipped");
});

it("shows the actual winner when our answer lost the race, and never claims it as ours", async () => {
	const q = record(1);
	const { dock, f, events } = setup(q);
	await open(dock, q);
	f.respond = async () => ({
		...q,
		status: "answered",
		answer: { optionIds: ["sqlite"], text: null },
		settledAt: 4,
	});
	dock.handleInput(SPACE);
	dock.handleInput(ENTER);
	await tick();
	const text = view(dock);
	expect(text).toContain("Already answered: SQLite");
	expect(text).not.toContain("Answered: Postgres");
	expect(dock.open).toBe(true);
	expect(events.notices).toEqual([]);
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toHaveLength(1);

	const skipped = setup(q);
	await open(skipped.dock, q);
	skipped.f.respond = async () => ({ ...q, status: "skipped", settledAt: 4 });
	skipped.dock.handleInput(SPACE);
	skipped.dock.handleInput(ENTER);
	await tick();
	expect(view(skipped.dock)).toContain("Already skipped");
});

it("reports a question that settled while the panel was closed without opening anything", async () => {
	const q = record(1);
	const { dock, f } = setup(q);
	dock.update(list(q));
	await tick();
	expect(dock.visible).toBe(true);
	f.records.set(1, { ...q, status: "cancelled", settledAt: 3 });
	dock.update({ revision: 2, pending: [] });
	expect(dock.visible).toBe(false);
	expect(dock.open).toBe(false);
	expect(dock.render(80)).toEqual([]);
});

it("shows the loading state and a retry when the full question cannot be read", async () => {
	const q = record(1);
	const { dock, f } = setup(q);
	let fail = true;
	const get = f.client.get;
	f.client.get = async (id) => {
		if (fail) throw new Error("not reachable");
		return get(id);
	};
	dock.update(list(q));
	expect(dock.openPanel()).toBe(true);
	expect(view(dock)).toContain("Loading the full question");
	expect(view(dock)).toContain("Question 1: which database");
	await tick();
	const failed = view(dock);
	expect(failed).toContain("Could not load the question: not reachable");
	expect(failed).toContain("Enter Retry");
	dock.handleInput(SPACE);
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([]);
	fail = false;
	dock.handleInput(ENTER);
	await tick();
	expect(view(dock)).toContain("Postgres");
});

// —— 显示：纯文本、窄终端、长题、页脚、会话选择器 ——

it("shows question and option text as plain text without terminal control or markup", async () => {
	const q = record(1, {
		question:
			"Run \x1b[31mred\x1b[0m \x1b]8;;http://evil.example\x07link\x1b]8;;\x07 \u202edrowssap\u202c **bold** <b>tag</b>\tend",
		options: [
			{ id: "a", label: "Opt\x1b[2J \u200bion A", description: "[click](http://evil.example) \x1b[1mhard\x1b[0m" },
		],
	});
	const { dock } = setup(q);
	await open(dock, q);
	dock.handleInput(SPACE);
	const raw = dock.render(80).join("");
	expect(raw).not.toContain("\x1b[2J");
	expect(raw).not.toContain("\x1b]8");
	expect(raw).not.toContain("evil.example\x07");
	const text = stripTerminalSequences(raw);
	expect(text).toContain("Run red link");
	expect(text).toContain("\\u202e");
	expect(text).toContain("\\u200b");
	expect(text).toContain("**bold** <b>tag</b>    end");
	expect(text).toContain("Assistant question");
	expect(plainText("a\r\nb\rc")).toBe("a\nb\nc");
	expect(plainLine("x\n\n  y\tz", 20)).toBe("x y z");
	expect(plainLine("abcdef", 4)).toBe("abc…");
});

const stack = (
	dock: QuestionDock,
	width: number,
	height: number,
	extra: { approval?: boolean; busy?: boolean } = {},
) => {
	const busy = extra.busy ?? true;
	const footer = new StatusFooter();
	footer.setStats({
		cwd: "/p",
		model: "m",
		thinkingLevel: "high",
		busy: busy ? "Waiting for your answer" : undefined,
		usageText: "In: 0",
		questionCount: dock.pendingCount,
		questionOpen: dock.open,
	});
	const approval = Object.assign(new Text("APPROVAL-DOCK\nline\nline", 0, 0), { height: 8 });
	const root = createAppLayout({
		transcript: new ScrollView(new Text("history\n".repeat(300), 0, 0), { primary: true }),
		panel: new PickerPanel(
			() => {},
			() => {},
		),
		editor: new Text("input", 0, 0),
		footer,
		notices: new Container(),
		busy: new Text("spinner busy-row", 0, 0),
		busyVisible: () => busy,
		approval,
		approvalVisible: () => extra.approval ?? false,
		question: dock,
		questionVisible: () => dock.visible,
		panelOpen: () => false,
	});
	return renderLayoutFrame(root, width, height, () => {});
};

it("renders a long question with many options inside the layout budget at every size, keeping editor and footer", async () => {
	const words = Array.from({ length: 330 }, (_, i) => `w${i}`).join(" ");
	const q = record(1, {
		question: words.slice(0, 2000),
		multiple: true,
		options: Array.from({ length: 12 }, (_, i) => ({
			id: `o${i}`,
			label: `Option number ${i + 1} with a rather long label ${"x".repeat(30)}`,
			...(i === 5 ? { recommended: true } : {}),
		})),
	});
	for (const [width, height] of [
		[40, 14],
		[60, 16],
		[80, 24],
		[120, 40],
	] as const) {
		const { dock } = setup(q);
		await open(dock, q);
		const frame = stack(dock, width, height);
		const text = plain(frame.lines);
		expect(frame.lines).toHaveLength(height);
		expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(text).toContain("Assistant question");
		expect(text).toContain("input");
		expect(text).toContain("question waiting");
		expect(text).toContain("Esc Close");
		expect(text).toContain("❯");
		expect(text).toMatch(/\b1-\d+\/\d+/);
		dock.handleInput(END);
		expect(plain(stack(dock, width, height).lines)).toContain("Skip this question");
	}
});

it("keeps footer and editor when approval, queue-height rows and the question compete on short terminals", async () => {
	const q = record(1);
	for (const [width, height] of [
		[40, 10],
		[40, 12],
		[60, 16],
	] as const) {
		const { dock } = setup(q);
		await open(dock, q);
		const frame = stack(dock, width, height, { approval: true });
		const text = plain(frame.lines);
		expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(text).toContain("input");
		expect(text).toContain("question");
		expect(dock.height).toBeLessThan(QUESTION_MAX_ROWS);
	}
	const { dock } = setup(q);
	await open(dock, q);
	dock.height = 3;
	const text = view(dock, 40);
	expect(text).toContain("Question");
	expect(text).toContain("enlarge the terminal");
	dock.handleInput(SPACE);
	dock.handleInput(ENTER);
	await tick();
	expect(dock.render(40).length).toBeLessThanOrEqual(3);
});

it("occupies one row while closed and nothing when there is no question", async () => {
	const q = record(1);
	const { dock } = setup(q);
	dock.update(list(q));
	let frame = stack(dock, 80, 24);
	expect(plain(frame.lines)).toContain("Awaiting answer");
	expect(plain(frame.lines)).toContain("input");
	dock.update({ revision: 2, pending: [] });
	frame = stack(dock, 80, 24);
	expect(plain(frame.lines)).not.toContain("Awaiting answer");
	expect(plain(frame.lines)).not.toContain("Assistant question");
});

it("counts waiting questions in the footer and marks a blocked run", () => {
	const footer = new StatusFooter();
	const stats = { cwd: "/p", model: "m", thinkingLevel: null, busy: undefined, usageText: "In: 0" };
	footer.setStats({ ...stats, busy: "Waiting for your answer", questionCount: 1 });
	for (const width of [80, 50, 40]) expect(plain(footer.render(width))).toContain("1 question waiting");
	footer.setStats({ ...stats, busy: "Waiting for your answer", questionCount: 3 });
	expect(plain(footer.render(80))).toContain("3 questions waiting");
	footer.setStats({ ...stats, questionCount: 2, questionOpen: true });
	expect(plain(footer.render(80))).toContain("Esc Close");
	footer.setStats({ ...stats, questionCount: 0 });
	expect(plain(footer.render(80))).not.toContain("waiting");
});

it("marks a session waiting for an answer in the picker instead of Running", async () => {
	const base = {
		workspaceRoot: "/w",
		lastUsedAt: 5,
		createdAt: 5,
		lastMessageAt: 5,
		title: "",
		firstPromptPreview: "",
		model: null,
	};
	const sessions = [
		{ ...base, id: "a", title: "Blocked", status: "running" as const, awaitingAnswer: true },
		{ ...base, id: "b", title: "Working", status: "running" as const, awaitingAnswer: false },
		{ ...base, id: "c", title: "Old gateway", status: "running" as const },
		{ ...base, id: "d", title: "Quiet", status: "idle" as const, awaitingAnswer: false },
	];
	const items = sessionPickerItems(sessions, "/w", "d", 10_000);
	const byId = (id: string) => items.find((item) => item.value === id)!;
	expect(byId("a").description).toContain("Awaiting answer");
	expect(byId("a").description).not.toContain("Running");
	expect(byId("a").rightLabel).toContain("Awaiting answer");
	expect(byId("b").description).toContain("Running");
	expect(byId("b").rightLabel).not.toContain("Awaiting answer");
	expect(byId("c").description).toContain("Running");
	expect(byId("c").description).not.toContain("Awaiting answer");
	expect(byId("d").description).toContain("Idle");

	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	panel.height = 14;
	await panel.show(
		"Sessions",
		async () => items,
		async () => {},
	);
	const text = plain(panel.render(80));
	expect(text).toContain("Awaiting answer");
	for (const line of panel.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
});

it("describes todo and ask_user history from the structured interaction, with no answer controls", () => {
	const base = {
		name: "ask_user",
		summary: "Which database?",
		detail: null,
		phase: "done" as const,
		isError: false,
		output: null,
		result: "The user answered.",
		durationMs: 10,
		note: null,
		diff: null,
		diffAdded: null,
		diffRemoved: null,
	};
	const ask = (status: "pending" | "answered" | "skipped" | "cancelled", extra = {}) =>
		plain(
			new ToolExecutionComponent({
				...base,
				interaction: {
					kind: "ask_user",
					id: 1,
					question: "Which database?",
					multiple: false,
					options: [],
					status,
					...extra,
				},
			}).render(100),
		);
	expect(ask("pending")).toContain("Waiting for your answer");
	expect(ask("answered", { optionIds: ["pg"], labels: ["Postgres"], text: "since v14" })).toContain(
		"✓ Answered: Postgres, since v14",
	);
	expect(ask("skipped")).toContain("Skipped");
	expect(ask("cancelled")).toContain("Cancelled");
	expect(ask("answered", { labels: ["A"] })).not.toContain("Submit");
	const todo = plain(
		new ToolExecutionComponent({
			...base,
			name: "todo",
			summary: "Update todos (5 items)",
			interaction: { kind: "todo", action: "replace", revision: 3, completed: 2, total: 5 },
		}).render(100),
	);
	expect(todo).toContain("Todos 2/5");

	const running = new ToolExecutionComponent({ ...base, phase: "running", result: null });
	running.setWaiting(true);
	expect(plain(running.render(100))).toContain("Waiting for your answer");
	running.setWaiting(false);
	expect(plain(running.render(100))).toContain("Running...");

	const hostile = new ToolExecutionComponent({
		...base,
		summary: "Ask \x1b[2J\x1b]8;;http://evil.example\x07x\x1b]8;;\x07",
		interaction: { kind: "ask_user", id: 2, question: "q", multiple: false, options: [], status: "pending" },
	});
	const raw = hostile.render(100).join("");
	expect(raw).not.toContain("\x1b[2J");
	expect(raw).not.toContain("evil.example");
});

it("registers the command, the shortcut and the key table in the help", () => {
	expect(commands().map((command) => command.name)).toContain("question");
	const text = plain(helpLines("darwin"));
	for (const expected of [
		"/question",
		"Ctrl+O",
		"Space",
		"Tab",
		"[ / ]",
		"Skip this question",
		"PgUp / PgDn",
		"Esc",
		"queued until the question is settled",
	])
		expect(text).toContain(expected);
});

it("opens on a click on the prompt bar, scrolls on the wheel and sets the cursor on a list click", async () => {
	const q = record(1, { question: Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") });
	const { dock } = setup(q);
	dock.update(list(q));
	await tick();
	expect(dock.handleMouse({ type: "click", button: "left", x: 1, y: 0 } as never)).toEqual({ handled: true });
	expect(dock.open).toBe(true);
	const before = view(dock);
	dock.handleMouse({ type: "wheel", wheelDelta: 4, x: 1, y: 2 } as never);
	expect(view(dock)).not.toEqual(before);
	dock.height = 14;
	dock.handleMouse({ type: "wheel", wheelDelta: -100, x: 1, y: 2 } as never);
	const rows = plain(dock.render(80)).split("\n");
	const at = rows.findIndex((line) => line.includes("3. SQLite"));
	dock.handleMouse({ type: "click", button: "left", x: 3, y: at } as never);
	expect(view(dock)).toContain("(●) 3. SQLite");
});

it("moves the hardware cursor into the note field only while that field is focused", async () => {
	const q = record(1);
	const { dock } = setup(q);
	await open(dock, q);
	dock.focused = true;
	expect(dock.render(80).join("")).not.toContain(CURSOR_MARKER);
	dock.handleInput(TAB);
	expect(dock.render(80).join("")).toContain(CURSOR_MARKER);
	dock.handleInput(UP);
	expect(dock.render(80).join("")).not.toContain(CURSOR_MARKER);
	dock.handleInput(TAB);
	dock.closePanel();
	expect(dock.render(80).join("")).not.toContain(CURSOR_MARKER);
});
