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
import { PLAN_LIMITS } from "@neko-harness/core/interactions";
import type { PlanClient } from "@neko-harness/gateway/client-session";
import type { WirePlanDecision, WirePlanRecord, WirePlanView, WireQueuedInput } from "@neko-harness/gateway/contract";
import { BoundedEditor } from "../src/components/editor.ts";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { ToolExecutionComponent } from "../src/components/tool-execution.ts";
import { helpLines } from "../src/help-ui.ts";
import { createInputRouter, type InputHost } from "../src/input-router.ts";
import { commands } from "../src/labels.ts";
import { createAppLayout } from "../src/layout.ts";
import { PLAN_MAX_ROWS, PlanDock, planSettlementText, sameDecision } from "../src/plan-dock.ts";
import { canAutoOpen } from "../src/question-dock.ts";
import { QueueRow, queueKeyAction } from "../src/queue-ui.ts";
import { getEditorTheme, setActiveTheme } from "../src/theme/index.ts";
import { sessionPickerItems } from "../src/workspace.ts";

setActiveTheme("light");

const ESC = "\x1b";
const ESC_REPEAT = "\x1b[27;1:2u";
const ENTER = "\r";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PGDN = "\x1b[6~";
const CTRL_C = "\x03";
const ALT_UP = "\x1b[1;3A";

const plain = (lines: readonly string[]) => lines.map(stripTerminalSequences).join("\n");
const tick = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const record = (version = "p1", extra: Partial<WirePlanRecord> = {}): WirePlanRecord => ({
	version,
	title: "Add a feature flag",
	steps: ["Read the config loader", "Add the flag with a safe default", "Run the tests"],
	note: "Keep the default off.",
	status: "awaiting_approval",
	feedback: null,
	createdAt: 1000,
	settledAt: null,
	...extra,
});
const viewOf = (current: WirePlanRecord | null, mode: "normal" | "plan" = "plan"): WirePlanView => ({
	mode,
	revision: 1,
	current,
});

type Fake = {
	client: PlanClient;
	view: WirePlanView;
	records: Map<string, WirePlanRecord>;
	gets: string[];
	responds: Array<{ version: string; decision: WirePlanDecision }>;
	respond: ((input: Fake["responds"][number]) => Promise<WirePlanRecord>) | undefined;
};
/** The first valid decision wins: a later respond returns the saved record unchanged. */
function fake(...records: WireRecords): Fake {
	const state: Fake = {
		view: viewOf(records.at(-1) ?? null),
		records: new Map(records.map((r) => [r.version, r])),
		gets: [],
		responds: [],
		respond: undefined,
		client: {
			supported: true,
			view: () => state.view,
			get: async (version) => {
				state.gets.push(version);
				return state.records.get(version) ?? null;
			},
			respond: async (input) => {
				state.responds.push(input);
				if (state.respond) return state.respond(input);
				const current = state.records.get(input.version)!;
				if (current.status !== "awaiting_approval") return current;
				const saved: WirePlanRecord =
					input.decision.kind === "approve"
						? { ...current, status: "approved", settledAt: 2000 }
						: { ...current, status: "revision_requested", feedback: input.decision.feedback, settledAt: 2000 };
				state.records.set(input.version, saved);
				return saved;
			},
			setMode: async (mode) => ({ ...state.view, mode }),
		},
	};
	return state;
}
type WireRecords = WirePlanRecord[];

function setup(...records: WirePlanRecord[]) {
	const f = fake(...records);
	const events = {
		renders: 0,
		notices: [] as Array<[string, string]>,
		opened: [] as boolean[],
		aside: undefined as string | undefined,
		now: 1000,
	};
	const dock = new PlanDock({
		changed: () => {
			events.renders++;
		},
		notify: (message, level) => events.notices.push([message, level]),
		opened: (open) => events.opened.push(open),
		aside: () => events.aside,
		now: () => events.now,
	});
	dock.height = PLAN_MAX_ROWS;
	dock.bind("s1", f.client);
	dock.update(f.view);
	return { dock, f, events };
}
const text = (dock: PlanDock, width = 80) => plain(dock.render(width));
const type = (dock: PlanDock, value: string) => {
	for (const char of value) dock.handleInput(char);
};

it("stays invisible until opened, and opens only for a plan that awaits approval", () => {
	const { dock, f, events } = setup(record());
	expect(dock.supported).toBe(true);
	expect(dock.awaiting).toBe(true);
	expect(dock.render(80)).toEqual([]);
	expect(dock.openPanel()).toBe(true);
	expect(events.opened).toEqual([true]);
	const panel = text(dock);
	expect(panel).toContain("Assistant plan");
	expect(panel).toContain("Add a feature flag");
	for (const step of ["1. Read the config loader", "2. Add the flag with a safe default", "3. Run the tests"])
		expect(panel).toContain(step);
	expect(panel).toContain("Note");
	expect(panel).toContain("Keep the default off.");
	expect(panel).toContain("1. Approve and execute");
	expect(panel).toContain("2. Request changes");
	expect(f.responds).toEqual([]);

	const settled = setup(record("p1", { status: "approved" }));
	expect(settled.dock.awaiting).toBe(false);
	expect(settled.dock.openPanel()).toBe(false);
	const none = setup();
	expect(none.dock.openPanel()).toBe(false);
});

it("opens a waiting plan by itself once per version, only when nothing else holds the keys", () => {
	const blocked = setup(record());
	expect(blocked.dock.autoOpen(false)).toBe(false);
	expect(blocked.dock.open).toBe(false);
	// The one chance is spent: becoming free later does not open it behind the user's back.
	expect(blocked.dock.autoOpen(true)).toBe(false);

	const { dock, events } = setup(record());
	expect(dock.autoOpen(true)).toBe(true);
	expect(events.opened).toEqual([true]);
	dock.handleInput("\x1b");
	expect(dock.open).toBe(false);
	// Esc keeps the plan waiting and it does not pop up again for the same version.
	expect(dock.autoOpen(true)).toBe(false);
	expect(dock.awaiting).toBe(true);

	// A revised plan is a new version and opens again.
	dock.update({ mode: "plan", revision: 2, current: record("p2") });
	expect(dock.autoOpen(true)).toBe(true);

	const settled = setup(record("p1", { status: "approved" }));
	expect(settled.dock.autoOpen(true)).toBe(false);
	const none = setup();
	expect(none.dock.autoOpen(true)).toBe(false);
});

it("reports an old gateway as unsupported and never opens", () => {
	const { dock } = setup(record());
	dock.update(undefined);
	expect(dock.supported).toBe(false);
	expect(dock.awaiting).toBe(false);
	expect(dock.mode).toBeUndefined();
	expect(dock.openPanel()).toBe(false);
	expect(dock.handleInput("a")).toBe(false);
});

it("approves with Enter on the first row, closes and tells the user", async () => {
	const { dock, f, events } = setup(record());
	dock.openPanel();
	expect(dock.handleInput(ENTER)).toBe(true);
	await tick();
	expect(f.responds).toEqual([{ version: "p1", decision: { kind: "approve" } }]);
	expect(dock.open).toBe(false);
	expect(events.opened).toEqual([true, false]);
	expect(events.notices).toEqual([["Plan approved. Executing.", "info"]]);
});

it("approves with the A key and moves the cursor with arrows and digits", async () => {
	const { dock, f } = setup(record());
	dock.openPanel();
	dock.handleInput(DOWN);
	expect(text(dock)).toContain("❯ 2. Request changes");
	dock.handleInput("1");
	expect(text(dock)).toContain("❯ 1. Approve and execute");
	dock.handleInput("a");
	await tick();
	expect(f.responds).toHaveLength(1);
	expect(f.responds[0]?.decision).toEqual({ kind: "approve" });
});

it("asks for changes with a typed note, refusing blank and over-long feedback", async () => {
	const { dock, f, events } = setup(record());
	dock.openPanel();
	dock.focused = true;
	dock.handleInput(DOWN);
	dock.handleInput(ENTER);
	expect(dock.render(80).join("")).toContain(CURSOR_MARKER);
	dock.handleInput(ENTER);
	expect(text(dock)).toContain("Type what should change");
	expect(f.responds).toEqual([]);

	dock.handleInput(`\x1b[200~${"x".repeat(PLAN_LIMITS.feedbackChars + 1)}\x1b[201~`);
	dock.handleInput(ENTER);
	expect(text(dock)).toContain("Feedback is too long");
	expect(f.responds).toEqual([]);

	// Tab leaves the field, the draft survives, Esc closes without sending anything.
	dock.handleInput(TAB);
	expect(dock.render(80).join("")).not.toContain(CURSOR_MARKER);
	dock.handleInput(ESC);
	expect(f.responds).toEqual([]);
	dock.openPanel();
	dock.handleInput("r");
	// Clear the over-long draft and write the real feedback.
	for (let i = 0; i < PLAN_LIMITS.feedbackChars + 1; i++) dock.handleInput("\x7f");
	type(dock, "Split step 2");
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([{ version: "p1", decision: { kind: "revise", feedback: "Split step 2" } }]);
	expect(dock.open).toBe(false);
	expect(events.notices.at(-1)?.[0]).toContain("Changes requested");
});

it("ignores keys while a decision is in flight and shows Submitting…", async () => {
	const { dock, f } = setup(record());
	dock.openPanel();
	let release: (r: WirePlanRecord) => void = () => {};
	f.respond = () =>
		new Promise<WirePlanRecord>((resolve) => {
			release = resolve;
		});
	dock.handleInput(ENTER);
	await tick();
	expect(text(dock)).toContain("Submitting…");
	dock.handleInput(ENTER);
	dock.handleInput("a");
	dock.handleInput("r");
	await tick();
	expect(f.responds).toHaveLength(1);
	release({ ...record(), status: "approved" });
	await tick();
	expect(dock.open).toBe(false);
});

it("cancels and leaves plan mode with X, guarded against double submit", async () => {
	const { dock, f, events } = setup(record());
	const modes: string[] = [];
	let release: () => void = () => {};
	f.client.setMode = (mode) => {
		modes.push(mode);
		return new Promise((resolve) => {
			release = () => resolve({ ...f.view, mode });
		});
	};
	dock.openPanel();
	expect(text(dock)).toContain("Cancel and exit plan mode");
	dock.handleInput("x");
	await tick();
	expect(text(dock)).toContain("Submitting…");
	dock.handleInput("X");
	dock.handleInput("a");
	await tick();
	expect(modes).toEqual(["normal"]);
	expect(f.responds).toEqual([]);
	release();
	await tick();
	expect(dock.open).toBe(false);
	expect(events.notices).toEqual([["Plan cancelled. Plan mode off.", "info"]]);
});

it("offers leaving plan mode as the third option, chosen by arrows, Enter or 3", async () => {
	for (const keys of [
		["\x1b[B", "\x1b[B", "\r"],
		["3", "\r"],
	]) {
		const { dock, f, events } = setup(record());
		const modes: string[] = [];
		f.client.setMode = async (mode) => {
			modes.push(mode);
			return { ...f.view, mode };
		};
		dock.openPanel();
		expect(text(dock)).toContain("3. Cancel and exit plan mode");
		for (const key of keys) dock.handleInput(key);
		await tick();
		expect(modes).toEqual(["normal"]);
		expect(f.responds).toEqual([]);
		expect(dock.open).toBe(false);
		expect(events.notices).toEqual([["Plan cancelled. Plan mode off.", "info"]]);
	}
});

it("keeps a blank row between the transcript and the panel", () => {
	const { dock } = setup(record());
	dock.openPanel();
	const lines = dock.render(80).map(stripTerminalSequences);
	expect(lines[0]).toBe("");
	expect(lines[1]).toContain("Assistant plan");
	expect(lines.length).toBeLessThanOrEqual(PLAN_MAX_ROWS);
});

it("keeps the panel open and shows the error when leaving plan mode is refused", async () => {
	const { dock, f, events } = setup(record());
	f.client.setMode = async () => {
		throw new Error("PLAN_BUSY: the session is running");
	};
	dock.openPanel();
	dock.handleInput("x");
	await tick();
	expect(dock.open).toBe(true);
	expect(text(dock)).toContain("PLAN_BUSY");
	expect(events.notices).toEqual([]);
});

it("types x into the feedback field instead of exiting plan mode", async () => {
	const { dock, f } = setup(record());
	let called = 0;
	f.client.setMode = async (mode) => {
		called++;
		return { ...f.view, mode };
	};
	dock.openPanel();
	dock.focused = true;
	dock.handleInput("r");
	dock.handleInput("x");
	await tick();
	expect(called).toBe(0);
	expect(text(dock)).toContain("x");
	expect(dock.open).toBe(true);
});

it("shows the real result when another client decided first, and disables the controls", async () => {
	const { dock, f, events } = setup(record());
	dock.openPanel();
	f.respond = async () => ({
		...record(),
		status: "revision_requested",
		feedback: "Elsewhere: use a flag",
		settledAt: 2,
	});
	dock.handleInput("a");
	await tick();
	expect(dock.open).toBe(true);
	const panel = text(dock);
	expect(panel).toContain("Changes were already requested: Elsewhere: use a flag");
	expect(panel).not.toContain("Approve and execute");
	expect(events.notices).toEqual([]);
	dock.handleInput("a");
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toHaveLength(1);
	dock.handleInput(ESC);
	expect(dock.open).toBe(false);

	expect(sameDecision({ kind: "approve" }, record("p", { status: "approved" }))).toBe(true);
	expect(sameDecision({ kind: "approve" }, record("p", { status: "revision_requested", feedback: "x" }))).toBe(false);
	expect(
		sameDecision({ kind: "revise", feedback: "x" }, record("p", { status: "revision_requested", feedback: "y" })),
	).toBe(false);
	expect(planSettlementText(record("p", { status: "cancelled" })).text).toContain("Cancelled");
});

it("lost race reported while the panel is closed becomes a notice", async () => {
	const { dock, f, events } = setup(record());
	dock.openPanel();
	let release: (r: WirePlanRecord) => void = () => {};
	f.respond = () =>
		new Promise<WirePlanRecord>((resolve) => {
			release = resolve;
		});
	dock.handleInput("a");
	await tick();
	dock.handleInput(ESC);
	release({ ...record(), status: "approved" });
	await tick();
	// The decision was ours, so the usual success notice still applies.
	expect(events.notices).toEqual([["Plan approved. Executing.", "info"]]);

	const second = setup(record());
	second.dock.openPanel();
	let late: (r: WirePlanRecord) => void = () => {};
	second.f.respond = () =>
		new Promise<WirePlanRecord>((resolve) => {
			late = resolve;
		});
	second.dock.handleInput("a");
	await tick();
	second.dock.handleInput(ESC);
	late({ ...record(), status: "revision_requested", feedback: "no", settledAt: 3 });
	await tick();
	expect(second.events.notices.at(-1)).toEqual([expect.stringContaining("Changes were already requested"), "warning"]);
});

it("follows the live record when the plan settles elsewhere while the panel is open", async () => {
	const { dock, f } = setup(record());
	dock.openPanel();
	f.view = viewOf(record("p1", { status: "approved", settledAt: 5 }), "normal");
	dock.update(f.view);
	expect(text(dock)).toContain("Already approved");
	expect(text(dock)).not.toContain("Request changes");
	dock.handleInput("a");
	await tick();
	expect(f.responds).toEqual([]);
});

it("marks a replaced plan, checks its real status and offers the newest one", async () => {
	const old = record("p1");
	const { dock, f } = setup(old);
	dock.openPanel();
	f.records.set("p1", { ...old, status: "superseded" });
	f.view = viewOf(record("p2", { title: "Newer plan" }));
	dock.update(f.view);
	expect(text(dock)).toContain("Checking the result");
	dock.handleInput("a");
	await tick();
	expect(f.responds).toEqual([]);
	expect(f.gets).toEqual(["p1"]);
	expect(text(dock)).toContain("replaced by a newer one");
	expect(text(dock)).toContain("Enter Newest plan");
	dock.handleInput(ENTER);
	expect(text(dock)).toContain("Newer plan");
	expect(text(dock)).toContain("Approve and execute");
	dock.handleInput("a");
	await tick();
	expect(f.responds).toEqual([{ version: "p2", decision: { kind: "approve" } }]);
});

it("shows a stopped run as cancelled and closes when the plan view disappears", () => {
	const { dock, f } = setup(record());
	dock.openPanel();
	f.view = viewOf(record("p1", { status: "cancelled", settledAt: 9 }));
	dock.update(f.view);
	expect(text(dock)).toContain("Cancelled");
	dock.update(undefined);
	expect(dock.open).toBe(false);
});

it("shows errors inline, keeps the draft and resends only on an explicit key", async () => {
	const { dock, f } = setup(record());
	dock.openPanel();
	f.respond = async () => {
		throw new Error("PLAN_STALE: network down");
	};
	dock.handleInput("r");
	type(dock, "tighter scope");
	dock.handleInput(ENTER);
	await tick();
	expect(text(dock)).toContain("PLAN_STALE: network down");
	expect(text(dock)).toContain("tighter scope");
	expect(dock.open).toBe(true);
	await tick();
	expect(f.responds).toHaveLength(1);
	f.respond = undefined;
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toHaveLength(2);
	expect(f.responds[1]?.decision).toEqual({ kind: "revise", feedback: "tighter scope" });
	expect(dock.open).toBe(false);
});

it("disables deciding when the gateway is gone", async () => {
	const { dock, f } = setup(record());
	dock.openPanel();
	dock.setOnline(false);
	expect(text(dock)).toContain("Offline");
	dock.handleInput("a");
	await tick();
	expect(f.responds).toEqual([]);
	expect(text(dock)).toContain("Gateway unavailable");
});

it("strips terminal control sequences from plan text before rendering it", () => {
	const hostile = "\x1b[2J\x1b]8;;http://evil.example\x07click\x1b]8;;\x07\u202e";
	const { dock } = setup(
		record("p1", { title: `Title ${hostile}`, steps: [`Step ${hostile}`, "**bold** `code`"], note: `Note ${hostile}` }),
	);
	dock.openPanel();
	const raw = dock.render(80).join("");
	expect(raw).not.toContain("\x1b[2J");
	expect(raw).not.toContain("evil.example");
	expect(raw).not.toContain("\u202e");
	expect(raw).toContain("\\u202e");
	const shown = plain(dock.render(80));
	expect(shown).toContain("bold code");
	expect(shown).not.toContain("**bold**");
	expect(planSettlementText(record("p", { status: "revision_requested", feedback: hostile })).text).not.toContain(
		"\x1b",
	);
});

it("renders steps and note as Markdown: lists, headings and inline code lose their markers", () => {
	const { dock } = setup(
		record("p1", {
			steps: ["Run `bun test` and **fix** failures", "Plain step"],
			note: "## Assumptions\n- the API stays stable\n\n**Risk**: low",
		}),
	);
	dock.openPanel();
	dock.height = 20;
	const shown = plain(dock.render(80));
	expect(shown).toContain("1. Run bun test and fix failures");
	expect(shown).toContain("2. Plain step");
	expect(shown).toContain("Assumptions");
	expect(shown).not.toContain("## Assumptions");
	expect(shown).toMatch(/[-•] the API stays stable/);
	expect(shown).toContain("Risk: low");
	expect(shown).not.toContain("**");
	expect(shown).not.toContain("`");
});

it("scrolls a long plan with PgUp/PgDn inside the row budget and keeps the actions visible", () => {
	const steps = Array.from({ length: 30 }, (_, i) => `Step number ${i + 1} ${"detail ".repeat(8)}`);
	const { dock } = setup(record("p1", { steps }));
	dock.openPanel();
	dock.height = 12;
	const first = dock.render(60);
	expect(first.length).toBeLessThanOrEqual(12);
	expect(plain(first)).toContain("Approve and execute");
	expect(plain(first)).toMatch(/\b1-\d+\/\d+/);
	dock.handleInput(PGDN);
	const second = plain(dock.render(60));
	expect(second).not.toEqual(plain(first));
	expect(second).toContain("Approve and execute");
	for (const line of dock.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	dock.handleMouse({ type: "wheel", wheelDelta: -100, x: 1, y: 2 } as never);
	expect(text(dock, 60)).toMatch(/\b1-\d+\/\d+/);
});

it("asks for a bigger terminal when there is no room, and sends nothing", async () => {
	const { dock, f } = setup(record());
	dock.openPanel();
	dock.height = 3;
	expect(text(dock, 60)).toContain("enlarge the terminal");
	dock.handleInput("a");
	dock.handleInput(ENTER);
	await tick();
	expect(f.responds).toEqual([]);
	expect(dock.render(60).length).toBeLessThanOrEqual(3);
});

it("sets the cursor and the note field with the mouse", () => {
	const { dock } = setup(record());
	dock.openPanel();
	dock.focused = true;
	const rows = text(dock).split("\n");
	const at = rows.findIndex((line) => line.includes("2. Request changes"));
	dock.handleMouse({ type: "click", button: "left", x: 3, y: at } as never);
	expect(dock.render(80).join("")).toContain(CURSOR_MARKER);
});

it("Esc only closes, Ctrl+C keeps its global meaning, and the closing Esc repeat is swallowed", () => {
	const { dock, events } = setup(record());
	dock.openPanel();
	expect(dock.handleInput(CTRL_C)).toBe(false);
	expect(dock.handleInput(ESC)).toBe(true);
	expect(dock.open).toBe(false);
	expect(dock.swallowEscRepeat(ESC_REPEAT)).toBe(true);
	events.now += 1000;
	expect(dock.swallowEscRepeat(ESC_REPEAT)).toBe(false);
	expect(dock.handleInput("a")).toBe(false);
});

it("does not auto-open a question while the plan panel is open", () => {
	const focus = {
		online: true,
		usable: true,
		editorText: "",
		autocomplete: false,
		overlayOpen: false,
		approvalFocused: false,
		sessionOperation: false,
		queueSelecting: false,
	};
	expect(canAutoOpen(focus)).toBe(true);
	expect(canAutoOpen({ ...focus, planOpen: true })).toBe(false);
});

// —— 焦点路由：计划面板 / 审批 / 队列 / 聊天输入 ——

const queued = (id: number, preview: string): WireQueuedInput => ({ id, mode: "followUp", preview, images: 0 });

function routing(options: { busy?: boolean; approval?: boolean; queue?: WireQueuedInput[] } = {}) {
	const { dock, f, events } = setup(record());
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
	const log = { aborts: 0, exits: 0, queueActs: [] as string[], toggles: 0, questions: 0 };
	const state = { busy: options.busy ?? false };
	// Like the TUI: opening the panel drops a pending queue selection.
	const opening = dock.openPanel.bind(dock);
	const open = () => {
		const opened = opening();
		if (opened) queue.clear();
		return opened;
	};
	const question = { open: false, handleInput: () => false, swallowEscRepeat: () => false };
	const host: InputHost = {
		size: () => ({ columns: 80, rows: 24 }),
		editor,
		approval,
		question,
		plan: dock,
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
			log.questions++;
		},
		togglePlan: () => {
			log.toggles++;
			if (dock.awaiting) open();
		},
		clipboardKey: () => false,
		pasteImages: () => false,
		openSessions: () => {},
		abort: () => {
			log.aborts++;
		},
		exit: () => {
			log.exits++;
		},
	};
	const route = createInputRouter(host);
	const press = (data: string) => {
		const result = route(data);
		if (result === undefined) editor.handleInput(data);
		return result;
	};
	return { dock, f, events, editor, queue, approval, log, state, press, open };
}

it("when the panel is open, Enter does not trigger a queued Steer and Esc does not withdraw or stop", async () => {
	const h = routing({ busy: true, queue: [queued(1, "first"), queued(2, "second")] });
	// A queue selection is in progress when the panel opens; opening clears it.
	h.press(ALT_UP);
	expect(h.queue.selecting).toBe(true);
	h.open();
	expect(h.queue.selecting).toBe(false);
	h.log.queueActs.length = 0;

	h.press(ALT_UP);
	h.press(UP);
	expect(h.log.queueActs).toEqual([]);
	expect(h.queue.selecting).toBe(false);

	expect(h.press(ENTER)).toEqual({ consume: true });
	await tick();
	expect(h.log.queueActs).toEqual([]);
	expect(h.f.responds).toHaveLength(1);
	expect(h.dock.open).toBe(false);

	// Esc on a reopened panel only closes it: no withdraw, no abort, the draft is intact.
	h.f.respond = undefined;
	h.dock.update(viewOf(record("p2")));
	h.open();
	h.press(ALT_UP);
	expect(h.press(ESC)).toEqual({ consume: true });
	expect(h.dock.open).toBe(false);
	expect(h.log.queueActs).toEqual([]);
	expect(h.log.aborts).toBe(0);
	expect(h.editor.getText()).toBe("draft in progress");
});

it("a selection made before the panel opened cannot be steered by the panel's Enter", async () => {
	const h = routing({ busy: true, queue: [queued(1, "first")] });
	h.press(ALT_UP);
	expect(h.queue.selecting).toBe(true);
	// The panel opens from elsewhere without clearing: it still owns Enter and Esc.
	h.dock.openPanel();
	expect(h.press(ENTER)).toEqual({ consume: true });
	await tick();
	expect(h.log.queueActs).toEqual(["select"]);
	expect(h.f.responds).toHaveLength(1);
	h.dock.update(viewOf(record("p2")));
	h.dock.openPanel();
	h.press(ESC);
	expect(h.log.queueActs).toEqual(["select"]);
	expect(h.log.aborts).toBe(0);
});

it("gives each key to one owner: plan panel > approval > queue > editor", async () => {
	const h = routing({ approval: true, busy: true, queue: [queued(1, "first")] });
	h.open();
	h.press("z");
	expect(h.editor.getText()).toBe("draft in progress");
	expect(h.approval.keys).toEqual([]);
	h.press(ENTER);
	await tick();
	expect(h.approval.keys).toEqual([]);
	expect(h.f.responds).toHaveLength(1);
	expect(h.dock.open).toBe(false);
	h.events.now += 1000;
	h.press(ENTER);
	expect(h.approval.keys).toEqual([ENTER]);
});

it("keeps Ctrl+C's global meaning inside the panel: stop while running, exit when idle", () => {
	const h = routing({ busy: true });
	h.open();
	expect(h.press(CTRL_C)).toEqual({ consume: true });
	expect(h.log.aborts).toBe(1);
	expect(h.dock.open).toBe(true);
	h.state.busy = false;
	h.press(CTRL_C);
	expect(h.log.exits).toBe(1);
});

it("swallows the Esc auto-repeat after closing so the run is not stopped", () => {
	const h = routing({ busy: true });
	h.open();
	h.press(ESC);
	h.events.now += 100;
	expect(h.press(ESC_REPEAT)).toEqual({ consume: true });
	expect(h.log.aborts).toBe(0);
});

it("toggles plan mode with Shift+Tab, but not while the panel is open or completion is showing", () => {
	const h = routing({ queue: [queued(1, "a")] });
	h.f.view = viewOf(record("p1", { status: "approved" }), "normal");
	h.dock.update(h.f.view);
	expect(h.press(SHIFT_TAB)).toEqual({ consume: true });
	expect(h.log.toggles).toBe(1);
	expect(h.editor.getText()).toBe("draft in progress");

	h.f.view = viewOf(record("p3"));
	h.dock.update(h.f.view);
	h.press(SHIFT_TAB);
	expect(h.log.toggles).toBe(2);
	expect(h.dock.open).toBe(true);
	// With the panel open, Shift+Tab belongs to the panel, not to the mode toggle.
	h.press(SHIFT_TAB);
	expect(h.log.toggles).toBe(2);
});

it("lists /plan in the completion commands and documents it in the help", () => {
	const command = commands.find((c) => c.name === "plan");
	expect(command?.description).toContain("plan mode");
	const help = plain(helpLines("darwin"));
	for (const expected of ["/plan", "Shift+Tab", "Approve", "Request changes", "replaces that plan"])
		expect(help).toContain(expected);
});

// —— 页脚与布局 ——

const stats = { cwd: "/project", model: "m", thinkingLevel: null, busy: undefined, usageText: "In: 0" };

it("shows the PLAN mode in the identity and keeps it on every narrow width", () => {
	const footer = new StatusFooter();
	footer.setStats({ ...stats, planMode: true });
	for (const width of [120, 80, 50, 40]) {
		const lines = plain(footer.render(width)).split("\n");
		expect(lines[0]).toContain("PLAN");
		for (const line of footer.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
	footer.setStats({ ...stats, planMode: false });
	expect(plain(footer.render(80))).not.toContain("PLAN");
	footer.setStats({
		...stats,
		cwd: "/a-very-long-workspace-directory-name",
		model: "a-long-model-name",
		planMode: true,
	});
	expect(plain(footer.render(40))).toContain("PLAN");
});

it("hints that a plan awaits approval on the second line at every width, and the panel changes the hint", () => {
	const footer = new StatusFooter();
	footer.setStats({ ...stats, planMode: true, planAwaiting: true });
	for (const width of [120, 80, 60, 50, 40]) {
		const second = plain(footer.render(width)).split("\n")[1] ?? "";
		expect(second).toContain("Plan awaiting approval");
		expect(visibleWidth(second)).toBeLessThanOrEqual(width);
	}
	expect(plain(footer.render(80))).toContain("Plan awaiting approval, /plan to view");
	footer.setStats({ ...stats, planMode: true, planAwaiting: false });
	expect(plain(footer.render(80))).not.toContain("Plan awaiting approval");
	footer.setStats({ ...stats, planMode: true, planAwaiting: true, planOpen: true });
	expect(plain(footer.render(80))).toContain("Esc Close");
	// A waiting question and a waiting plan do not push each other out of a normal row.
	footer.setStats({ ...stats, planAwaiting: true, questionCount: 1, busy: "Waiting for your answer" });
	const both = plain(footer.render(80)).split("\n")[1] ?? "";
	expect(both).toContain("1 question waiting");
	expect(both).toContain("Plan awaiting approval");
});

const stack = (dock: PlanDock, width: number, height: number, extra: { approval?: boolean; busy?: boolean } = {}) => {
	const busy = extra.busy ?? false;
	const footer = new StatusFooter();
	footer.setStats({
		...stats,
		planMode: true,
		planAwaiting: true,
		planOpen: dock.open,
		busy: busy ? "Thinking" : undefined,
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
		approvalVisible: () => (extra.approval ?? false) && !dock.open,
		plan: dock,
		planVisible: () => dock.open,
		panelOpen: () => false,
	});
	return renderLayoutFrame(root, width, height, () => {});
};

it("fits the panel inside the layout budget at every size while editor and footer survive", () => {
	const steps = Array.from(
		{ length: 25 },
		(_, i) => `Step number ${i + 1} with a rather long description ${"x".repeat(40)}`,
	);
	for (const [width, height] of [
		[40, 10],
		[40, 14],
		[60, 16],
		[80, 24],
		[120, 40],
	] as const) {
		const { dock } = setup(record("p1", { steps, note: "n".repeat(300) }));
		dock.openPanel();
		const frame = stack(dock, width, height, { approval: true, busy: true });
		const out = plain(frame.lines);
		expect(frame.lines).toHaveLength(height);
		expect(frame.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(out).toContain("input");
		expect(out).toContain("PLAN");
		expect(out).not.toContain("APPROVAL-DOCK");
		expect(out).toContain("Assistant plan");
		expect(dock.height).toBeLessThanOrEqual(PLAN_MAX_ROWS);
		if (height >= 16) expect(out).toContain("Approve and execute");
	}
});

it("takes no rows while closed", () => {
	const { dock } = setup(record());
	const frame = stack(dock, 80, 24);
	expect(plain(frame.lines)).not.toContain("Assistant plan");
	expect(plain(frame.lines)).toContain("input");
	expect(plain(frame.lines)).toContain("Plan awaiting approval");
});

// —— 历史行与目录 ——

it("describes submit_plan history from the structured interaction and the newest plan's status", () => {
	const base = {
		name: "submit_plan",
		summary: "Add a feature flag",
		detail: "1. Read\n2. Write",
		phase: "done" as const,
		isError: false,
		output: null,
		result: "Plan submitted.",
		durationMs: 10,
		note: null,
		diff: null,
		diffAdded: null,
		diffRemoved: null,
		interaction: {
			kind: "submit_plan" as const,
			version: "p1",
			title: "Add a feature flag",
			steps: ["Read", "Write"],
			note: "",
		},
	};
	const card = new ToolExecutionComponent(base);
	const status = () => plain(card.render(100));
	expect(card.planVersion).toBe("p1");
	expect(status()).toContain("Plan submitted");
	card.setPlan({ version: "p1", status: "awaiting_approval" });
	expect(status()).toContain("Awaiting approval · /plan");
	card.setPlan({ version: "p1", status: "approved" });
	expect(status()).toContain("✓ Approved");
	card.setPlan({ version: "p1", status: "revision_requested" });
	expect(status()).toContain("Changes requested");
	card.setPlan({ version: "p1", status: "cancelled" });
	expect(status()).toContain("Cancelled");
	card.setPlan({ version: "p1", status: "superseded" });
	expect(status()).toContain("Superseded");
	// A newer plan leaves this card as a plain record, with no answer controls.
	card.setPlan({ version: "p2", status: "awaiting_approval" });
	expect(status()).toContain("Plan submitted");
	expect(status()).not.toContain("Approve");
	card.setExpanded(true);
	expect(status()).toContain("1. Read");

	const hostile = new ToolExecutionComponent({
		...base,
		summary: "Plan \x1b[2J\x1b]8;;http://evil.example\x07x\x1b]8;;\x07",
	});
	const raw = hostile.render(100).join("");
	expect(raw).not.toContain("\x1b[2J");
	expect(raw).not.toContain("evil.example");
	expect(new ToolExecutionComponent({ ...base, name: "read", interaction: undefined }).planVersion).toBeUndefined();
});

it("marks a session waiting for plan approval in the picker", () => {
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
		{ ...base, id: "a", title: "Planned", status: "idle" as const, awaitingPlan: true },
		{ ...base, id: "b", title: "Quiet", status: "idle" as const, awaitingPlan: false },
		{ ...base, id: "c", title: "Old gateway", status: "idle" as const },
	];
	const items = sessionPickerItems(sessions, "/w", "b", 10_000);
	const byId = (id: string) => items.find((item) => item.value === id)!;
	expect(byId("a").description).toContain("等待批准");
	expect(byId("a").description).not.toContain("Idle");
	expect(byId("a").rightLabel).toContain("等待批准");
	expect(byId("b").description).toContain("Idle");
	expect(byId("c").description).toContain("Idle");
});
