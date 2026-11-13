import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { TODO_LIMITS } from "../src/interactions.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";
import { createTodoTool, TodosDoc } from "../src/todos.ts";

const model = { provider: "faux", modelId: "faux-1" };
type Item = { id: string; text: string; status: "pending" | "in_progress" | "completed" };
const todo = (id: string, text: string, status: Item["status"] = "pending"): Item => ({ id, text, status });
const call = (args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage([fauxToolCall("todo", args)], { stopReason: "toolUse" });

async function results(runtime: NekoRuntime, id?: number) {
	const target =
		id === undefined ? runtime.conversation : (await runtime.harness.conversation(id as never, runtime.context))!;
	const page = await target.entries({ order: "ascending" }, 500, undefined, runtime.context);
	return page.items.flatMap((entry) => entry.model ?? []).flatMap((m) => (m.role === "toolResult" ? [m] : []));
}
const text = (m: { content: { type: string; text?: string }[] }) => m.content.map((c) => c.text ?? "").join("");

async function run(faux: ReturnType<typeof fauxProvider>, rounds: ReturnType<typeof call>[]) {
	faux.setResponses([...rounds, fauxAssistantMessage("done")]);
}

it("reads an empty list, replaces, reorders and clears while keeping ids", async () => {
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		await run(faux, [
			call({ action: "list" }),
			call({ action: "replace", items: [todo("a", "First", "in_progress"), todo("b", "Second")] }),
			call({
				action: "replace",
				items: [todo("b", "Second", "completed"), todo("a", "First", "in_progress"), todo("c", "Third")],
			}),
			call({ action: "replace", items: [] }),
		]);
		expect(await runtime.waitAnswer(await runtime.submit("plan"))).toEqual({ status: "done", text: "done" });
		const out = await results(runtime);
		expect(text(out[0]!)).toContain("empty");
		expect(text(out[1]!)).toContain("revision 1, 0/2 completed");
		expect(text(out[2]!)).toContain("1/3 completed");
		expect(text(out[2]!).indexOf("b:")).toBeLessThan(text(out[2]!).indexOf("a:"));
		expect(text(out[3]!)).toContain("empty");
		expect(await runtime.root.todos()).toEqual({ revision: 3, items: [] });
		expect(out.every((m) => !m.isError)).toBe(true);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("rejects invalid calls without touching the saved list", async () => {
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		await run(faux, [
			call({ action: "replace", items: [todo("a", "keep")] }),
			call({ action: "replace", items: [todo("x", "one"), todo("x", "two")] }),
			call({ action: "replace", items: [{ id: "y", text: "t", status: "done" }] }),
			call({ action: "replace", items: [{ ...todo("z", "t"), extra: true }] }),
			call({ action: "replace", items: [todo("a", "   ")] }),
			call({ action: "replace" }),
			call({ action: "list", items: [] }),
			call({
				action: "replace",
				items: Array.from({ length: TODO_LIMITS.maxItems + 1 }, (_, i) => todo(`i${i}`, "t")),
			}),
		]);
		await runtime.waitAnswer(await runtime.submit("plan"));
		const out = await results(runtime);
		expect(out.slice(1).every((m) => m.isError)).toBe(true);
		expect(await runtime.root.todos()).toEqual({ revision: 1, items: [todo("a", "keep")] });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("keeps lists per session and forks inherit the list as of the fork point", async () => {
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		await run(faux, [call({ action: "replace", items: [todo("a", "one")] })]);
		await runtime.waitAnswer(await runtime.submit("first"));
		const fork = await runtime.forkConversation(runtime.root.id);
		const other = await runtime.createConversation();
		expect(await other.todos()).toEqual({ revision: 0, items: [] });
		expect(await fork.todos()).toEqual({ revision: 1, items: [todo("a", "one")] });
		await run(faux, [call({ action: "replace", items: [todo("a", "one", "completed"), todo("b", "two")] })]);
		await runtime.waitAnswer(await runtime.submit("second"));
		expect((await runtime.root.todos()).revision).toBe(2);
		expect(await fork.todos()).toEqual({ revision: 1, items: [todo("a", "one")] });
		faux.setResponses([call({ action: "replace", items: [todo("f", "fork only")] }), fauxAssistantMessage("done")]);
		await fork.waitAnswer(await fork.submit("in fork"));
		expect((await fork.todos()).items).toEqual([todo("f", "fork only")]);
		expect((await runtime.root.todos()).items).toHaveLength(2);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("survives compaction and lets the model read the list again", async () => {
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		await run(faux, [call({ action: "replace", items: [todo("a", "persisted")] })]);
		await runtime.waitAnswer(await runtime.submit("plan"));
		faux.setResponses([fauxAssistantMessage("summary of the work")]);
		await runtime.compact();
		expect(await runtime.root.todos()).toEqual({ revision: 1, items: [todo("a", "persisted")] });
		await run(faux, [call({ action: "list" })]);
		await runtime.waitAnswer(await runtime.submit("what is left?"));
		const out = await results(runtime);
		expect(text(out[out.length - 1]!)).toContain("a: persisted");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("does not expose the tool to subagents and rejects it when called anyway", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "coder", title: "Work", task: "Work" })], {
			stopReason: "toolUse",
		}),
		call({ action: "replace", items: [todo("x", "from child")] }),
		fauxAssistantMessage("child report"),
		fauxAssistantMessage("main report"),
	]);
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		await runtime.waitAnswer(await runtime.submit("delegate"));
		const { listDelegations } = await import("../src/subagents.ts");
		const [round] = await listDelegations(runtime.harness, runtime.conversation.id, runtime.context);
		const child = await runtime.harness.conversation(round!.childId as never, runtime.context);
		const tools = (await child!.agent(runtime.context)).tools.map((t) => t.name);
		expect(tools).not.toContain("todo");
		expect(tools).not.toContain("ask_user");
		expect(tools).toContain("bash");
		const childResults = await results(runtime, round!.childId);
		expect(childResults.some((m) => m.isError)).toBe(true);
		expect(await runtime.root.todos()).toEqual({ revision: 0, items: [] });
		expect((await runtime.harness.snapshot(TodosDoc, round!.childId as never, runtime.context)) ?? null).toBeNull();
	} finally {
		await runtime.close();
	}
}, 30_000);

it("runs the rest of a round only after the todo call, in call order", async () => {
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("todo", { action: "replace", items: [todo("a", "one")] }),
					fauxToolCall("todo", { action: "replace", items: [todo("a", "one", "completed")] }),
					fauxToolCall("todo", { action: "list" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await runtime.waitAnswer(await runtime.submit("go"));
		const out = await results(runtime);
		expect(out.map((m) => text(m).split("\n")[0])).toEqual([
			expect.stringContaining("revision 1, 0/1"),
			expect.stringContaining("revision 2, 1/1"),
			expect.stringContaining("revision 2, 1/1"),
		]);
	} finally {
		await runtime.close();
	}
}, 30_000);

for (const interrupt of ["before-result", "after-newer-list"] as const) {
	it(`replays an applied replace from its receipt (${interrupt})`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "neko-todo-replay-"));
		const faux = fauxProvider();
		let reached!: () => void;
		const barrier = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const pause = (ctx: Context) =>
			new Promise<never>((_, reject) => {
				reached();
				const abort = () => reject(ctx.abortSignal?.reason);
				ctx.abortSignal?.addEventListener("abort", abort, { once: true });
				if (ctx.abortSignal?.aborted) abort();
			});
		let first = true;
		const crash = defineExtension({
			name: "test-todo-crash",
			wraps: [
				wrapTool(createTodoTool(), (base) => ({
					...base,
					execute: async (args, api, ctx) => {
						const result = await base.execute(args, api, ctx);
						if (first) {
							first = false;
							await pause(ctx);
						}
						return result;
					},
				})),
			],
		});
		faux.setResponses([call({ action: "replace", items: [todo("a", "first value")] }), fauxAssistantMessage("done")]);
		const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], extensions: [crash], model };
		let runtime = await createNekoRuntime(options);
		try {
			const job = await runtime.submit("plan");
			await barrier;
			if (interrupt === "after-newer-list")
				await runtime.harness.commit(async (tx) => {
					const doc = await tx.doc(TodosDoc, runtime.conversation.id);
					doc.revision = 5;
					doc.items = [todo("newer", "newer value", "completed")];
				}, runtime.context);
			await runtime.close();
			runtime = await createNekoRuntime(options);
			await runtime.waitAnswer((await runtime.harness.submission(job.id, runtime.context))!);
			const list = await runtime.root.todos();
			if (interrupt === "before-result") expect(list).toEqual({ revision: 1, items: [todo("a", "first value")] });
			else expect(list).toEqual({ revision: 5, items: [todo("newer", "newer value", "completed")] });
			const out = await results(runtime);
			expect(text(out[0]!)).toContain("revision 1, 0/1 completed");
		} finally {
			await runtime.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
}
