import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { onCommits } from "../src/commits.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { subagentUsageTotals } from "../src/subagent-usage.ts";
import { DelegationsDoc, listDelegations, listSubagents, SubagentsDoc } from "../src/subagents.ts";

const call = (args: Record<string, string | number>) =>
	fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" });
const options = (faux: ReturnType<typeof fauxProvider>) => ({
	storage: "memory" as const,
	credentials: new InMemoryCredentialStore(),
	providers: [faux.provider],
	model: { provider: "faux", modelId: "faux-1" },
});
async function waitFor<T>(read: () => Promise<T>, test: (v: T) => boolean): Promise<T> {
	for (let i = 0; i < 1000; i++) {
		const v = await read();
		if (test(v)) return v;
		await Bun.sleep(5);
	}
	throw new Error("Continuation timed out");
}

it("continues the same child with prior context, exposes identity, discovers it and preserves per-round usage", async () => {
	const faux = fauxProvider();
	const reports: unknown[] = [];
	let id = "";
	faux.setResponses([
		call({ type: "explore", title: "Investigation", task: "Remember evidence alpha" }),
		fauxAssistantMessage("Evidence alpha"),
		fauxAssistantMessage("Main one"),
		call({ action: "list", limit: 1 }),
		(request) => {
			const result = request.messages.findLast((m) => m.role === "toolResult");
			expect(JSON.stringify(result)).toContain(id);
			return call({ action: "continue", agentId: id, title: "Follow up", task: "Recall evidence and extend it" });
		},
		(request) => {
			expect(JSON.stringify(request.messages)).toContain("Evidence alpha");
			expect(JSON.stringify(request.messages)).toContain("Recall evidence");
			return fauxAssistantMessage("Evidence beta");
		},
		fauxAssistantMessage("Main two"),
	]);
	const runtime = await createNekoRuntime({ ...options(faux), onReport: (error) => reports.push(error) });
	try {
		await runtime.waitAnswer(await runtime.submit("First"));
		let records = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
		id = records[0]!.agentId!;
		expect((await listSubagents(runtime.harness, runtime.root.id, runtime.context))[0]!.status).toBe("idle");
		await runtime.waitAnswer(await runtime.submit("Follow up"));
		records = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
		expect(records).toHaveLength(2);
		expect(records[1]!.childId).toBe(records[0]!.childId);
		expect(records.map((r) => r.report)).toEqual(["Evidence alpha", "Evidence beta"]);
		expect(records.map((r) => r.round)).toEqual([1, 2]);
		expect(records[0]!.roundUsage!.input + records[1]!.roundUsage!.input).toBe(
			subagentUsageTotals(
				(await runtime.harness.snapshot(UsageDoc, records[0]!.childId as ConversationId, runtime.context))!,
			).input,
		);
		expect(await listSubagents(runtime.harness, runtime.root.id, runtime.context)).toHaveLength(1);
		const main = await runtime.root.conversation.context(runtime.context);
		expect(JSON.stringify(main.messages)).toContain(`Agent: ${id}`);
		expect(reports).toEqual([]);
	} finally {
		await runtime.close();
	}
});

it("atomically refuses a second accepted round on the same child without adding input", async () => {
	const faux = fauxProvider();
	let id = "",
		entered = false;
	let release = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	faux.setResponses([
		call({ type: "plan", title: "Plan", task: "First task" }),
		fauxAssistantMessage("First plan"),
		fauxAssistantMessage("Main"),
		() =>
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", { action: "continue", agentId: id, title: "Second", task: "Second task" }),
					fauxToolCall("subagent", { action: "continue", agentId: id, title: "Third", task: "Third task" }),
				],
				{ stopReason: "toolUse" },
			),
		async () => {
			entered = true;
			await gate;
			return fauxAssistantMessage("Second plan");
		},
		fauxAssistantMessage("Integrated"),
	]);
	const runtime = await createNekoRuntime(options(faux));
	try {
		await runtime.waitAnswer(await runtime.submit("First"));
		id = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!.agentId!;
		const job = await runtime.submit("Two attempts");
		await waitFor(async () => entered, Boolean);
		expect(await listDelegations(runtime.harness, runtime.root.id, runtime.context)).toHaveLength(2);
		release();
		await runtime.waitAnswer(job);
		const context = await runtime.root.conversation.context(runtime.context);
		expect(JSON.stringify(context.messages)).toContain("Subagent is busy");
		const child = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!.childId;
		const childContext = await (await runtime.harness.conversation(child as ConversationId, runtime.context))!.context(
			runtime.context,
		);
		expect(childContext.messages.filter((m) => m.role === "user")).toHaveLength(2);
	} finally {
		release();
		await runtime.close();
	}
});

it("stops a continued child execution, clears its active lock and permits a third round", async () => {
	const faux = fauxProvider();
	let id = "",
		entered = false;
	faux.setResponses([
		call({ type: "plan", title: "Plan", task: "First" }),
		fauxAssistantMessage("First evidence"),
		fauxAssistantMessage("Main"),
		() => call({ action: "continue", agentId: id, title: "Second", task: "Wait" }),
		async (_request, opts) => {
			entered = true;
			await new Promise<void>((resolve) => {
				if (opts?.signal?.aborted) resolve();
				else opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return fauxAssistantMessage("", { stopReason: "aborted" });
		},
		fauxAssistantMessage("Stopped"),
		() => call({ action: "continue", agentId: id, title: "Third", task: "Continue after stop" }),
		(request) => {
			expect(JSON.stringify(request.messages)).toContain("First evidence");
			return fauxAssistantMessage("Third report");
		},
		fauxAssistantMessage("Finished"),
	]);
	const runtime = await createNekoRuntime(options(faux));
	try {
		await runtime.waitAnswer(await runtime.submit("First"));
		id = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!.agentId!;
		const job = await runtime.submit("Second");
		await waitFor(async () => entered, Boolean);
		const round = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[1]!;
		await runtime.harness.abortTask(round.taskId as never, runtime.context);
		await runtime.harness.waitForTask(round.taskId as never, runtime.context);
		await runtime.waitAnswer(job);
		expect((await listSubagents(runtime.harness, runtime.root.id, runtime.context))[0]!.status).toBe("idle");
		await runtime.waitAnswer(await runtime.submit("Third"));
		expect((await listDelegations(runtime.harness, runtime.root.id, runtime.context)).map((r) => r.status)).toEqual([
			"completed",
			"cancelled",
			"completed",
		]);
	} finally {
		await runtime.close();
	}
});

it("keeps role/configuration, refreshes project resources and rejects identities outside this parent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-continue-resources-"));
	const faux = fauxProvider();
	let id = "";
	faux.setResponses([
		call({ type: "plan", title: "Plan", task: "First" }),
		fauxAssistantMessage("Plan"),
		fauxAssistantMessage("Main"),
		() => call({ action: "continue", agentId: id, title: "Second", task: "Check resources" }),
		(request) => {
			const sys = JSON.stringify(request.messages.filter((m) => m.role === "system"));
			expect(sys).toContain("new project instruction");
			expect(sys).toContain("read-only planning");
			return fauxAssistantMessage("Checked");
		},
		fauxAssistantMessage("Done"),
		() => call({ action: "continue", agentId: id, title: "Foreign", task: "Foreign attempt" }),
		fauxAssistantMessage("Rejected"),
	]);
	const runtime = await createNekoRuntime({ ...options(faux), cwd: dir });
	try {
		await runtime.waitAnswer(await runtime.submit("First"));
		const first = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!;
		id = first.agentId!;
		const child = (await runtime.harness.conversation(first.childId as ConversationId, runtime.context))!;
		const before = await child.agent(runtime.context);
		await writeFile(join(dir, "AGENTS.md"), "new project instruction");
		await runtime.waitAnswer(await runtime.submit("Second"));
		expect((await child.agent(runtime.context)).model).toEqual(before.model);
		const other = await runtime.createConversation({ cwd: dir });
		await other.waitAnswer(await other.submit("Foreign"));
		expect(await listDelegations(runtime.harness, other.id, runtime.context)).toHaveLength(0);
		expect(await listDelegations(runtime.harness, runtime.root.id, runtime.context)).toHaveLength(2);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("restores stable identity from legacy records without inventing historical usage", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-continue-legacy-"));
	const faux = fauxProvider();
	faux.setResponses([
		call({ type: "plan", title: "Plan", task: "First" }),
		fauxAssistantMessage("Prior report"),
		fauxAssistantMessage("Main"),
	]);
	const opts = { ...options(faux), storage: "sqlite" as const, storagePath: join(dir, "state.sqlite") };
	let runtime = await createNekoRuntime(opts);
	try {
		await runtime.waitAnswer(await runtime.submit("First"));
		const child = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!.childId;
		await runtime.harness.commit(async (tx) => {
			const d = (await tx.doc(DelegationsDoc, runtime.root.id)).items[0]!;
			delete d.agentId;
			delete d.round;
			delete d.runnerId;
			delete d.usageStart;
			delete d.usageEnd;
			delete d.roundUsage;
			(await tx.doc(SubagentsDoc, runtime.root.id)).items = [];
		}, runtime.context);
		await runtime.close();
		runtime = await createNekoRuntime(opts);
		const identities = await listSubagents(runtime.harness, runtime.root.id, runtime.context);
		expect(identities).toHaveLength(1);
		expect(identities[0]!.childId).toBe(child);
		expect(identities[0]!.status).toBe("idle");
		expect((await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!.roundUsage).toBeUndefined();
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("requires a new approval for an identical command on a continued round and restores that round after restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-continue-approval-"));
	const faux = fauxProvider();
	let id = "";
	faux.setResponses([
		call({ type: "explore", title: "Explore", task: "First command" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf evidence" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("First report"),
		fauxAssistantMessage("Main one"),
		() => call({ action: "continue", agentId: id, title: "Second", task: "Same command again" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf evidence" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Second report"),
		fauxAssistantMessage("Main two"),
	]);
	const opts = { ...options(faux), cwd: dir, storage: "sqlite" as const, storagePath: join(dir, "state.sqlite") };
	let runtime = await createNekoRuntime(opts);
	try {
		const firstJob = await runtime.submit("First");
		const first = await waitFor(
			() => runtime.approvals.list(runtime.root.id, runtime.context),
			(a) => a.some((r) => r.status === "pending"),
		);
		const a = first.find((a) => a.status === "pending")!;
		await runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, "allowed", runtime.context);
		await runtime.waitAnswer(firstJob);
		id = (await listSubagents(runtime.harness, runtime.root.id, runtime.context))[0]!.agentId;
		const nextJob = await runtime.submit("Second");
		const pending = await waitFor(
			() => runtime.approvals.list(runtime.root.id, runtime.context),
			(a) => a.some((r) => r.status === "pending"),
		);
		const b = pending.find((a) => a.status === "pending")!;
		expect(b.id).not.toBe(a.id);
		expect(b.delegationTaskId).not.toBe(a.delegationTaskId);
		const rounds = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
		const baseline = rounds[1]!.usageStart;
		const runnerId = rounds[1]!.runnerId;
		await runtime.close();
		runtime = await createNekoRuntime(opts);
		const restored = await waitFor(
			() => runtime.approvals.list(runtime.root.id, runtime.context),
			(a) => a.some((r) => r.status === "pending"),
		);
		expect(restored.find((a) => a.id === b.id)!.version).toBe(b.version);
		const recovered = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[1]!;
		expect(recovered.usageStart).toEqual(baseline);
		expect(recovered.runnerId).toBe(runnerId);
		expect(
			await runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, "denied", runtime.context),
		).toBe("allowed");
		await runtime.approvals.decide(runtime.root.id, b.delegationTaskId, b.id, b.version, "denied", runtime.context);
		await runtime.waitAnswer((await runtime.harness.submission(nextJob.id, runtime.context))!);
		expect((await listDelegations(runtime.harness, runtime.root.id, runtime.context)).map((r) => r.status)).toEqual([
			"completed",
			"completed",
		]);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 20000);

it("freezes continued child references and usage in a parent fork", async () => {
	const faux = fauxProvider();
	let id = "";
	faux.setResponses([
		call({ type: "plan", title: "Plan", task: "First" }),
		fauxAssistantMessage("First report"),
		fauxAssistantMessage("Main one"),
		() => call({ action: "continue", agentId: id, title: "Second", task: "Second" }),
		fauxAssistantMessage("Second report"),
		fauxAssistantMessage("Main two"),
	]);
	const runtime = await createNekoRuntime(options(faux));
	try {
		await runtime.waitAnswer(await runtime.submit("First"));
		id = (await listSubagents(runtime.harness, runtime.root.id, runtime.context))[0]!.agentId;
		const fork = await runtime.forkConversation(runtime.root.id);
		const frozen = (await listDelegations(runtime.harness, fork.id, runtime.context))[0]!;
		await runtime.waitAnswer(await runtime.submit("Second"));
		expect((await listDelegations(runtime.harness, fork.id, runtime.context))[0]).toEqual(frozen);
		expect((await runtime.harness.snapshot(SubagentsDoc, fork.id, runtime.context))!.items).toHaveLength(0);
	} finally {
		await runtime.close();
	}
});

for (const checkpoint of ["admission", "deliver", "settle", "answer"] as const) {
	it(`recovers a native continued round from ${checkpoint} without duplicate input`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "neko-continue-checkpoint-"));
		const faux = fauxProvider();
		let id = "";
		const route: Parameters<typeof faux.setResponses>[0][number] = (request) => {
			if (JSON.stringify(request.messages.filter((m) => m.role === "system")).includes("read-only planning subagent"))
				return fauxAssistantMessage("Second answer");
			if (request.messages.findLast((m) => m.role !== "system")?.role === "toolResult")
				return fauxAssistantMessage("Main two");
			return call({ action: "continue", agentId: id, title: "Second", task: "Second task" });
		};
		faux.setResponses([
			call({ type: "plan", title: "Plan", task: "First" }),
			fauxAssistantMessage("Prior evidence"),
			fauxAssistantMessage("Main one"),
			...Array.from({ length: 10 }, () => route),
		]);
		const opts = { ...options(faux), storage: "sqlite" as const, storagePath: join(dir, "state.sqlite") };
		let runtime = await createNekoRuntime(opts);
		let stop = () => {};
		try {
			await runtime.waitAnswer(await runtime.submit("First"));
			id = (await listSubagents(runtime.harness, runtime.root.id, runtime.context))[0]!.agentId;
			let reached = () => {};
			const gate = new Promise<void>((r) => {
				reached = r;
			});
			let closing: Promise<void> | undefined;
			let runnerId = 0;
			const childId = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!.childId;
			stop = onCommits(runtime.harness, ({ changes }) => {
				if (closing) return;
				for (const c of changes) {
					if (
						checkpoint === "answer" &&
						c.type === "submission" &&
						c.value.conversationId === childId &&
						c.value.status === "done"
					) {
						closing = runtime.harness.close(runtime.context);
						reached();
						break;
					}
					if (c.type !== "task" || c.value.kind !== "app.neko.subagent-round" || c.value.state.status !== "running")
						continue;
					const state = c.value.state.checkpoint;
					if (state && typeof state === "object" && !Array.isArray(state) && state.phase === checkpoint) {
						runnerId = c.value.id;
						closing = runtime.harness.close(runtime.context);
						reached();
						break;
					}
				}
			});
			const job = await runtime.submit("Second");
			await gate;
			stop();
			await closing;
			await runtime.close();
			runtime = await createNekoRuntime(opts);
			await runtime.waitAnswer((await runtime.harness.submission(job.id, runtime.context))!);
			const rounds = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
			expect(rounds).toHaveLength(2);
			if (checkpoint !== "answer") expect(rounds[1]!.runnerId).toBe(runnerId);
			expect(rounds[1]!.report).toBe("Second answer");
			const child = (await runtime.harness.conversation(rounds[1]!.childId as ConversationId, runtime.context))!;
			expect((await child.context(runtime.context)).messages.filter((m) => m.role === "user")).toHaveLength(2);
		} finally {
			stop();
			await runtime.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 15000);
}

it("resumes durable cancellation after restart and releases the identity only after the child is idle", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-continue-abort-"));
	const faux = fauxProvider();
	let id = "",
		entered = false;
	const route: Parameters<typeof faux.setResponses>[0][number] = async (request, opts) => {
		if (JSON.stringify(request.messages.filter((m) => m.role === "system")).includes("read-only planning subagent")) {
			entered = true;
			await new Promise<void>((r) => {
				if (opts?.signal?.aborted) r();
				else opts?.signal?.addEventListener("abort", () => r(), { once: true });
			});
			return fauxAssistantMessage("", { stopReason: "aborted" });
		}
		return request.messages.findLast((m) => m.role !== "system")?.role === "toolResult"
			? fauxAssistantMessage("Main stopped")
			: call({ action: "continue", agentId: id, title: "Second", task: "Wait until stopped" });
	};
	faux.setResponses([
		call({ type: "plan", title: "Plan", task: "First" }),
		fauxAssistantMessage("Original evidence"),
		fauxAssistantMessage("Main one"),
		...Array.from({ length: 10 }, () => route),
	]);
	const opts = { ...options(faux), storage: "sqlite" as const, storagePath: join(dir, "state.sqlite") };
	let runtime = await createNekoRuntime(opts);
	let stop = () => {};
	try {
		await runtime.waitAnswer(await runtime.submit("First"));
		id = (await listSubagents(runtime.harness, runtime.root.id, runtime.context))[0]!.agentId;
		const job = await runtime.submit("Second");
		await waitFor(async () => entered, Boolean);
		const second = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[1]!;
		let reached = () => {};
		const gate = new Promise<void>((r) => {
			reached = r;
		});
		let closing: Promise<void> | undefined;
		stop = onCommits(runtime.harness, ({ changes }) => {
			if (closing) return;
			if (changes.some((c) => c.type === "task" && c.value.id === second.runnerId && c.value.abortRequested)) {
				closing = runtime.harness.close(runtime.context);
				reached();
			}
		});
		const abort = runtime.harness.abortTask(second.taskId as never, runtime.context).catch(() => undefined);
		await gate;
		stop();
		await closing;
		await abort;
		await runtime.close();
		runtime = await createNekoRuntime(opts);
		await runtime.waitAnswer((await runtime.harness.submission(job.id, runtime.context))!);
		expect((await listDelegations(runtime.harness, runtime.root.id, runtime.context))[1]!.status).toBe("cancelled");
		expect((await listSubagents(runtime.harness, runtime.root.id, runtime.context))[0]!.status).toBe("idle");
		const child = (await runtime.harness.conversation(second.childId as ConversationId, runtime.context))!;
		await child.waitForIdle(runtime.context);
	} finally {
		stop();
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);
