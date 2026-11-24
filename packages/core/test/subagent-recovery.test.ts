import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_RESTART_LIMIT, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { listDelegations, SlotsDoc } from "../src/subagents.ts";
import { ApprovalsDoc } from "../src/tool-approvals.ts";

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

for (const checkpoint of ["created", "parked", "reported"] as const) {
	it(`recovers delegation at ${checkpoint} without duplicating its child`, async () => {
		const { createSubagentExtension } = await import("../src/subagents.ts");
		const dir = await mkdtemp(join(tmpdir(), `neko-delegate-${checkpoint}-`));
		let entered!: () => void;
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let releaseChild!: () => void;
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
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
								if (key === "details" && checkpoint === "created" && target.wake === undefined)
									return async (...values: Parameters<typeof api.details>) => {
										await target.details(...values);
										await pause();
									};
								const value = Reflect.get(target, key);
								return typeof value === "function" ? value.bind(target) : value;
							},
						});
						const result = await original.execute(args, adapted, ctx);
						if (checkpoint === "reported" && api.wake !== undefined && !("wait" in result) && !("sleep" in result)) {
							await pause();
						}
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
			async (_context, options) => {
				if (checkpoint === "parked") {
					entered();
					await Promise.race([
						childGate,
						new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true })),
					]);
					if (options?.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
				}
				return fauxAssistantMessage("child report");
			},
			...(checkpoint === "parked" ? [fauxAssistantMessage("child report")] : []),
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
			if (checkpoint === "parked") {
				await reached;
				const end = Date.now() + 5000;
				while (Date.now() < end) {
					const d = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0];
					const parentTask = d && (await runtime.harness.getTask(d.taskId as never, runtime.context));
					const runnerTask = d?.runnerId
						? await runtime.harness.getTask(d.runnerId as never, runtime.context)
						: undefined;
					if (parentTask?.state.status === "waiting" && runnerTask?.state.status === "sleeping") break;
					await sleep(10);
				}
			} else {
				await reached;
			}
			const before = (await listDelegations(runtime.harness, runtime.root.id, runtime.context))[0]!;
			if (checkpoint === "parked") {
				expect((await runtime.harness.getTask(before.taskId as never, runtime.context))?.state.status).toBe("waiting");
			}
			await runtime.close();
			releaseChild();
			runtime = await createNekoRuntime(options);
			const resumed = await runtime.harness.submission(submission.id, runtime.context);
			expect(await runtime.waitAnswer(resumed!)).toEqual({ status: "done", text: "main report" });
			const after = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
			expect(after).toHaveLength(1);
			expect(after[0]!.childId).toBe(before.childId);
			expect(after[0]!.report).toBe("child report");
			const child = await runtime.harness.conversation(before.childId as never, runtime.context);
			expect(
				(await child!.entries({}, 100, undefined, runtime.context)).items.filter((e) => e.model?.[0]?.role === "user"),
			).toHaveLength(1);
		} finally {
			releaseChild();
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
			await sleep(10);
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

it("survives more than restartLimit ungraceful crashes while delegates are parked or queued for slots", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-subagent-ungraceful-"));
	const liveDir = join(dir, "live");
	await mkdir(liveDir, { recursive: true });
	const faux = fauxProvider();
	const respond: import("@earendil-works/pi-ai").FauxResponseFactory = (context) => {
		const userText = JSON.stringify(context.messages.find((m) => m.role === "user") ?? "");
		const results = context.messages.filter((m) => m.role === "toolResult");
		if (userText.includes("coordinate four")) {
			return results.length
				? fauxAssistantMessage("all four survived")
				: fauxAssistantMessage(
						Array.from({ length: 4 }, (_, i) =>
							fauxToolCall("subagent", { type: "explore", title: `Agent ${i}`, task: `inspect-${i}` }),
						),
						{ stopReason: "toolUse" },
					);
		}
		if (userText.includes("inspect-3")) {
			return fauxAssistantMessage("queued child done");
		}
		return results.length
			? fauxAssistantMessage("approved child done")
			: fauxAssistantMessage([fauxToolCall("bash", { command: "printf ok" })], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 20 }, () => respond));

	const reports: unknown[] = [];
	const makeOptions = (storagePath: string) => ({
		storagePath,
		cwd: dir,
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		onReport: (_err: unknown, report: unknown) => {
			if (report) reports.push(report);
		},
	});

	const waitUntil = async (check: () => Promise<boolean>, label: string) => {
		const end = Date.now() + 8000;
		while (Date.now() < end) {
			if (await check()) return;
			await sleep(10);
		}
		throw new Error(`Timed out waiting for ${label}`);
	};

	let runtime = await createNekoRuntime(makeOptions(join(liveDir, "db.sqlite")));
	try {
		const job = await runtime.submit("coordinate four");
		await waitUntil(async () => {
			const delegations = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
			if (delegations.length !== 4) return false;
			const approvals = (await runtime.harness.snapshot(ApprovalsDoc, runtime.root.id, runtime.context))?.items.filter(
				(a) => a.status === "pending",
			);
			if (approvals?.length !== 3) return false;
			const parents = await Promise.all(
				delegations.map((d) => runtime.harness.getTask(d.taskId as never, runtime.context)),
			);
			const runners = await Promise.all(
				delegations.map((d) => runtime.harness.getTask(d.runnerId as never, runtime.context)),
			);
			const bashTasks = await Promise.all(
				approvals.map((a) => runtime.harness.getTask(a.id as never, runtime.context)),
			);
			return (
				parents.every((t) => t?.state.status === "waiting") &&
				runners.every((t) => t?.state.status === "sleeping") &&
				bashTasks.every((t) => t?.state.status === "sleeping")
			);
		}, "initial parked/sleeping state");

		let currentDir = liveDir;
		for (let i = 1; i <= DEFAULT_RESTART_LIMIT + 1; i++) {
			const crashDir = join(dir, `crash-${i}`);
			await cp(currentDir, crashDir, { recursive: true });
			await runtime.close();
			currentDir = crashDir;
			runtime = await createNekoRuntime(makeOptions(join(currentDir, "db.sqlite")));
			await waitUntil(async () => {
				const delegations = await listDelegations(runtime.harness, runtime.root.id, runtime.context);
				const approvals = (
					await runtime.harness.snapshot(ApprovalsDoc, runtime.root.id, runtime.context)
				)?.items.filter((a) => a.status === "pending");
				if (delegations.length !== 4 || approvals?.length !== 3) return false;
				const allIds = [
					...delegations.map((d) => d.taskId),
					...delegations.map((d) => d.runnerId!),
					...approvals.map((a) => a.id),
				];
				const tasks = await Promise.all(allIds.map((id) => runtime.harness.getTask(id as never, runtime.context)));
				return tasks.every(
					(t) => (t?.state.status === "waiting" || t?.state.status === "sleeping") && t.restarts === undefined,
				);
			}, `steady state after crash ${i}`);
		}

		expect(reports).toEqual([]);
		expect((await runtime.harness.snapshot(SlotsDoc, runtime.context))?.waiters).toHaveLength(1);

		const pendingApprovals = (await runtime.harness.snapshot(
			ApprovalsDoc,
			runtime.root.id,
			runtime.context,
		))!.items.filter((a) => a.status === "pending");
		for (const a of pendingApprovals) {
			await runtime.approvals.decide(runtime.root.id, a.delegationTaskId, a.id, a.version, "allowed", runtime.context);
		}
		const resumed = await runtime.harness.submission(job.id, runtime.context);
		expect(await runtime.waitAnswer(resumed!)).toEqual({ status: "done", text: "all four survived" });
		expect((await listDelegations(runtime.harness, runtime.root.id, runtime.context)).map((d) => d.status)).toEqual([
			"completed",
			"completed",
			"completed",
			"completed",
		]);
		expect(await runtime.harness.snapshot(SlotsDoc, runtime.context)).toEqual({ items: [], waiters: [] });
		expect(reports).toEqual([]);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 45000);
