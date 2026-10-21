import { afterEach, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { PLAN_UNSUPPORTED, planClient } from "../src/client-session.ts";
import {
	ChatViewSchema,
	DirectoryStateSchema,
	type NekoChat,
	PlanRecordSchema,
	PlanViewSchema,
} from "../src/contract.ts";
import { cleanup, connectTestClient, makeGateway, waitFor } from "./helpers.ts";
import { eventually, type MobileHarness, startMobileHarness } from "./mobile/harness.ts";

const plan = { title: "Add flag", steps: ["Read the config", "Add the flag"], note: "Keep defaults." };
const submitRound = (args: Record<string, unknown> = plan) =>
	fauxAssistantMessage([fauxToolCall("submit_plan", args as never)], { stopReason: "toolUse" });
const current = (chat: NekoChat) => chat.view.value?.plan?.current ?? null;
const users = (chat: NekoChat) => chat.view.value?.items.flatMap((i) => (i.type === "user" ? [i.text] : [])) ?? [];

it("publishes plan mode as an optional supported field and keeps the schemas valid", async () => {
	const target = await makeGateway();
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(String(target.gateway.runtime.root.id));
		expect(chat.view.value?.plan).toEqual({ mode: "normal", revision: 0, current: null });
		expect(Value.Check(ChatViewSchema, chat.view.value)).toBe(true);
		expect(planClient(chat).supported).toBe(true);
		const { plan: _plan, ...old } = chat.view.value!;
		expect(Value.Check(ChatViewSchema, old)).toBe(true);
		expect(Value.Check(DirectoryStateSchema, client.directory.state.value)).toBe(true);
		expect(client.directory.state.value?.sessions[0]?.awaitingPlan).toBe(false);
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 30_000);

it("shares mode and plan with every client, settles competing decisions once and starts execution", async () => {
	const target = await makeGateway();
	target.faux.setResponses([submitRound(), fauxAssistantMessage([fauxText("executing")])]);
	const id = String(target.gateway.runtime.root.id);
	const a = await connectTestClient(target);
	const b = await connectTestClient(target);
	try {
		const chatA = await a.attach(id);
		const chatB = await b.attach(id);
		const entered = await planClient(chatA).setMode("plan");
		expect(Value.Check(PlanViewSchema, entered)).toBe(true);
		await waitFor(() => chatB.view.value?.plan?.mode === "plan", "plan mode on both clients");
		await chatA.submit({ content: "add a flag" });
		await waitFor(
			() => current(chatA)?.status === "awaiting_approval" && current(chatB)?.status === "awaiting_approval",
			"plan",
		);
		await waitFor(() => chatA.view.value?.busy === false, "run ended");
		const summary = current(chatA)!;
		expect(summary).toMatchObject({ ...plan, feedback: null });
		await waitFor(() => a.directory.state.value?.sessions[0]?.awaitingPlan === true, "awaitingPlan in the directory");
		expect(a.directory.state.value?.sessions[0]?.status).toBe("idle");
		const tool = chatA.view.value!.items.find((i) => i.type === "tool" && i.name === "submit_plan");
		expect(tool).toMatchObject({ interaction: { kind: "submit_plan", version: summary.version, steps: plan.steps } });
		const record = await chatB.planGet({ version: summary.version });
		expect(Value.Check(PlanRecordSchema, record)).toBe(true);

		const outcomes = await Promise.all([
			chatA.planRespond({ version: summary.version, decision: { kind: "approve" } }),
			chatB.planRespond({ version: summary.version, decision: { kind: "revise", feedback: "no thanks" } }),
		]);
		expect(outcomes[0]).toEqual(outcomes[1]);
		const winner = outcomes[0].status;
		expect(["approved", "revision_requested"]).toContain(winner);
		await waitFor(
			() => chatA.view.value?.items.some((i) => i.type === "system" && !!i.planDecision) === true,
			"decision record",
		);
		expect(users(chatA)).toEqual(["add a flag"]);
		expect(chatB.view.value?.plan?.mode).toBe(winner === "approved" ? "normal" : "plan");
		await waitFor(() => a.directory.state.value?.sessions[0]?.awaitingPlan === false, "awaitingPlan cleared");
	} finally {
		await a.close();
		await b.close();
		await cleanup(target);
	}
}, 40_000);

it("cancels a waiting plan on stop and rejects wrong identities, versions and busy switches", async () => {
	const target = await makeGateway();
	target.faux.setResponses([submitRound(), fauxAssistantMessage([fauxText("ok")])]);
	const id = String(target.gateway.runtime.root.id);
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(id);
		await planClient(chat).setMode("plan");
		await chat.submit({ content: "plan" });
		await waitFor(() => current(chat)?.status === "awaiting_approval" && chat.view.value?.busy === false, "plan");
		const summary = current(chat)!;
		const other = await client.management.create({});
		const otherChat = await client.attach(other.id);
		expect(await otherChat.planGet({ version: summary.version })).toBeNull();
		await expect(otherChat.planRespond({ version: summary.version, decision: { kind: "approve" } })).rejects.toThrow(
			/not found/,
		);
		const again = await client.attach(id);
		await expect(again.planRespond({ version: "stale", decision: { kind: "approve" } })).rejects.toThrow(/not found/);
		await again.abort(null);
		const late = await again.planRespond({ version: summary.version, decision: { kind: "approve" } });
		expect(late.status).toBe("cancelled");
		expect(again.view.value?.plan?.mode).toBe("plan");
		expect(users(again)).toEqual(["plan"]);
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("reports an unsupported gateway through the client", async () => {
	const fake = { view: { value: { items: [] } } } as unknown as NekoChat;
	const client = planClient(fake);
	expect(client.supported).toBe(false);
	await expect(client.setMode("plan")).rejects.toThrow(PLAN_UNSUPPORTED);
	await expect(client.get("x")).rejects.toThrow(PLAN_UNSUPPORTED);
});

let harness: MobileHarness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

it("keeps plan mode and a waiting plan across a gateway restart, then approves and executes once", async () => {
	harness = await startMobileHarness({ storage: "sqlite" });
	harness.faux.setResponses([submitRound(), fauxAssistantMessage([fauxText("executing")])]);
	const sessionId = String(harness.gateway.runtime.root.id);
	let desktop = await harness.desktop();
	let chat = await desktop.attach(sessionId);
	await planClient(chat).setMode("plan");
	await chat.submit({ content: "add a flag" });
	await eventually(() => current(chat)?.status === "awaiting_approval" && chat.view.value?.busy === false, "plan");
	const before = current(chat)!;

	await harness.restart();
	desktop = await harness.desktop();
	chat = await desktop.attach(sessionId);
	await eventually(() => current(chat)?.version === before.version, "plan after restart");
	expect(chat.view.value?.plan).toMatchObject({ mode: "plan", current: { status: "awaiting_approval" } });
	await eventually(
		() => desktop.directory.state.value?.sessions.find((s) => s.id === sessionId)?.awaitingPlan === true,
		"awaitingPlan after restart",
	);

	const approved = await chat.planRespond({ version: before.version, decision: { kind: "approve" } });
	expect(approved.status).toBe("approved");
	await eventually(
		() => chat.view.value?.items.some((i) => i.type === "assistant" && i.text === "executing") === true,
		"execution answer",
	);
	expect(chat.view.value?.plan?.mode).toBe("normal");
	expect(users(chat)).toEqual(["add a flag"]);
	// A second approval after the settlement changes nothing.
	expect((await chat.planRespond({ version: before.version, decision: { kind: "approve" } })).status).toBe("approved");
	expect(chat.view.value?.items.filter((i) => i.type === "system" && !!i.planDecision)).toHaveLength(1);
}, 60_000);
