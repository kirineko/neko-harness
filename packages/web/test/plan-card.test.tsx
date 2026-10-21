import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type { PlanRecord } from "@neko-harness/core/interactions";
import { JSDOM } from "jsdom";
import * as React from "react";
import { chatView, plan } from "./support/interaction-fixtures.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	localStorage: dom.window.localStorage,
	sessionStorage: dom.window.sessionStorage,
	HTMLElement: dom.window.HTMLElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

type Respond = { version: string; decision: { kind: "approve" } | { kind: "revise"; feedback: string } };
const responds: [string, Respond][] = [];
const submits: unknown[][] = [];
const modes: [string, string][] = [];
let modeImpl: () => Promise<unknown> = async () => ({});
let respondImpl: (sessionId: string, input: Respond) => Promise<PlanRecord>;
mock.module("../src/client/lib/bootstrap", () => ({
	appActions: {
		submit: async (...args: unknown[]) => void submits.push(args),
		planRespond: (sessionId: string, input: Respond) => {
			responds.push([sessionId, input]);
			return respondImpl(sessionId, input);
		},
		planMode: (...args: [string, string]) => {
			modes.push(args);
			return modeImpl();
		},
		planGet: async () => null,
	},
	reportError: () => {},
}));

const { createRoot } = await import("react-dom/client");
const { act } = React;
const { PlanDock } = await import("../src/client/components/plan-card.tsx");
const { storeActions } = await import("../src/client/lib/store.ts");

let sessions = 0;
function connect(current: PlanRecord | null, mode: "normal" | "plan" = "plan") {
	const id = `plan-card-session-${++sessions}`;
	act(() => {
		storeActions.setPhase("ready");
		storeActions.setSession(id);
		storeActions.setView(chatView({ busy: false, plan: { mode, current } }));
	});
	return id;
}
const mounted: { unmount(): void }[] = [];
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push(root);
	await act(async () => root.render(React.createElement(PlanDock)));
	return host;
}
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
const button = (host: ParentNode, label: string) =>
	[...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
const card = (host: ParentNode) => host.querySelector<HTMLElement>("[data-plan-card]");
const fill = (area: HTMLTextAreaElement, text: string) =>
	act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, text);
		area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});

beforeEach(() => {
	document.body.innerHTML = "";
	responds.length = 0;
	submits.length = 0;
	modes.length = 0;
	modeImpl = async () => ({});
	respondImpl = async (_session, input) =>
		plan({
			status: input.decision.kind === "approve" ? "approved" : "revision_requested",
			feedback: input.decision.kind === "revise" ? input.decision.feedback : null,
			settledAt: 2000,
		});
});
afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount();
	});
	storeActions.setView(null);
	storeActions.setSession(null);
});

it("shows a plain title and renders steps and note as sanitized Markdown for a waiting plan only", async () => {
	connect(
		plan({
			title: "<b>bold</b> title",
			steps: ["run `bun test` now", "**two** <script>alert(1)</script>"],
			note: "**Assumption**: small.\n\n- risk one\n- risk two\u202e",
		}),
	);
	const host = await mount();
	expect(card(host)).not.toBeNull();
	expect(host.querySelector("script")).toBeNull();
	expect(host.querySelector("[data-plan-title]")!.textContent).toBe("<b>bold</b> title");
	expect(host.querySelector("[data-plan-title] b")).toBeNull();
	const steps = [...host.querySelectorAll("[data-plan-steps] > li")];
	expect(steps.map((li) => li.textContent?.trim())).toEqual(["run bun test now", "two"]);
	expect(steps[0]!.querySelector("code")!.textContent).toBe("bun test");
	expect(steps[1]!.querySelector("strong")!.textContent).toBe("two");
	expect(host.querySelector("[data-plan-steps]")!.tagName).toBe("OL");
	const note = host.querySelector("[data-plan-note]")!;
	expect(note.querySelector("strong")!.textContent).toBe("Assumption");
	expect([...note.querySelectorAll("li")].map((li) => li.textContent?.trim())).toEqual(["risk one", "risk two\u202e"]);
	expect(button(host, "批准并执行")).toBeDefined();
	expect(button(host, "要求修改")).toBeDefined();

	await act(async () => storeActions.setView(chatView({ plan: { current: plan({ status: "approved" }) } })));
	expect(card(host)).toBeNull();
});

it("renders nothing without a plan or on an old gateway", async () => {
	connect(null);
	const host = await mount();
	expect(host.innerHTML).toBe("");
	await act(async () => storeActions.setView(chatView({})));
	expect(host.innerHTML).toBe("");
});

it("approves without a chat submit and reports the saved status", async () => {
	const id = connect(plan());
	const host = await mount();
	await click(button(host, "批准并执行"));
	expect(responds).toEqual([[id, { version: "p1", decision: { kind: "approve" } }]]);
	expect(submits).toEqual([]);
	expect(host.querySelector("[data-plan-notice]")!.textContent).toContain("已批准");
});

it("disables both buttons while the request is in flight", async () => {
	connect(plan());
	let release!: (record: PlanRecord) => void;
	respondImpl = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	const host = await mount();
	await click(button(host, "批准并执行"));
	expect(button(host, "提交中…").hasAttribute("disabled")).toBe(true);
	expect(button(host, "要求修改").hasAttribute("disabled")).toBe(true);
	await click(button(host, "提交中…"));
	expect(responds).toHaveLength(1);
	await act(async () => release(plan({ status: "approved", settledAt: 2 })));
	expect(host.querySelector("[data-plan-notice]")).not.toBeNull();
});

it("asks for changes with feedback bounded to 1..2000 characters", async () => {
	const id = connect(plan());
	const host = await mount();
	await click(button(host, "要求修改"));
	const area = host.querySelector<HTMLTextAreaElement>("textarea")!;
	expect(area.maxLength).toBe(2000);
	expect(button(host, "提交修改意见").hasAttribute("disabled")).toBe(true);
	await fill(area, "   ");
	expect(button(host, "提交修改意见").hasAttribute("disabled")).toBe(true);
	await click(button(host, "取消"));
	expect(host.querySelector("textarea")).toBeNull();
	expect(responds).toHaveLength(0);
	await click(button(host, "要求修改"));
	await fill(host.querySelector("textarea")!, "  split step 2  ");
	await click(button(host, "提交修改意见"));
	expect(responds).toEqual([[id, { version: "p1", decision: { kind: "revise", feedback: "split step 2" } }]]);
	expect(host.querySelector("[data-plan-notice]")!.textContent).toContain("修改");
});

it("shows the real status when another client decided first", async () => {
	connect(plan());
	respondImpl = async () => plan({ status: "revision_requested", feedback: "other", settledAt: 3 });
	const host = await mount();
	await click(button(host, "批准并执行"));
	const text = host.querySelector("[data-plan-notice]")!.textContent!;
	expect(text).toContain("其他端先处理");
	expect(text).toContain("要求修改");
	expect(text).not.toContain("已批准");
});

it("shows a superseded plan as superseded, not as a success", async () => {
	connect(plan());
	respondImpl = async () => plan({ status: "superseded", settledAt: 3 });
	const host = await mount();
	await click(button(host, "批准并执行"));
	expect(host.querySelector("[data-plan-notice]")!.textContent).toContain("取代");
});

it("keeps the card and the feedback draft, with an inline error, when the request fails", async () => {
	connect(plan());
	respondImpl = async () => {
		throw new Error("PLAN_BUSY: Wait for the current run to finish or stop it first.");
	};
	const host = await mount();
	await click(button(host, "要求修改"));
	await fill(host.querySelector("textarea")!, "tweak");
	await click(button(host, "提交修改意见"));
	expect(host.querySelector('[role="alert"]')!.textContent).toContain("运行中");
	expect(host.querySelector("textarea")!.value).toBe("tweak");
	expect(button(host, "提交修改意见").hasAttribute("disabled")).toBe(false);
});

it("explains a plan that left the waiting state without this tab deciding", async () => {
	connect(plan());
	const host = await mount();
	expect(card(host)).not.toBeNull();
	await act(async () =>
		storeActions.setView(chatView({ plan: { mode: "normal", current: plan({ status: "approved", settledAt: 5 }) } })),
	);
	expect(card(host)).toBeNull();
	expect(host.querySelector("[data-plan-notice]")!.textContent).toContain("已批准");
});

it("disables deciding while offline", async () => {
	connect(plan());
	const host = await mount();
	await act(async () => storeActions.setPhase("reconnecting"));
	expect(button(host, "批准并执行").hasAttribute("disabled")).toBe(true);
	expect(host.textContent).toContain("离线");
});

it("offers cancel-and-exit only while a plan is waiting, and calls planMode normal", async () => {
	const id = connect(plan());
	const host = await mount();
	await click(button(host, "要求修改"));
	expect([...host.querySelectorAll("button")].some((b) => b.textContent === "取消并退出计划模式")).toBe(false);
	await click(button(host, "取消"));
	await click(button(host, "取消并退出计划模式"));
	expect(modes).toEqual([[id, "normal"]]);
	expect(responds).toEqual([]);
	await act(async () =>
		storeActions.setView(chatView({ plan: { mode: "normal", current: plan({ status: "cancelled" }) } })),
	);
	expect(card(host)).toBeNull();
	expect(host.textContent).toContain("已不在等待批准");
});

it("does not render cancel-and-exit without a waiting plan", async () => {
	connect(plan({ status: "approved" }));
	const host = await mount();
	expect(host.textContent).not.toContain("取消并退出计划模式");
});

it("blocks double-firing while leaving plan mode", async () => {
	connect(plan());
	let release!: () => void;
	modeImpl = () =>
		new Promise((resolve) => {
			release = () => resolve({});
		});
	const host = await mount();
	await click(button(host, "取消并退出计划模式"));
	expect(button(host, "处理中…").hasAttribute("disabled")).toBe(true);
	expect(button(host, "批准并执行").hasAttribute("disabled")).toBe(true);
	await click(button(host, "批准并执行"));
	expect(responds).toHaveLength(0);
	await act(async () => release());
	expect(button(host, "取消并退出计划模式").hasAttribute("disabled")).toBe(false);
});

it("shows an inline error and keeps the card when leaving plan mode fails", async () => {
	connect(plan());
	modeImpl = async () => {
		throw new Error("PLAN_BUSY: Wait");
	};
	const host = await mount();
	await click(button(host, "取消并退出计划模式"));
	expect(host.querySelector('[role="alert"]')!.textContent).toContain("退出失败");
	expect(host.querySelector('[role="alert"]')!.textContent).toContain("运行中");
	expect(card(host)).not.toBeNull();
});

it("disables cancel-and-exit while offline", async () => {
	connect(plan());
	const host = await mount();
	await act(async () => storeActions.setPhase("reconnecting"));
	expect(button(host, "取消并退出计划模式").hasAttribute("disabled")).toBe(true);
});
