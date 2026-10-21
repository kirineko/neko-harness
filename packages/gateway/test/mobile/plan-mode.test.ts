import { afterEach, describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PLAN_LIMITS } from "@neko-harness/core/interactions";
import { Check } from "typebox/value";
import { planClient } from "../../src/client-session.ts";
import {
	MOBILE_API_V1_METHODS,
	MOBILE_API_V1_NOTIFICATIONS,
	MOBILE_API_VERSIONS,
	MOBILE_CAPABILITIES,
} from "../../src/mobile/protocol.ts";
import { eventually, type MobileHarness, rpcError, startMobileHarness } from "./harness.ts";

type PlanStatusSummary = { revision: number; pending: boolean; version?: string };
type Attached = { subscriptionId: string; sessionId: string; snapshot: { plan?: PlanStatusSummary } };
type Plan = { version: string; title: string; steps: string[]; status: string; feedback: string | null };
type Patch = { upserts: Array<{ type: string; text?: string }>; status?: { plan?: PlanStatusSummary } };
type HistoryItem = { tool?: { name: string; interaction?: unknown } };
type SessionList = { sessions: Array<{ id: string; awaitingPlan?: boolean }> };

const plan = { title: "Add flag", steps: ["Read the config", "Add the flag"], note: "Keep defaults." };
const submitRound = () => fauxAssistantMessage([fauxToolCall("submit_plan", plan as never)], { stopReason: "toolUse" });
const ok = (method: string, value: unknown) =>
	expect(Check(MOBILE_API_V1_METHODS[method]?.result as never, value)).toBe(true);

let harness: MobileHarness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

async function openPhone() {
	harness = await startMobileHarness();
	const device = await harness.pair();
	const phone = await harness.connect(device);
	const sessionId = String(harness.gateway.runtime.root.id);
	const desktop = await harness.desktop();
	const chat = await desktop.attach(sessionId);
	return { device, phone, sessionId, chat };
}

async function workspace(): Promise<string> {
	return (await harness!.gateway.runtime.listWorkspaces())[0]!.path;
}

/** Plan mode is entered on the desktop; the phone only observes and decides. */
async function awaitPlan() {
	const opened = await openPhone();
	harness!.faux.setResponses([submitRound(), fauxAssistantMessage([fauxText("executing")])]);
	await planClient(opened.chat).setMode("plan");
	const attached = await opened.phone.call<Attached>("chat.attach", { sessionId: opened.sessionId });
	const { subscriptionId } = attached;
	await opened.phone.call("chat.submit", { subscriptionId, requestId: "p-1", text: "add a flag" });
	const notice = await opened.phone.notification("plan.changed", () => true);
	expect(Check(MOBILE_API_V1_NOTIFICATIONS["plan.changed"] as never, notice)).toBe(true);
	const patch = await opened.phone.notification("chat.patch", (p) => (p as Patch).status?.plan?.pending === true);
	const summary = (patch as unknown as Patch).status!.plan!;
	expect(summary.revision).toBeGreaterThan(attached.snapshot.plan!.revision);
	await eventually(() => opened.chat.view.value?.busy === false, "run ended");
	return { ...opened, subscriptionId, version: summary.version! };
}

describe("mobile plan approval", () => {
	it("declares the capability without raising the api version", () => {
		expect(MOBILE_CAPABILITIES).toContain("plan");
		expect(MOBILE_API_VERSIONS).toEqual([1]);
	});

	it("reports a supported-and-empty summary on attach and finds no plan", async () => {
		const { phone, sessionId } = await openPhone();
		const attached = await phone.call<Attached>("chat.attach", { sessionId });
		ok("chat.attach", attached);
		expect(attached.snapshot.plan).toEqual({ revision: 0, pending: false });
		expect(await rpcError(phone.call("plan.get", { subscriptionId: attached.subscriptionId, version: "none" }))).toBe(
			"not_found",
		);
		const sessions = await phone.call<SessionList>("sessions.list", { workspace: await workspace() });
		ok("sessions.list", sessions);
		expect(sessions.sessions.find((s) => s.id === sessionId)?.awaitingPlan).toBe(false);
	}, 30_000);

	it("shows a waiting plan, flags the session and starts execution after the phone approves", async () => {
		const { phone, chat, sessionId, subscriptionId, version } = await awaitPlan();
		const waiting = await phone.call<Plan>("plan.get", { subscriptionId, version });
		ok("plan.get", waiting);
		expect(waiting).toMatchObject({ ...plan, status: "awaiting_approval", feedback: null });
		await eventually(async () => {
			const list = await phone.call<SessionList>("sessions.list", { workspace: await workspace() });
			return list.sessions.find((s) => s.id === sessionId)?.awaitingPlan === true;
		}, "awaitingPlan in the session list");

		const decided = await phone.call<Plan>("plan.respond", { subscriptionId, version, decision: { kind: "approve" } });
		ok("plan.respond", decided);
		expect(decided.status).toBe("approved");
		await phone.notification("chat.patch", (p) =>
			(p as Patch).upserts.some((i) => i.type === "assistant" && i.text === "executing"),
		);
		expect(chat.view.value?.plan?.mode).toBe("normal");
		await eventually(async () => {
			const list = await phone.call<SessionList>("sessions.list", { workspace: await workspace() });
			return list.sessions.find((s) => s.id === sessionId)?.awaitingPlan === false;
		}, "awaitingPlan cleared");
		const history = await phone.call<{ snapshot: { plan?: PlanStatusSummary; items: Array<HistoryItem> } }>(
			"chat.attach",
			{
				sessionId,
			},
		);
		expect(history.snapshot.plan).toMatchObject({ pending: false, version });
		expect(history.snapshot.items.find((i) => i.tool?.name === "submit_plan")?.tool?.interaction).toMatchObject({
			kind: "submit_plan",
			version,
			steps: plan.steps,
		});
	}, 40_000);

	it("returns the saved winner for a competing desktop decision or a retry and rejects bad requests", async () => {
		const { phone, chat, subscriptionId: live, version } = await awaitPlan();
		const won = await chat.planRespond({
			version: version!,
			decision: { kind: "revise", feedback: "narrower please" },
		});
		const late = await phone.call<Plan>("plan.respond", {
			subscriptionId: live,
			version,
			decision: { kind: "approve" },
		});
		const retry = await phone.call<Plan>("plan.respond", {
			subscriptionId: live,
			version,
			decision: { kind: "approve" },
		});
		expect(late).toEqual(won);
		expect(retry).toEqual(won);
		expect(late.status).toBe("revision_requested");
		expect(late.feedback).toBe("narrower please");
		expect(chat.view.value?.plan?.mode).toBe("plan");
		await eventually(() => chat.view.value?.busy === false, "revision run finished");

		expect(
			await rpcError(
				phone.call("plan.respond", { subscriptionId: live, version: "stale", decision: { kind: "approve" } }),
			),
		).toBe("rejected");
		for (const decision of [
			{ kind: "revise" },
			{ kind: "revise", feedback: "" },
			{ kind: "revise", feedback: "x".repeat(PLAN_LIMITS.feedbackChars + 1) },
			{ kind: "approve", feedback: "extra" },
			{ kind: "unknown" },
		]) {
			expect(await rpcError(phone.call("plan.respond", { subscriptionId: live, version, decision }))).toBe(
				"invalid_params",
			);
		}
		expect(
			await rpcError(phone.call("plan.respond", { subscriptionId: live, version: "", decision: { kind: "approve" } })),
		).toBe("invalid_params");
		expect(await rpcError(phone.call("plan.get", { subscriptionId: "chat-unknown", version }))).toBe("gone");
	}, 40_000);

	it("has no way to enter plan mode", async () => {
		const { phone, chat, subscriptionId } = await awaitPlan();
		for (const method of ["plan.mode", "plan.setMode", "plan.enter"]) {
			expect(Object.keys(MOBILE_API_V1_METHODS)).not.toContain(method);
			expect(await rpcError(phone.call(method, { subscriptionId, mode: "plan" }))).toBe("not_found");
		}
		expect(await rpcError(phone.call("plan.exit", {}))).toBe("invalid_params");
		expect(chat.view.value?.plan?.mode).toBe("plan");
		await chat.abort(null);
	}, 40_000);

	it("exits plan mode from the phone, cancelling the waiting plan, and is idempotent", async () => {
		const { phone, chat, sessionId, subscriptionId, version } = await awaitPlan();
		const exited = await phone.call<{ mode: string; revision: number }>("plan.exit", { subscriptionId });
		ok("plan.exit", exited);
		expect(exited.mode).toBe("normal");
		const notice = await phone.notification("plan.changed", () => true);
		expect(Check(MOBILE_API_V1_NOTIFICATIONS["plan.changed"] as never, notice)).toBe(true);
		expect(chat.view.value?.plan?.mode).toBe("normal");
		const record = await phone.call<Plan>("plan.get", { subscriptionId, version });
		expect(record.status).toBe("cancelled");
		await eventually(async () => {
			const list = await phone.call<SessionList>("sessions.list", { workspace: await workspace() });
			return list.sessions.find((s) => s.id === sessionId)?.awaitingPlan === false;
		}, "awaitingPlan cleared");
		const again = await phone.call<{ mode: string; revision: number }>("plan.exit", { subscriptionId });
		ok("plan.exit", again);
		expect(again.mode).toBe("normal");
	}, 40_000);

	it("rejects plan.exit for a stale subscription and while the session is running", async () => {
		const { phone, chat, subscriptionId: live } = await awaitPlan();
		expect(await rpcError(phone.call("plan.exit", { subscriptionId: "chat-unknown" }))).toBe("gone");
		harness!.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user", { question: "Wait?" } as never)], { stopReason: "toolUse" }),
		]);
		await phone.call("chat.submit", { subscriptionId: live, requestId: "p-2", text: "more" });
		await eventually(() => chat.view.value?.busy === true, "running");
		const outcome = await rpcError(phone.call("plan.exit", { subscriptionId: live }));
		expect(outcome).toBe("rejected");
		await chat.abort(null);
		await eventually(() => chat.view.value?.busy === false, "stopped");
	}, 40_000);

	it("rejects an old subscription after switching sessions and never shows another session's plan", async () => {
		const { phone, chat, subscriptionId: first, version } = await awaitPlan();
		const created = await phone.call<{ id: string }>("sessions.create", { workspace: await workspace() });
		const second = await phone.call<Attached>("chat.attach", { sessionId: created.id });
		expect(second.snapshot.plan).toEqual({ revision: 0, pending: false });
		expect(await rpcError(phone.call("plan.get", { subscriptionId: first, version }))).toBe("gone");
		expect(await rpcError(phone.call("plan.get", { subscriptionId: second.subscriptionId, version }))).toBe(
			"not_found",
		);
		expect(
			await rpcError(phone.call("plan.respond", { subscriptionId: first, version, decision: { kind: "approve" } })),
		).toBe("gone");
		expect(
			await rpcError(
				phone.call("plan.respond", { subscriptionId: second.subscriptionId, version, decision: { kind: "approve" } }),
			),
		).toBe("rejected");
		expect((await chat.planGet({ version }))?.status).toBe("awaiting_approval");
		await chat.abort(null);
	}, 40_000);

	it("refuses reads and decisions once the device is revoked", async () => {
		const { device, phone, chat, version } = await awaitPlan();
		expect(await harness!.gateway.mobile.revoke(device.deviceId)).toBe(true);
		expect((await phone.ws.waitForClose()).code).toBe(4401);
		expect((await chat.planGet({ version }))?.status).toBe("awaiting_approval");
		await chat.abort(null);
	}, 40_000);

	it("sends a change notice with the cancelled status when the desktop stops the session", async () => {
		const { phone, chat, subscriptionId, version } = await awaitPlan();
		await chat.abort(null);
		const notice = await phone.notification("plan.changed", () => true);
		expect(Check(MOBILE_API_V1_NOTIFICATIONS["plan.changed"] as never, notice)).toBe(true);
		const record = await phone.call<Plan>("plan.get", { subscriptionId, version });
		expect(record.status).toBe("cancelled");
		const late = await phone.call<Plan>("plan.respond", { subscriptionId, version, decision: { kind: "approve" } });
		expect(late.status).toBe("cancelled");
	}, 40_000);
});
