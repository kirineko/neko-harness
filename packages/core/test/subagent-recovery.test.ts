import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { listDelegations } from "../src/subagents.ts";

it("reopens an owned child without redispatching input or replaying an unsafe tool", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-subagent-recovery-"));
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let effects = 0;
	const extension = defineExtension({
		name: "test-effect",
		tools: [
			defineTool({
				name: "effect",
				description: "An unsafe side effect",
				parameters: obj({}, { open: true }),
				execute: async (_args, _api, ctx) => {
					effects++;
					entered();
					await new Promise<void>((_resolve, reject) => {
						const abort = () => reject(ctx.abortSignal?.reason ?? new Error("aborted"));
						ctx.abortSignal?.addEventListener("abort", abort, { once: true });
						if (ctx.abortSignal?.aborted) abort();
					});
					return { output: [] };
				},
			}),
		],
	});
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "coder", title: "Implement", task: "Run effect once" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("Recovered child"),
		fauxAssistantMessage("Recovered main"),
	]);
	const options = {
		storagePath: join(dir, "db.sqlite"),
		cwd: dir,
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		extensions: [extension],
		model: { provider: "faux", modelId: "faux-1" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		const submitted = await runtime.submit("Implement via coder");
		await started;
		const first = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!;
		await runtime.close();
		runtime = await createNekoRuntime(options);
		const resumed = await runtime.harness.submission(submitted.id, runtime.context);
		expect(await runtime.waitAnswer(resumed!)).toEqual({ status: "done", text: "Recovered main" });
		const records = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
		expect(records).toHaveLength(1);
		expect(records[0]!.childId).toBe(first.childId);
		expect(records[0]!.status).toBe("completed");
		expect(effects).toBe(1);
		const child = await runtime.harness.conversation(first.childId as never, runtime.context);
		const entries = (await child!.entries({}, 100, undefined, runtime.context)).items;
		expect(entries.filter((e) => e.model?.[0]?.role === "user")).toHaveLength(1);
		expect(JSON.stringify(entries)).toContain("interrupted");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);

for (const checkpoint of ["created", "reported"] as const) {
	it(`recovers delegation at ${checkpoint} without duplicating its child`, async () => {
		const { createSubagentExtension } = await import("../src/subagents.ts");
		const dir = await mkdtemp(join(tmpdir(), `neko-delegate-${checkpoint}-`));
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let blocked = false;
		const builtin = createSubagentExtension(
			async () => {},
			() => {},
		);
		const original = builtin.tools![0]!;
		const extension: Extension = {
			...builtin,
			tools: [
				{
					...original,
					execute: async (args, api, ctx) => {
						const pause = async () => {
							if (blocked) return;
							blocked = true;
							entered();
							await new Promise<void>((_resolve, reject) => {
								const abort = () => reject(ctx.abortSignal?.reason ?? new Error("aborted"));
								ctx.abortSignal?.addEventListener("abort", abort, { once: true });
								if (ctx.abortSignal?.aborted) abort();
							});
						};
						const adapted = new Proxy(api, {
							get(target, key) {
								if (key === "details" && checkpoint === "created")
									return async (...values: Parameters<typeof api.details>) => {
										await target.details(...values);
										await pause();
									};
								const value = Reflect.get(target, key);
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
						const result = await original.execute(args, adapted, ctx);
						if (checkpoint === "reported") await pause();
						return result;
					},
				},
			],
		};
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("subagent", { type: "explore", title: "Checkpoint", task: "Investigate checkpoint" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("child report"),
			fauxAssistantMessage("main report"),
		]);
		const options = {
			storagePath: join(dir, "db.sqlite"),
			cwd: dir,
			credentials: new InMemoryCredentialStore(),
			providers: [faux.provider],
			extensions: [extension],
			model: { provider: "faux", modelId: "faux-1" },
		};
		let runtime = await createNekoRuntime(options);
		try {
			const submission = await runtime.submit("checkpoint");
			await reached;
			const before = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!;
			await runtime.close();
			runtime = await createNekoRuntime(options);
			const resumed = await runtime.harness.submission(submission.id, runtime.context);
			expect(await runtime.waitAnswer(resumed!)).toEqual({ status: "done", text: "main report" });
			const after = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
			expect(after).toHaveLength(1);
			expect(after[0]!.childId).toBe(before.childId);
			const child = await runtime.harness.conversation(before.childId as never, runtime.context);
			expect(
				(await child!.entries({}, 100, undefined, runtime.context)).items.filter((e) => e.model?.[0]?.role === "user"),
			).toHaveLength(1);
		} finally {
			await runtime.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 30000);
}

it("retains the three-child admission limit across SQLite reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-subagent-slots-"));
	let active = 0,
		peak = 0,
		calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const extension = defineExtension({
		name: "neko-file-search",
		tools: [
			defineTool({
				name: "find_files",
				description: "Gated safe discovery",
				parameters: obj({}, { open: true }),
				replay: "safe",
				execute: async (_args, _api, ctx) => {
					active++;
					calls++;
					peak = Math.max(peak, active);
					let abort!: () => void;
					try {
						await Promise.race([
							gate,
							new Promise<void>((_r, reject) => {
								abort = () => reject(ctx.abortSignal?.reason ?? new Error("aborted"));
								ctx.abortSignal?.addEventListener("abort", abort, { once: true });
								if (ctx.abortSignal?.aborted) abort();
							}),
						]);
						return { output: [{ type: "text" as const, text: "evidence" }] };
					} finally {
						ctx.abortSignal?.removeEventListener("abort", abort);
						active--;
					}
				},
			}),
		],
	});
	const faux = fauxProvider();
	const respond: import("@earendil-works/pi-ai").FauxResponseFactory = (context) => {
		const main = JSON.stringify(context.messages.find((m) => m.role === "user")).includes("main work");
		const results = context.messages.filter((m) => m.role === "toolResult");
		if (main)
			return results.length
				? fauxAssistantMessage("integrated")
				: fauxAssistantMessage(
						Array.from({ length: 4 }, (_, i) =>
							fauxToolCall("subagent", { type: "explore", title: `Child ${i}`, task: `child ${i}` }),
						),
						{ stopReason: "toolUse" },
					);
		return results.length
			? fauxAssistantMessage("child report")
			: fauxAssistantMessage([fauxToolCall("find_files", {})], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 30 }, () => respond));
	const options = {
		storagePath: join(dir, "db.sqlite"),
		cwd: dir,
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		extensions: [extension],
		model: { provider: "faux", modelId: "faux-1" },
	};
	let runtime = await createNekoRuntime(options);
	const wait = async (predicate: () => boolean) => {
		const until = Date.now() + 5000;
		while (!predicate()) {
			if (Date.now() > until) throw new Error("admission timeout");
			await Bun.sleep(10);
		}
	};
	try {
		const submission = await runtime.submit("main work");
		await wait(() => active === 3);
		expect(calls).toBe(3);
		await runtime.close();
		expect(active).toBe(0);
		runtime = await createNekoRuntime(options);
		await wait(() => active === 3);
		expect(calls).toBe(6);
		expect(peak).toBe(3);
		release();
		const restored = await runtime.harness.submission(submission.id, runtime.context);
		await restored!.wait(runtime.context);
		expect(peak).toBe(3);
		expect(calls).toBe(7);
		expect((await listDelegations(runtime.harness, runtime.root.id, runtime.context)).map((d) => d.status)).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
		]);
	} finally {
		release();
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);
