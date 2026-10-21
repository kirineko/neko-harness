import { expect, it } from "bun:test";
import { sessionStatusText } from "../src/client/lib/interactions.ts";
import {
	attentionTitle,
	decisionStatus,
	planCommandArgs,
	planErrorText,
	planSettlementText,
	planState,
	planStatusLabel,
} from "../src/client/lib/plan-ui.ts";
import { chatView, plan } from "./support/interaction-fixtures.ts";

const source = (
	view: ReturnType<typeof chatView> | null,
	phase: "ready" | "reconnecting" = "ready",
	operating = false,
) => ({ view, phase, operating }) as Parameters<typeof planState>[0];

it("derives the plan state from the view, and reports an old gateway as null", () => {
	expect(planState(source(chatView()))).toBeNull();
	expect(planState(source(null))).toBeNull();
	const idle = planState(source(chatView({ plan: {} })))!;
	expect(idle).toEqual({ mode: "normal", current: null, awaiting: null, online: true });
	const waiting = planState(source(chatView({ plan: { mode: "plan", current: plan() } })))!;
	expect(waiting.mode).toBe("plan");
	expect(waiting.awaiting?.version).toBe("p1");
	const settled = planState(source(chatView({ plan: { current: plan({ status: "approved" }) } })))!;
	expect(settled.awaiting).toBeNull();
	expect(settled.current?.status).toBe("approved");
	expect(planState(source(chatView({ plan: {} }), "reconnecting"))!.online).toBe(false);
	expect(planState(source(chatView({ plan: {} }), "ready", true))!.online).toBe(false);
});

it("parses the /plan command and its stray arguments", () => {
	expect(planCommandArgs("/plan")).toBe("");
	expect(planCommandArgs("  /plan \n")).toBe("");
	expect(planCommandArgs("/plan now")).toBe("now");
	expect(planCommandArgs("/planning")).toBeNull();
	expect(planCommandArgs("please /plan")).toBeNull();
	expect(planCommandArgs("/compact")).toBeNull();
});

it("labels sessions waiting for approval, with a question taking precedence", () => {
	expect(sessionStatusText({ status: "idle", awaitingPlan: true })).toBe(" · 等待批准");
	expect(sessionStatusText({ status: "running", awaitingPlan: true, awaitingAnswer: true })).toBe(" · 等待回答");
	expect(sessionStatusText({ status: "idle", awaitingPlan: false })).toBe("");
	expect(sessionStatusText({ status: "error" })).toBe(" · 出错");
});

it("builds the hidden-tab title for questions, plans, and both", () => {
	expect(attentionTitle("neko", 0, true)).toBe("等待批准 · neko");
	expect(attentionTitle("neko", 2, true)).toBe("(2) 等待回答 · 等待批准 · neko");
	expect(attentionTitle("neko", 1, false)).toBe("(1) 等待回答 · neko");
	expect(attentionTitle("neko", 0, false)).toBe("neko");
});

it("explains what the saved record means for the user", () => {
	expect(planSettlementText(plan({ status: "approved" }), true)).toContain("已批准");
	expect(planSettlementText(plan({ status: "revision_requested" }), true)).toContain("修改");
	expect(planSettlementText(plan({ status: "revision_requested" }), false)).toContain(
		planStatusLabel("revision_requested"),
	);
	expect(planSettlementText(plan({ status: "superseded" }), false)).toContain("取代");
	expect(planSettlementText(plan({ status: "cancelled" }), false)).toContain("取消");
	expect(decisionStatus("approve")).toBe("approved");
	expect(decisionStatus("revise")).toBe("revision_requested");
});

it("translates the busy code and passes other errors through", () => {
	expect(planErrorText(new Error("PLAN_BUSY: Wait for the current run to finish or stop it first."))).toContain(
		"运行中",
	);
	expect(planErrorText(new Error("boom"))).toBe("boom");
	expect(planErrorText("plain")).toBe("plain");
});
