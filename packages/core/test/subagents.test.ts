import { expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { listDelegations } from "../src/subagents.ts";

it("delegates in an owned conversation, restricts tools and returns the final report", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Find evidence" })], {
			stopReason: "toolUse",
		}),
		(context) => {
			const prompt = JSON.stringify(context.messages.filter((message) => message.role === "system"));
			expect(prompt).toContain("exploration subagent");
			expect(prompt).toContain("Skills never expand your allowed tools");
			expect(prompt).not.toContain("You are an expert coding assistant");
			return fauxAssistantMessage([fauxText("Evidence report")]);
		},
		fauxAssistantMessage([fauxText("Integrated report")]),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		expect(await runtime.waitAnswer(await runtime.submit("Investigate using explore"))).toEqual({
			status: "done",
			text: "Integrated report",
		});
		const records = await listDelegations(runtime.harness, runtime.conversation.id, runtime.context);
		expect(records).toHaveLength(1);
		expect(records[0]!.status).toBe("completed");
		expect(records[0]!.report).toBe("Evidence report");
		const child = await runtime.harness.conversation(records[0]!.childId as never, runtime.context);
		const agent = await child!.agent(runtime.context);
		expect(agent.tools.map((tool) => tool.name)).toContain("search_text");
		for (const name of ["write", "edit", "subagent"]) expect(agent.tools.map((tool) => tool.name)).not.toContain(name);
		expect(await runtime.listConversations()).toHaveLength(1);
		const view = await child!.viewState(runtime.context);
		expect(JSON.stringify(view.value.entries)).not.toContain("Investigate using explore");
		view.dispose();
	} finally {
		await runtime.close();
	}
}, 30_000);

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
	const end = Date.now() + 10000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > end) throw new Error("Subagent state timed out");
		await Bun.sleep(10);
	}
}

it("limits foreground children, cancels queued/running delegates and keeps siblings alive", async () => {
	const faux = fauxProvider();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		fauxAssistantMessage(
			Array.from({ length: 4 }, (_, i) =>
				fauxToolCall("subagent", { type: "explore", title: `Child ${i}`, task: `Task ${i}` }),
			),
			{ stopReason: "toolUse" },
		),
		...Array.from({ length: 3 }, () => async () => {
			await gate;
			return fauxAssistantMessage("child evidence");
		}),
		fauxAssistantMessage("integrated siblings"),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const list = () => listDelegations(runtime.harness, runtime.root.id, runtime.context);
	try {
		const submission = await runtime.submit("Investigate four independent tasks");
		const records = await until(list, (ds) => ds.length === 4 && ds.filter((d) => d.status === "running").length === 3);
		const queued = records.find((d) => d.status === "queued")!;
		const running = records.find((d) => d.status === "running")!;
		await runtime.harness.abortTask(queued.taskId as never, runtime.context);
		await runtime.harness.waitForTask(queued.taskId as never, runtime.context);
		await runtime.harness.abortTask(running.taskId as never, runtime.context);
		release();
		await runtime.harness.waitForTask(running.taskId as never, runtime.context);
		await submission.wait(runtime.context);
		const settled = await list();
		expect(settled.filter((d) => d.status === "cancelled")).toHaveLength(2);
		expect(settled.find((d) => d.taskId === queued.taskId)!.roundUsage!.input).toBe(0);
		expect(settled.filter((d) => d.status === "completed")).toHaveLength(2);
		const child = await runtime.harness.conversation(queued.childId as never, runtime.context);
		expect((await child!.entries({}, 10, undefined, runtime.context)).items).toHaveLength(0);
	} finally {
		release();
		await runtime.close();
	}
}, 30000);

it("closes promptly while a delegate waits for a slot and reports nothing for the cancelled wait", async () => {
	const faux = fauxProvider();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		fauxAssistantMessage(
			Array.from({ length: 4 }, (_, i) =>
				fauxToolCall("subagent", { type: "explore", title: `Child ${i}`, task: `Task ${i}` }),
			),
			{ stopReason: "toolUse" },
		),
		...Array.from({ length: 3 }, () => async (_context: unknown, options?: { signal?: AbortSignal }) => {
			await Promise.race([
				gate,
				new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true })),
			]);
			return fauxAssistantMessage("child evidence");
		}),
	]);
	const reports: unknown[] = [];
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		onReport: (error) => reports.push(error),
	});
	try {
		await runtime.submit("Investigate four independent tasks");
		await until(
			() => listDelegations(runtime.harness, runtime.root.id, runtime.context),
			(ds) => ds.length === 4 && ds.some((d) => d.status === "queued"),
		);
		const started = Date.now();
		await runtime.close();
		expect(Date.now() - started).toBeLessThan(5000);
		expect(reports).toEqual([]);
	} finally {
		release();
	}
}, 30000);

it("forks child references at fixed history watermarks without inheriting writable children", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "plan", title: "Plan", task: "Plan evidence" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("plan delivery"),
		fauxAssistantMessage("main delivery"),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("Plan this"));
		const original = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!;
		const fork = await runtime.forkConversation(runtime.root.id);
		const copied = (await listDelegations(runtime.harness, fork.id, runtime.context))[0]!;
		expect(copied.childId).toBe(original.childId);
		expect(copied.historyThrough).toBeGreaterThan(0);
		expect(await runtime.getConversation(original.childId as never)).toBeUndefined();
		expect(await runtime.listConversations()).toHaveLength(2);
	} finally {
		await runtime.close();
	}
}, 30000);

it("serializes coders in the same workspace and releases the slot after completion", async () => {
	const faux = fauxProvider();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", { type: "coder", title: "First", task: "First change" }),
				fauxToolCall("subagent", { type: "coder", title: "Second", task: "Second change" }),
			],
			{ stopReason: "toolUse" },
		),
		async () => {
			await gate;
			return fauxAssistantMessage("First complete");
		},
		fauxAssistantMessage("Second complete"),
		fauxAssistantMessage("Integrated"),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		const submission = await runtime.submit("Make two independent changes");
		const list = () => listDelegations(runtime.harness, runtime.root.id, runtime.context);
		const records = await until(list, (ds) => ds.length === 2 && ds.some((d) => d.status === "running"));
		expect(records.filter((d) => d.status === "queued")).toHaveLength(1);
		release();
		await submission.wait(runtime.context);
		expect((await list()).map((d) => d.status)).toEqual(["completed", "completed"]);
	} finally {
		release();
		await runtime.close();
	}
}, 30000);

it("rejects unknown roles, denies recursive calls and keeps child intermediate calls out of main context", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "custom", title: "Unsupported", task: "Task" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("subagent", { type: "plan", title: "Plan", task: "Research only" })], {
			stopReason: "toolUse",
		}),
		(context) => {
			const prompt = JSON.stringify(context.messages.filter((m) => m.role === "system"));
			expect(prompt).toContain("read-only planning subagent");
			return fauxAssistantMessage([fauxToolCall("subagent", { type: "coder", title: "Nested", task: "Modify" })], {
				stopReason: "toolUse",
			});
		},
		(context) => {
			expect(context.messages.some((m) => m.role === "toolResult" && m.toolName === "subagent" && m.isError)).toBe(
				true,
			);
			return fauxAssistantMessage([]);
		},
		(context) => {
			const transcript = JSON.stringify(context.messages);
			expect(transcript).not.toContain('"title":"Nested"');
			expect(transcript).toContain("without a text report");
			return fauxAssistantMessage("Main report");
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		expect(await runtime.waitAnswer(await runtime.submit("Plan only"))).toEqual({
			status: "done",
			text: "Main report",
		});
		const records = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
		expect(records).toHaveLength(1);
		expect(records[0]!.role).toBe("plan");
		const child = await runtime.harness.conversation(records[0]!.childId as never, runtime.context);
		const agent = await child!.agent(runtime.context);
		expect(agent.model).toEqual((await runtime.root.conversation.agent(runtime.context)).model);
		expect(agent.thinkingLevel).toBe((await runtime.root.conversation.agent(runtime.context)).thinkingLevel);
		expect(agent.cwd).toBe((await runtime.root.conversation.agent(runtime.context)).cwd);
	} finally {
		await runtime.close();
	}
}, 30000);

it("archives by cascading cancellation and retains consumed child usage exactly once", async () => {
	const { totalUsage } = await import("../src/projection.ts");
	const { UsageDoc } = await import("@earendil-works/pi-durable");
	const faux = fauxProvider();
	let entered = false;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Investigate", task: "Read evidence" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("read", { path: "/nonexistent-neko-archive-evidence" })], {
			stopReason: "toolUse",
		}),
		async (_context, options) => {
			entered = true;
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("", { stopReason: "aborted" });
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.submit("Investigate");
		await until(async () => entered, Boolean);
		const record = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!;
		await runtime.archiveConversation(runtime.root.id);
		expect(await runtime.listConversations()).toHaveLength(0);
		expect((await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!.status).toBe("cancelled");
		const child = totalUsage((await runtime.harness.snapshot(UsageDoc, record.childId as never, runtime.context))!);
		const main = totalUsage(await runtime.usage());
		const global = totalUsage(await runtime.globalUsage());
		expect(child.input).toBeGreaterThan(0);
		expect(global.input).toBe(main.input + child.input);
		expect(global.output).toBe(main.output + child.output);
	} finally {
		await runtime.close();
	}
}, 30000);
