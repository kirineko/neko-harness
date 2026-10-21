import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type { QuestionRecord } from "@neko-harness/core/interactions";
import { JSDOM } from "jsdom";
import * as React from "react";
import { chatView, plan, question } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html><head><title>neko.harness</title></head><body></body></html>", {
	url: "http://localhost/",
});
let viewportWidth = 1440;
const matchMedia = (query: string) => {
	const max = /max-width:\s*(\d+)px/.exec(query);
	return {
		matches: max ? viewportWidth <= Number(max[1]) : false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	};
};
Object.assign(dom.window, { matchMedia });
Object.assign(dom.window.HTMLElement.prototype, { scrollTo: () => {} });
const notifications: string[] = [];
class FakeNotification {
	static permission = "default";
	static requestPermission() {
		notifications.push("requestPermission");
		return Promise.resolve("denied");
	}
	constructor() {
		notifications.push("construct");
	}
}
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	Notification: FakeNotification,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const submits: unknown[][] = [];
const responds: unknown[][] = [];
const decisions: unknown[] = [];
let records = new Map<number, QuestionRecord>();
const approval = {
	id: 5,
	version: "av1",
	childId: 9,
	delegationTaskId: 3,
	callId: "bash-1",
	command: "rm -rf build",
	cwd: "/w",
	timeout: null,
	status: "pending",
	createdAt: 1,
	decidedAt: null,
};
mock.module("../src/client/lib/bootstrap", () => ({
	appActions: {
		submit: async (...args: unknown[]) => void submits.push(args),
		questionGet: async (_session: string, id: number) => records.get(id) ?? null,
		questionRespond: async (_session: string, input: { id: number; response: { kind: string } }) => {
			responds.push([input]);
			return { ...records.get(input.id)!, status: input.response.kind === "skip" ? "skipped" : "answered" };
		},
		subagent: () => ({
			view: { value: { approvals: [approval] }, subscribe: () => () => {} },
			decideApproval: async (decision: unknown) => void decisions.push(decision),
		}),
		withdraw: async () => ({ result: "unknown" }),
		steer: async () => ({ result: "unknown" }),
		abort: () => {},
		compact: async () => {},
		searchFiles: async () => ({ items: [] }),
		listSkills: async () => [],
		createSession: async () => {},
		selectSession: async () => {},
		selectWorkspace: async () => {},
		addWorkspace: async () => {},
		archiveSession: async () => {},
		configure: async () => {},
	},
	reportError: () => {},
}));
mock.module("@tanstack/react-router", () => ({
	Link: (props: { to: string; className?: string; children?: React.ReactNode; onClick?: () => void }) =>
		React.createElement("a", { href: props.to, className: props.className, onClick: props.onClick }, props.children),
}));

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { ChatPage } = await import("../src/client/pages/chat-page.tsx");
const { questionUi } = await import("../src/client/lib/question-ui.ts");
const { storeActions } = await import("../src/client/lib/store.ts");

let sessions = 0;
const sessionSummary = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	workspaceRoot: "/w",
	title: id,
	firstPromptPreview: id,
	createdAt: 1,
	lastMessageAt: 1,
	updatedAt: 1,
	model: null,
	status: "running" as const,
	...over,
});
type ViewInit = Parameters<typeof chatView>[0];
function connect(init: ViewInit, directory: ReturnType<typeof sessionSummary>[] = []) {
	const id = `page-session-${++sessions}`;
	act(() => {
		storeActions.setWorkspace("/w");
		storeActions.setPhase("ready");
		storeActions.setSession(id);
		storeActions.setDirectory(directory.map((s) => (s.id === "self" ? { ...s, id } : s)) as never);
		storeActions.setView(chatView(init));
	});
	return id;
}
const mounted: { unmount(): void }[] = [];
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () => root.render(React.createElement(ChatPage)));
	await flush();
	return host;
}
const flush = async () => {
	for (let i = 0; i < 3; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
};
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const button = (host: ParentNode, label: string) =>
	[...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;
const card = (host: ParentNode) => host.querySelector<HTMLElement>("[data-question-card]");
const before = (a: Node, b: Node) =>
	Boolean(a.compareDocumentPosition(b) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
	document.body.innerHTML = "";
	submits.length = 0;
	responds.length = 0;
	decisions.length = 0;
	notifications.length = 0;
	viewportWidth = 1440;
	questionUi.reset();
	records = new Map();
});
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount();
	});
	storeActions.setView(null);
	storeActions.setSession(null);
	storeActions.setDirectory([]);
});

const askItem = (id: number, status: "pending" | "answered" | "skipped" | "cancelled", extra = {}) => ({
	type: "tool" as const,
	key: `t${id}`,
	callId: `call-${id}`,
	name: "ask_user",
	summary: "ignored summary",
	detail: null,
	phase: "done" as const,
	isError: false,
	output: null,
	// The row must come from `interaction`, never from this text.
	result: "The user answered. FREE TEXT THAT MUST NOT BE PARSED",
	durationMs: 5,
	note: null,
	diff: null,
	diffAdded: null,
	diffRemoved: null,
	interaction: {
		kind: "ask_user" as const,
		id,
		question: `Question #${id}\nsecond line`,
		multiple: false,
		options: [{ id: "pg", label: "Postgres" }],
		status,
		...extra,
	},
});

it("wires todos, the approval stack, the question card and the composer in a non-overlapping order", async () => {
	const q = question();
	records.set(7, q);
	connect({
		questions: [q],
		todos: {
			revision: 2,
			items: [
				{ id: "a", text: "first", status: "completed" },
				{ id: "b", text: "second", status: "in_progress" },
			],
		},
		subagents: [{ taskId: 3, agentId: "agent-3", title: "child", approvalCount: 1 }] as never,
	});
	const host = await mount();
	const topbar = host.querySelector("header")!;
	const todoButton = button(topbar, "待办 1/2，已完成 1 项");
	expect(todoButton).toBeDefined();
	expect(host.querySelector("[data-todo-panel]")).toBeNull();
	await click(todoButton);
	const panel = host.querySelector("[data-todo-panel]")!;
	expect(panel.textContent).toContain("second");
	const main = host.querySelector("main")!;
	const stack = host.querySelector<HTMLElement>("[data-attention-stack]")!;
	const composer = host.querySelector('section[aria-label="消息输入"]')!;
	const bash = host.querySelector('section[aria-label="Bash 审批"]')!;
	// The panel shares the message area (inside main, shrinkable); approvals, question and composer stay below it.
	expect(before(topbar, panel)).toBe(true);
	expect(main.contains(panel)).toBe(true);
	expect(before(panel, stack)).toBe(true);
	expect(before(panel, composer)).toBe(true);
	expect(panel.contains(composer) || panel.contains(stack)).toBe(false);
	expect(stack.contains(bash) && stack.contains(card(host)!)).toBe(true);
	expect(before(bash, card(host)!)).toBe(true);
	expect(before(stack, composer)).toBe(true);
	expect(stack.contains(composer)).toBe(false);
	// Approval (40dvh cap) and card share a shrinkable 60dvh stack, so the composer and stop controls keep room.
	expect(stack.className).toContain("max-h-[60dvh]");
	expect(stack.className).toMatch(/\bshrink\b/);
	expect(panel.className).toMatch(/\bshrink\b/);
	expect(host.querySelector('[aria-label="待审批命令"]')!.className).toContain("max-h-[40dvh]");
	// A pending approval keeps the card folded as a prompt bar.
	expect(card(host)!.dataset.open).toBe("false");
	await click(todoButton);
	expect(host.querySelector("[data-todo-panel]")).toBeNull();
});

it("answers a question without a chat submit and without deciding any Bash approval", async () => {
	const q = question();
	records.set(7, q);
	connect({
		questions: [q],
		subagents: [{ taskId: 3, agentId: "agent-3", title: "child", approvalCount: 1 }] as never,
	});
	const host = await mount();
	const bash = host.querySelector('section[aria-label="Bash 审批"]')!;
	expect(bash.textContent).toContain("rm -rf build");
	expect(card(host)).not.toBeNull();
	await click(button(card(host)!, "展开提问"));
	await flush();
	const radio = [...host.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((r) => r.value === "sqlite")!;
	await click(radio);
	await click(button(card(host)!, "提交回答"));
	expect(responds).toHaveLength(1);
	expect(submits).toHaveLength(0);
	expect(decisions).toHaveLength(0);
	// The approval card is untouched and still pending.
	expect(host.querySelector('section[aria-label="Bash 审批"]')).not.toBeNull();
	expect(button(bash, "允许本次").disabled).toBe(false);
	// The two surfaces are visually and semantically different.
	expect(bash.getAttribute("aria-label")).toBe("Bash 审批");
	expect(bash.className).not.toContain("tianyi");
});

it("shows ask_user history rows from structured details, with only a locate action while pending", async () => {
	const q = question({ id: 7 });
	records.set(7, q);
	connect({
		questions: [q],
		items: [
			askItem(7, "pending"),
			askItem(8, "answered", { optionIds: ["pg"], labels: ["Postgres"], text: "because" }),
			askItem(9, "skipped"),
			askItem(10, "cancelled"),
		] as never,
	});
	const host = await mount();
	const rows = [...host.querySelectorAll<HTMLElement>("[data-ask-user-row]")];
	expect(rows.map((row) => row.dataset.status)).toEqual(["pending", "answered", "skipped", "cancelled"]);
	expect(rows[0]!.textContent).toContain("等待回答");
	expect(rows[0]!.textContent).toContain("Question #7");
	expect(rows[1]!.textContent).toContain("已回答");
	expect(rows[1]!.textContent).toContain("回答：Postgres, because");
	expect(rows[2]!.textContent).toContain("已跳过");
	expect(rows[3]!.textContent).toContain("已取消");
	for (const row of rows) expect(row.textContent).not.toContain("MUST NOT BE PARSED");
	// No answer controls in the transcript; only the pending row can jump to the card.
	for (const row of rows) expect(row.querySelector("input, textarea")).toBeNull();
	expect([...rows[0]!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["定位到问题"]);
	for (const row of rows.slice(1)) expect(row.querySelector("button")).toBeNull();

	// The card is open on its own (composer idle); fold it, then locate it from the row.
	await click(button(card(host)!, "折叠提问（不会跳过）"));
	expect(card(host)!.dataset.open).toBe("false");
	await click(button(rows[0]!, "定位到问题"));
	await flush();
	expect(card(host)!.dataset.open).toBe("true");
	expect(card(host)!.contains(document.activeElement)).toBe(true);
	expect(responds).toHaveLength(0);
});

it("falls back to the generic tool card when a row has no structured interaction", async () => {
	connect({
		items: [{ ...askItem(7, "pending"), interaction: undefined, summary: "plain summary", phase: "running" }] as never,
	});
	const host = await mount();
	expect(host.querySelector("[data-ask-user-row]")).toBeNull();
	expect(host.textContent).toContain("plain summary");
});

it("labels sessions waiting for an answer in the list, and keeps the old label without the flag", async () => {
	connect({}, [
		sessionSummary("self", { awaitingAnswer: true }),
		sessionSummary("busy", { awaitingAnswer: false }),
		sessionSummary("legacy"),
		sessionSummary("broken", { status: "error" }),
	]);
	const host = await mount();
	const meta = Object.fromEntries(
		[...host.querySelectorAll(".session-copy")].map((copy) => [
			copy.querySelector(".truncate")!.textContent,
			copy.querySelector(".session-meta")!.textContent,
		]),
	);
	expect(meta.busy).toContain("运行中");
	expect(meta.legacy).toContain("运行中");
	expect(meta.broken).toContain("出错");
	const waiting = Object.entries(meta).find(([, text]) => text?.includes("等待回答"))!;
	expect(waiting[1]).not.toContain("运行中");
	expect(Object.values(meta).filter((text) => text?.includes("等待回答"))).toHaveLength(1);
});

it("prefixes the tab title only while hidden with a pending question, and restores it after", async () => {
	let hidden = false;
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	const setHidden = (value: boolean) =>
		act(async () => {
			hidden = value;
			document.dispatchEvent(new dom.window.Event("visibilitychange"));
		});
	const q = question();
	records.set(7, q);
	connect({ questions: [q] });
	await mount();
	expect(document.title).toBe("neko.harness");
	await setHidden(true);
	expect(document.title).toBe("(1) 等待回答 · neko.harness");
	await setHidden(false);
	expect(document.title).toBe("neko.harness");
	await setHidden(true);
	expect(document.title).toBe("(1) 等待回答 · neko.harness");
	// Settled (the list is empty): restored even while hidden.
	await act(async () => storeActions.setView(chatView({ questions: [] })));
	expect(document.title).toBe("neko.harness");
	// A new question while hidden prefixes again; a gateway without questions never does.
	await act(async () => storeActions.setView(chatView({ questions: [q, question({ id: 8 })] })));
	expect(document.title).toBe("(2) 等待回答 · neko.harness");
	await act(async () => storeActions.setView(chatView({ questions: null })));
	expect(document.title).toBe("neko.harness");
	await setHidden(false);
	// Passive only: no sound, no notification permission.
	expect(notifications).toEqual([]);
	Reflect.deleteProperty(document, "hidden");
});

it("restores the title when the page goes away while the prefix is shown", async () => {
	Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
	const q = question();
	records.set(7, q);
	connect({ questions: [q] });
	await mount();
	expect(document.title).toBe("(1) 等待回答 · neko.harness");
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount();
	});
	expect(document.title).toBe("neko.harness");
	Reflect.deleteProperty(document, "hidden");
});

it("renders the same attention stack at phone, tablet and desktop widths", async () => {
	for (const width of [375, 768, 1440]) {
		document.body.innerHTML = "";
		viewportWidth = width;
		const q = question({ id: 50 + width });
		records.set(q.id, q);
		connect({
			questions: [q],
			todos: { revision: 1, items: [{ id: "a", text: "long ".repeat(80), status: "pending" }] },
		});
		const host = await mount();
		const stack = host.querySelector<HTMLElement>("[data-attention-stack]")!;
		expect(stack.contains(card(host)!)).toBe(true);
		expect(card(host)!.className).toMatch(/max-h-\[min\(42dvh,/);
		// Wide content wraps instead of overflowing sideways.
		expect(card(host)!.querySelector("[data-question-text]")!.className).toContain("break-words");
		// The card never shrinks; the stack scrolls as a last resort and gives way after the todo panel and list.
		expect(host.querySelector("[data-question-dock]")!.className).toContain("shrink-0");
		expect(stack.className).toContain("overflow-y-auto");
		expect(stack.className).toContain("shrink-[0.01]");
		// The top bar keeps the todo entry compact on narrow screens (label hidden below the sm breakpoint).
		const entry = button(host.querySelector("header")!, "待办 0/1，已完成 0 项");
		expect(entry.querySelector(".max-sm\\:hidden")).not.toBeNull();
		// The side list is a drawer on phones: closed by default, so it cannot cover the card.
		expect(Boolean(host.querySelector("aside.sidebar"))).toBe(width > 768);
		await act(async () => {
			for (const root of mounted.splice(0)) root.unmount();
		});
	}
});

it("queues chat typed while a question waits and never reuses it as the answer", async () => {
	const q = question();
	records.set(7, q);
	connect({ questions: [q] });
	const host = await mount();
	const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入"]')!;
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
		setter.call(area, "actually use mysql");
		area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
	expect(host.querySelector("[data-question-hint]")!.textContent).toContain("仍会排队");
	await click(button(host.querySelector('section[aria-label="消息输入"]')!, "排队"));
	expect(submits.map((args) => args[0])).toEqual(["actually use mysql"]);
	expect(responds).toHaveLength(0);
	expect(card(host)).not.toBeNull();
});

const planItem = (version: string) => ({
	type: "tool" as const,
	key: `plan-${version}`,
	callId: `call-plan-${version}`,
	name: "submit_plan",
	summary: "ignored summary",
	detail: null,
	phase: "done" as const,
	isError: false,
	output: null,
	result: "Plan submitted. FREE TEXT THAT MUST NOT BE PARSED",
	durationMs: 5,
	note: null,
	diff: null,
	diffAdded: null,
	diffRemoved: null,
	interaction: {
		kind: "submit_plan" as const,
		version,
		title: "Add a cache layer",
		steps: ["Read", "Write"],
		note: "",
	},
});

it("places the plan card in the attention stack after the question card and before the composer", async () => {
	const q = question();
	records.set(7, q);
	connect({ busy: false, questions: [q], plan: { mode: "plan", current: plan() } });
	const host = await mount();
	const stack = host.querySelector<HTMLElement>("[data-attention-stack]")!;
	const planCard = host.querySelector<HTMLElement>("[data-plan-card]")!;
	const composer = host.querySelector('section[aria-label="消息输入"]')!;
	expect(stack.contains(planCard)).toBe(true);
	expect(before(card(host)!, planCard)).toBe(true);
	expect(before(stack, composer)).toBe(true);
	expect(host.querySelector("[data-plan-mode]")!.textContent).toBe("规划模式（只读）");
});

it("renders submit_plan as a read-only history row and a plan decision as a system notice", async () => {
	connect({
		busy: false,
		plan: { mode: "normal", current: plan({ status: "approved" }) },
		items: [
			planItem("p1"),
			planItem("old"),
			{
				type: "system",
				key: "sys-1",
				id: 9,
				text: "Plan approved: Add a cache layer",
				planDecision: { version: "p1", kind: "approve" },
			},
		] as never,
	});
	const host = await mount();
	const rows = [...host.querySelectorAll<HTMLElement>("[data-plan-row]")];
	expect(rows).toHaveLength(2);
	expect(rows[0]!.dataset.status).toBe("approved");
	expect(rows[0]!.textContent).toContain("Add a cache layer");
	expect([...rows[0]!.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual(["Read", "Write"]);
	expect(rows[0]!.querySelector("button")).toBeNull();
	expect(rows[1]!.dataset.status).toBeUndefined();
	expect(host.querySelector("[data-plan-decision]")!.textContent).toBe("Plan approved: Add a cache layer");
	expect(host.querySelector("[data-plan-card]")).toBeNull();
});

it("labels sessions waiting for plan approval and keeps the answer label distinct", async () => {
	connect({}, [
		sessionSummary("self", { status: "idle", awaitingPlan: true }),
		sessionSummary("other", { status: "idle", awaitingPlan: true, awaitingAnswer: true }),
		sessionSummary("quiet", { status: "idle", awaitingPlan: false }),
		sessionSummary("legacy", { status: "idle" }),
	]);
	const host = await mount();
	const meta = Object.fromEntries(
		[...host.querySelectorAll(".session-copy")].map((copy) => [
			copy.querySelector(".truncate")!.textContent,
			copy.querySelector(".session-meta")!,
		]),
	);
	const waitingPlan = Object.values(meta).filter((el) => el.textContent?.includes("等待批准"));
	expect(waitingPlan).toHaveLength(1);
	expect(waitingPlan[0]!.className).toContain("font-semibold");
	expect(meta.other!.textContent).toContain("等待回答");
	expect(meta.other!.textContent).not.toContain("等待批准");
	expect(meta.quiet!.className).not.toContain("font-semibold");
	expect(meta.legacy!.textContent).not.toContain("等待");
});

it("prefixes the tab title for a waiting plan only while hidden, and restores it after", async () => {
	let hidden = false;
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	const setHidden = (value: boolean) =>
		act(async () => {
			hidden = value;
			document.dispatchEvent(new dom.window.Event("visibilitychange"));
		});
	connect({ busy: false, plan: { mode: "plan", current: plan() } });
	await mount();
	expect(document.title).toBe("neko.harness");
	await setHidden(true);
	expect(document.title).toBe("等待批准 · neko.harness");
	await setHidden(false);
	expect(document.title).toBe("neko.harness");
	await setHidden(true);
	await act(async () =>
		storeActions.setView(chatView({ busy: false, plan: { current: plan({ status: "approved" }) } })),
	);
	expect(document.title).toBe("neko.harness");
	await act(async () =>
		storeActions.setView(chatView({ busy: false, plan: { mode: "plan", current: plan({ version: "p2" }) } })),
	);
	expect(document.title).toBe("等待批准 · neko.harness");
	await act(async () => storeActions.setView(chatView({ busy: false })));
	expect(document.title).toBe("neko.harness");
	Reflect.deleteProperty(document, "hidden");
});
