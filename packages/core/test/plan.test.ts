import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { PlanDoc } from "../src/plan.ts";
import { projectChatView } from "../src/projection.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";

const model = { provider: "faux", modelId: "faux-1" };
type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const plan1 = { title: "Add flag", steps: ["Read the config", "Add the flag"], note: "Keep defaults." };
const open = (faux: ReturnType<typeof fauxProvider>, extra: Record<string, unknown> = {}) =>
	createNekoRuntime({ storage: "memory", providers: [faux.provider], model, ...extra });

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what = "state"): Promise<T> {
	const end = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}
const toolNames = async (runtime: NekoRuntime, id?: number) => {
	const target =
		id === undefined ? runtime.conversation : (await runtime.harness.conversation(id as never, runtime.context))!;
	return (await target.agent(runtime.context)).tools.map((t) => t.name);
};
const entries = async (runtime: NekoRuntime) =>
	(await runtime.conversation.entries({ order: "ascending" }, 500, undefined, runtime.context)).items;
const userTexts = async (runtime: NekoRuntime) =>
	(await entries(runtime))
		.flatMap((entry) => entry.model ?? [])
		.flatMap((m) =>
			m.role === "user"
				? [typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("")]
				: [],
		);
const toolResults = async (runtime: NekoRuntime) =>
	(await entries(runtime)).flatMap((entry) => entry.model ?? []).flatMap((m) => (m.role === "toolResult" ? [m] : []));
const resultText = (m: { content: { type: string; text?: string }[] }) => m.content.map((c) => c.text ?? "").join("");
const awaitingPlan = async (runtime: NekoRuntime, session = runtime.root) => {
	const view = await until(
		() => session.plan(),
		(v) => v.current?.status === "awaiting_approval",
		"a plan awaiting approval",
	);
	return view.current!;
};

it("plans read-only, submits, then approves into one execute input with the tools restored", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		call("bash", { command: "echo planned > plan-test-output.txt" }),
		call("bash", { command: "echo planbash" }),
		call("edit", { path: "x", edits: [] }),
		call("submit_plan", plan1),
		fauxAssistantMessage("Executing."),
	]);
	const runtime = await open(faux);
	try {
		expect(await toolNames(runtime)).not.toContain("submit_plan");
		expect(await toolNames(runtime)).toContain("edit");
		const entered = await runtime.root.setPlanMode("plan");
		expect(entered).toMatchObject({ mode: "plan", current: null });
		const planTools = await toolNames(runtime);
		expect(planTools).toContain("submit_plan");
		expect(planTools).toContain("bash");
		for (const name of ["edit", "write", "job"]) expect(planTools).not.toContain(name);

		const job = await runtime.submit("plan the flag");
		await runtime.waitAnswer(job).catch(() => {});
		const plan = await awaitingPlan(runtime);
		expect(plan).toMatchObject({ ...plan1, status: "awaiting_approval", feedback: null });
		const results = await toolResults(runtime);
		expect(results[0]!.isError).toBe(true);
		expect(resultText(results[0]!)).toContain("read-only");
		expect(resultText(results[1]!)).toContain("planbash");
		expect(results[2]!.isError).toBe(true);
		expect(await Bun.file("plan-test-output.txt").exists()).toBe(false);
		expect((await runtime.root.plan()).mode).toBe("plan");

		const settled = await runtime.root.respondPlan(plan.version, { kind: "approve" });
		expect(settled).toMatchObject({ status: "approved", version: plan.version });
		const again = await runtime.root.respondPlan(plan.version, { kind: "approve" });
		expect(again).toMatchObject({ status: "approved" });
		await until(
			() => userTexts(runtime),
			(texts) => texts.length === 2,
			"the execute input",
		);
		await Bun.sleep(100);
		const texts = await userTexts(runtime);
		expect(texts).toHaveLength(2);
		expect(texts[1]).toContain('approved your plan "Add flag"');
		expect(texts[1]).toContain("2. Add the flag");
		expect(await runtime.root.plan()).toMatchObject({ mode: "normal", current: { status: "approved" } });
		const tools = await toolNames(runtime);
		expect(tools).toContain("edit");
		expect(tools).not.toContain("submit_plan");
	} finally {
		await runtime.close();
	}
});

it("keeps plan mode for changes, supersedes the old version and rejects its late decision", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		call("submit_plan", plan1),
		call("submit_plan", { ...plan1, title: "Add flag v2", steps: ["Read", "Split step", "Add"] }),
		fauxAssistantMessage("done"),
	]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("plan")).catch(() => {});
		const first = await awaitingPlan(runtime);
		const revised = await runtime.root.respondPlan(first.version, { kind: "revise", feedback: "Split step 2" });
		expect(revised).toMatchObject({ status: "revision_requested", feedback: "Split step 2" });
		const second = await until(
			() => runtime.root.plan(),
			(v) => v.current?.version !== first.version && v.current?.status === "awaiting_approval",
			"the revised plan",
		);
		expect(second.mode).toBe("plan");
		expect(second.current).toMatchObject({ title: "Add flag v2" });
		const texts = await userTexts(runtime);
		expect(texts[1]).toContain("Split step 2");
		expect(texts[1]).toContain("still in plan mode");
		// The first version is settled; a late decision returns it unchanged and starts nothing.
		const late = await runtime.root.respondPlan(first.version, { kind: "approve" });
		expect(late.status).toBe("revision_requested");
		expect((await runtime.root.plan()).mode).toBe("plan");
		expect(await userTexts(runtime)).toHaveLength(2);
		await expect(runtime.root.respondPlan("nope", { kind: "approve" })).rejects.toThrow("Plan not found");
		await expect(
			runtime.root.respondPlan(second.current!.version, { kind: "revise", feedback: " " }),
		).rejects.toThrow();
		expect((await runtime.root.plan()).current!.status).toBe("awaiting_approval");
	} finally {
		await runtime.close();
	}
});

it("rejects mode changes and decisions while a run is live", async () => {
	const faux = fauxProvider();
	faux.setResponses([call("ask_user", { question: "Which?" }), fauxAssistantMessage("ok")]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		await until(
			() => runtime.root.questions(),
			(l) => l.pending.length > 0,
			"a question",
		);
		await expect(runtime.root.setPlanMode("plan")).rejects.toThrow("PLAN_BUSY");
		expect((await runtime.root.plan()).mode).toBe("normal");
		await runtime.abort();
		await runtime.waitAnswer(job).catch(() => {});
	} finally {
		await runtime.close();
	}
});

it("supersedes a waiting plan with ordinary input and keeps plan mode", async () => {
	const faux = fauxProvider();
	faux.setResponses([call("submit_plan", plan1), fauxAssistantMessage("still researching")]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("plan")).catch(() => {});
		const plan = await awaitingPlan(runtime);
		await runtime.waitAnswer(await runtime.submit("also support yaml"));
		expect(await runtime.root.planRecord(plan.version)).toMatchObject({ status: "superseded" });
		expect((await runtime.root.plan()).mode).toBe("plan");
		expect(await toolNames(runtime)).not.toContain("edit");
	} finally {
		await runtime.close();
	}
});

it("cancels a waiting plan on stop and on leaving plan mode; late approval starts nothing", async () => {
	const faux = fauxProvider();
	faux.setResponses([call("submit_plan", plan1), call("submit_plan", { ...plan1, title: "Second" })]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("plan")).catch(() => {});
		const first = await awaitingPlan(runtime);
		await runtime.abort();
		expect(await runtime.root.planRecord(first.version)).toMatchObject({ status: "cancelled" });
		expect(await runtime.root.respondPlan(first.version, { kind: "approve" })).toMatchObject({ status: "cancelled" });
		expect((await runtime.root.plan()).mode).toBe("plan");
		expect(await userTexts(runtime)).toHaveLength(1);

		await runtime.waitAnswer(await runtime.submit("again")).catch(() => {});
		const second = await awaitingPlan(runtime);
		const left = await runtime.root.setPlanMode("normal");
		expect(left.mode).toBe("normal");
		expect(await runtime.root.planRecord(second.version)).toMatchObject({ status: "cancelled" });
		expect(await toolNames(runtime)).toContain("edit");
	} finally {
		await runtime.close();
	}
});

it("returns an error for invalid plans and hides submit_plan outside plan mode", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		call("submit_plan", { title: "x", steps: [] }),
		call("submit_plan", plan1),
		fauxAssistantMessage("fine"),
	]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("plan")).catch(() => {});
		const results = await toolResults(runtime);
		expect(results[0]!.isError).toBe(true);
		const plan = await awaitingPlan(runtime);
		expect(plan.steps).toEqual(plan1.steps);
		await runtime.root.setPlanMode("normal");
		expect(await toolNames(runtime)).not.toContain("submit_plan");
	} finally {
		await runtime.close();
	}
});

it("repairs the agent configuration from the plan document before accepting input", async () => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hello")]);
	const runtime = await open(faux);
	try {
		await runtime.harness.commit(async (tx) => {
			(await tx.doc(PlanDoc, runtime.conversation.id)).mode = "plan";
		}, runtime.context);
		expect(await toolNames(runtime)).toContain("edit");
		await runtime.waitAnswer(await runtime.submit("hi"));
		const tools = await toolNames(runtime);
		expect(tools).not.toContain("edit");
		expect(tools).toContain("submit_plan");
	} finally {
		await runtime.close();
	}
});

it("submits an approved but undispatched decision exactly once after a restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-plan-restart-"));
	const faux = fauxProvider();
	faux.setResponses([call("submit_plan", plan1), fauxAssistantMessage("running the plan")]);
	const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], model };
	let runtime = await createNekoRuntime(options);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("plan")).catch(() => {});
		const plan = await awaitingPlan(runtime);
		// The decision is saved but its input was never submitted.
		await runtime.root.plan();
		await runtime.harness.commit(async (tx) => {
			const doc = await tx.doc(PlanDoc, runtime.conversation.id);
			const item = doc.items.find((i) => i.version === plan.version)!;
			item.status = "approved";
			item.settledAt = Date.now();
			doc.mode = "normal";
		}, runtime.context);
		await runtime.close();
		runtime = await createNekoRuntime(options);
		await until(
			() => userTexts(runtime),
			(texts) => texts.length === 2,
			"the replayed execute input",
		);
		await until(
			() => runtime.root.plan(),
			(v) => v.mode === "normal",
			"plan mode left",
		);
		expect(await toolNames(runtime)).toContain("edit");
		await runtime.close();
		runtime = await createNekoRuntime(options);
		await Bun.sleep(100);
		expect(await userTexts(runtime)).toHaveLength(2);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("blocks coder subagents in plan mode and never gives subagents plan tools", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		call("subagent", { type: "coder", title: "Impl", task: "write it" }),
		call("subagent", { type: "explore", title: "Look", task: "look around" }),
		fauxAssistantMessage("explored"),
		fauxAssistantMessage("main done"),
	]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("delegate"));
		const results = await toolResults(runtime);
		expect(results[0]!.isError).toBe(true);
		expect(resultText(results[0]!)).toContain("coder subagent is unavailable");
		expect(results[1]!.isError).toBe(false);
		const agents = await runtime.root.conversation.agent(runtime.context);
		expect(agents.tools.map((t) => t.name)).toContain("subagent");
		const children = (
			await runtime.harness.commit((tx) => tx.scanConversations({ ownerTaskId: undefined }, 100), runtime.context)
		).items;
		for (const child of children) {
			if (child.id === runtime.conversation.id) continue;
			const names = await toolNames(runtime, child.id);
			expect(names).not.toContain("submit_plan");
			expect(names).not.toContain("todo");
		}
	} finally {
		await runtime.close();
	}
});

it("reports awaitingPlan in the directory and keeps plan state in a fork", async () => {
	const faux = fauxProvider();
	faux.setResponses([call("submit_plan", plan1)]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("plan")).catch(() => {});
		const plan = await awaitingPlan(runtime);
		await until(
			async () => (await runtime.listConversations()).find((c) => c.id === runtime.conversation.id),
			(info) => info?.awaitingPlan === true,
			"awaitingPlan",
		);
		const fork = await runtime.forkConversation(runtime.conversation.id);
		const forkPlan = await fork.plan();
		// The fork keeps the plan state of its fork point, and the agent configuration agrees with it.
		expect(forkPlan).toMatchObject({ mode: "plan", current: { version: plan.version, status: "awaiting_approval" } });
		const names = await toolNames(runtime, fork.id);
		expect(names).not.toContain("edit");
		expect(names).toContain("submit_plan");
		await runtime.root.respondPlan(plan.version, { kind: "approve" }).catch(() => {});
	} finally {
		await runtime.close();
	}
});

it("supersedes a plan submitted while a user input is already queued, which then runs in plan mode", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		call("ask_user", { question: "Which?" }),
		call("submit_plan", plan1),
		fauxAssistantMessage("handled the queued input"),
	]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		const first = await runtime.submit("plan");
		const q = (
			await until(
				() => runtime.root.questions(),
				(l) => l.pending.length > 0,
				"a question",
			)
		).pending[0]!;
		const queued = await runtime.submit("also support yaml", { whenBusy: "followUp" });
		await runtime.root.respondQuestion(q.id, q.version, { kind: "skip" });
		await runtime.waitAnswer(first).catch(() => {});
		const answer = await runtime.waitAnswer(queued);
		expect(answer).toEqual({ status: "done", text: "handled the queued input" });
		const view = await runtime.root.plan();
		expect(view.mode).toBe("plan");
		expect(view.current).toMatchObject({ status: "superseded" });
		expect(await toolNames(runtime)).not.toContain("edit");
	} finally {
		await runtime.close();
	}
});

it("projects submit_plan as a structured tool item and a decision as a system record, not as user input", async () => {
	const faux = fauxProvider();
	faux.setResponses([call("submit_plan", plan1), fauxAssistantMessage("running")]);
	const runtime = await open(faux);
	try {
		await runtime.root.setPlanMode("plan");
		await runtime.waitAnswer(await runtime.submit("plan")).catch(() => {});
		const plan = await awaitingPlan(runtime);
		await runtime.root.respondPlan(plan.version, { kind: "approve" });
		await until(
			() => userTexts(runtime),
			(texts) => texts.length === 2,
			"the execute input",
		);
		const state = await runtime.root.viewState();
		const items = projectChatView(state.value, "faux").items;
		const tool = items.find((i) => i.type === "tool" && i.name === "submit_plan");
		expect(tool).toMatchObject({
			interaction: { kind: "submit_plan", version: plan.version, title: "Add flag", steps: plan1.steps },
		});
		expect(items.filter((i) => i.type === "user")).toHaveLength(1);
		expect(items.find((i) => i.type === "system")).toMatchObject({
			text: "Plan approved: Add flag",
			planDecision: { version: plan.version, kind: "approve" },
		});
		expect((await runtime.root.plan()).current).toMatchObject({ version: plan.version, status: "approved" });
	} finally {
		await runtime.close();
	}
});
