import { expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { followConversation } from "../src/conversation-follow.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";
import type { ToolApproval } from "../src/tool-approvals.ts";

async function pending(runtime: NekoRuntime): Promise<ToolApproval> {
	for (let i = 0; i < 500; i++) {
		const a = (await runtime.approvals.list(runtime.root.id, runtime.context)).find((a) => a.status === "pending");
		if (a) return a;
		await Bun.sleep(10);
	}
	throw new Error("No pending approval");
}
for (const decision of ["allowed", "denied", "cancelled"] as const) {
	it(`explore command ${decision} is gated and its decision persists`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "neko-approval-"));
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Inspect" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf approved > result.txt" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Child report"),
			fauxAssistantMessage("Main report"),
		]);
		const runtime = await createNekoRuntime({
			storage: "memory",
			cwd: dir,
			providers: [faux.provider],
			model: { provider: "faux", modelId: "faux-1" },
		});
		try {
			const job = await runtime.submit("Investigate");
			const a = await pending(runtime);
			expect(await Bun.file(join(dir, "result.txt")).exists()).toBe(false);
			const { projectChatView } = await import("../src/projection.ts");
			const childView = await followConversation(
				(await runtime.harness.conversation(a.childId as never, runtime.context))!,
				runtime.context,
			);
			expect(
				projectChatView(childView.value, "faux").items.find((i) => i.type === "tool" && i.callId === a.callId),
			).toMatchObject({ phase: "pending" });
			childView.dispose();
			await expect(
				runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, "wrong", "allowed", runtime.context),
			).rejects.toThrow();
			if (decision === "cancelled") {
				await runtime.abort();
				expect(
					await runtime.approvals.decide(
						runtime.root.id,
						a.delegationTaskId,
						a.id,
						a.version,
						"allowed",
						runtime.context,
					),
				).toBe("cancelled");
			} else {
				const results = await Promise.all(
					[decision, decision === "allowed" ? ("denied" as const) : ("allowed" as const)].map((d) =>
						runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, d, runtime.context),
					),
				);
				expect(results).toEqual([decision, decision]);
			}
			await runtime.waitAnswer(job);
			expect((await runtime.approvals.list(runtime.root.id, runtime.context))[0]!.status).toBe(decision);
			expect(await Bun.file(join(dir, "result.txt")).exists()).toBe(decision === "allowed");
			if (decision === "allowed") expect(await readFile(join(dir, "result.txt"), "utf8")).toBe("approved");
		} finally {
			await runtime.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 20000);
}
it("restores a pending approval after SQLite reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-approval-restart-"));
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Inspect" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf once >> result.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Child report"),
		fauxAssistantMessage("Main report"),
	]);
	const options = {
		storagePath: join(dir, "state.sqlite"),
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		const job = await runtime.submit("Investigate");
		const a = await pending(runtime);
		await runtime.close();
		runtime = await createNekoRuntime(options);
		const restored = await pending(runtime);
		expect(restored.id).toBe(a.id);
		expect(restored.version).toBe(a.version);
		await runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, "allowed", runtime.context);
		const submission = await runtime.harness.submission(job.id, runtime.context);
		await runtime.waitAnswer(submission!);
		expect(await readFile(join(dir, "result.txt"), "utf8")).toBe("once");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 20000);

for (const checkpoint of ["decided", "intent", "executing"] as const) {
	it(`recovers at ${checkpoint} without replaying Bash effects`, async () => {
		const { defineExtension, wrapTool } = await import("@earendil-works/pi-durable");
		const { createBashTool } = await import("@earendil-works/pi-durable/tools");
		const dir = await mkdtemp(join(tmpdir(), "neko-approval-phase-"));
		const faux = fauxProvider();
		let reached!: () => void;
		const barrier = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const pause = (ctx: import("@earendil-works/chord").Context) =>
			new Promise<never>((_, reject) => {
				reached();
				const abort = () => reject(ctx.abortSignal?.reason);
				ctx.abortSignal?.addEventListener("abort", abort, { once: true });
				if (ctx.abortSignal?.aborted) abort();
			});
		let first = true;
		const extension = defineExtension({
			name: "test-approval-checkpoint",
			wraps: [
				wrapTool(createBashTool(), (base) => ({
					...base,
					execute: async (args, api, ctx) => {
						if (first && checkpoint === "intent") {
							first = false;
							await pause(ctx);
						}
						const result = await base.execute(args, api, ctx);
						if (first && checkpoint === "executing") {
							first = false;
							await pause(ctx);
						}
						return result;
					},
				})),
			],
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Inspect" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf once >> result.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Child report"),
			fauxAssistantMessage("Main report"),
		]);
		const options = {
			storagePath: join(dir, "state.sqlite"),
			cwd: dir,
			providers: [faux.provider],
			extensions: [extension],
			model: { provider: "faux", modelId: "faux-1" },
		};
		let runtime = await createNekoRuntime(options);
		try {
			if (checkpoint === "decided") {
				const original = runtime.approvals.wait.bind(runtime.approvals);
				runtime.approvals.wait = async (parent, id, ctx) => {
					const item = await original(parent, id, ctx);
					await pause(ctx);
					return item;
				};
			}
			const job = await runtime.submit("Inspect");
			const a = await pending(runtime);
			await runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, "allowed", runtime.context);
			await barrier;
			await runtime.close();
			runtime = await createNekoRuntime(options);
			await runtime.waitAnswer((await runtime.harness.submission(job.id, runtime.context))!);
			const exists = await Bun.file(join(dir, "result.txt")).exists();
			expect(exists).toBe(checkpoint !== "intent");
			if (exists) expect(await readFile(join(dir, "result.txt"), "utf8")).toBe("once");
			expect(await runtime.approvals.list(runtime.root.id, runtime.context)).toHaveLength(1);
			if (checkpoint !== "decided") {
				const child = await runtime.harness.conversation(a.childId as never, runtime.context);
				expect(JSON.stringify((await child!.entries({}, 100, undefined, runtime.context)).items)).toContain(
					"interrupted",
				);
			}
		} finally {
			await runtime.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 20000);
}

for (const alteration of ["cwd", "arguments"] as const) {
	it(`rejects changed ${alteration} after approval`, async () => {
		const { defineExtension, hook, ToolTask } = await import("@earendil-works/pi-durable");
		const dir = await mkdtemp(join(tmpdir(), "neko-approval-alter-"));
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Inspect" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf once > result.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Child report"),
			fauxAssistantMessage("Main report"),
		]);
		const runtime = await createNekoRuntime({
			storage: "memory",
			cwd: dir,
			providers: [faux.provider],
			model: { provider: "faux", modelId: "faux-1" },
		});
		if (alteration === "arguments")
			runtime.installExtension(
				defineExtension({
					name: "late-rewrite",
					hooks: [
						hook(ToolTask, {
							beforeTool: (call) =>
								call.name === "bash" ? { arguments: { command: "printf changed > result.txt" } } : undefined,
						}),
					],
				}),
			);
		try {
			const job = await runtime.submit("Inspect");
			const a = await pending(runtime);
			if (alteration === "cwd") {
				const child = await runtime.harness.conversation(a.childId as never, runtime.context);
				await child!.configure({ cwd: tmpdir() }, runtime.context);
			}
			await runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, "allowed", runtime.context);
			await runtime.waitAnswer(job);
			expect(await Bun.file(join(dir, "result.txt")).exists()).toBe(false);
			const child = await runtime.harness.conversation(a.childId as never, runtime.context);
			expect(JSON.stringify((await child!.entries({}, 100, undefined, runtime.context)).items)).toContain(
				"operation changed",
			);
		} finally {
			await runtime.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 20000);
}

it("gates nested Bash and requires a fresh decision for repeated commands", async () => {
	const { defineExtension, defineTool } = await import("@earendil-works/pi-durable");
	const dir = await mkdtemp(join(tmpdir(), "neko-approval-nested-"));
	const faux = fauxProvider();
	const nested = defineExtension({
		name: "nested-probe",
		tools: [
			defineTool({
				name: "read",
				description: "test nested call",
				parameters: obj({}, { open: true }),
				replay: "safe",
				execute: async (_args, api, ctx) => {
					const result = await api.executeTool("bash", { command: "printf once >> result.txt" }, ctx, { key: "probe" });
					return { output: [{ type: "text", text: JSON.stringify(result.structuredOutput) }], isError: result.isError };
				},
			}),
		],
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Inspect" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "printf once >> result.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Child report"),
		fauxAssistantMessage("Main report"),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		cwd: dir,
		extensions: [nested],
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		const job = await runtime.submit("Inspect");
		const a = await pending(runtime);
		expect(a.callId).toContain("/probe");
		await runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, "allowed", runtime.context);
		const b = await pending(runtime);
		expect(b.id).not.toBe(a.id);
		await runtime.approvals.decide(runtime.root.id, b.delegationTaskId, b.id, b.version, "denied", runtime.context);
		await runtime.waitAnswer(job);
		expect(await readFile(join(dir, "result.txt"), "utf8")).toBe("once");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 20000);
