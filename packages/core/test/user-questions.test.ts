import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import type { QuestionResponse } from "../src/interactions.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";
import { createAskUserTool, QuestionDoc, QuestionsDoc } from "../src/user-questions.ts";

const model = { provider: "faux", modelId: "faux-1" };
type Args = Parameters<typeof fauxToolCall>[1];
const ask = (args: Args) => fauxAssistantMessage([fauxToolCall("ask_user", args)], { stopReason: "toolUse" });
const single: Args = {
	question: "Which database?",
	options: [
		{ id: "pg", label: "PostgreSQL", recommended: true },
		{ id: "my", label: "MySQL" },
		{ id: "lite", label: "SQLite", description: "Embedded" },
	],
};
const multi: Args = { ...single, question: "Which features?", multiple: true };

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what = "state"): Promise<T> {
	const end = Date.now() + 10_000;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}
const firstPending = async (runtime: NekoRuntime, session = runtime.root) => {
	const list = await until(
		() => session.questions(),
		(l) => l.pending.length > 0,
		"a pending question",
	);
	return list.pending[0]!;
};
async function results(runtime: NekoRuntime, id?: number) {
	const target =
		id === undefined ? runtime.conversation : (await runtime.harness.conversation(id as never, runtime.context))!;
	const page = await target.entries({ order: "ascending" }, 500, undefined, runtime.context);
	return page.items.flatMap((entry) => entry.model ?? []).flatMap((m) => (m.role === "toolResult" ? [m] : []));
}
const userMessages = async (runtime: NekoRuntime) => {
	const page = await runtime.conversation.entries({ order: "ascending" }, 500, undefined, runtime.context);
	return page.items.flatMap((entry) => entry.model ?? []).filter((m) => m.role === "user");
};
const text = (m: { content: { type: string; text?: string }[] }) => m.content.map((c) => c.text ?? "").join("");
const answer = (optionIds?: string[], answerText?: string): QuestionResponse => ({
	kind: "answer",
	...(optionIds ? { optionIds } : {}),
	...(answerText !== undefined ? { text: answerText } : {}),
});
const open = (faux: ReturnType<typeof fauxProvider>, extra: Record<string, unknown> = {}) =>
	createNekoRuntime({ storage: "memory", providers: [faux.provider], model, ...extra });

it("answers a single choice with extra text and returns labels, ids and the user's words to the model", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single), fauxAssistantMessage("noted")]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("set up storage");
		const q = await firstPending(runtime);
		expect(q.preview).toBe("Which database?");
		expect(q.optionCount).toBe(3);
		expect(runtime.root.questions().then((l) => l.revision)).resolves.toBeGreaterThan(0);
		const record = await runtime.root.question(q.id);
		expect(record).toMatchObject({ status: "pending", multiple: false, answer: null });
		expect(record!.options[0]).toMatchObject({ id: "pg", recommended: true });
		const settled = await runtime.root.respondQuestion(q.id, q.version, answer(["lite"], "but keep it small"));
		expect(settled).toMatchObject({ status: "answered", answer: { optionIds: ["lite"], text: "but keep it small" } });
		expect(await runtime.waitAnswer(job)).toEqual({ status: "done", text: "noted" });
		const [result] = await results(runtime);
		expect(text(result!)).toContain('- "SQLite" (id: lite)');
		expect(text(result!)).toContain("but keep it small");
		expect(result!.isError).toBe(false);
		expect(result!.details).toMatchObject({
			status: "answered",
			optionIds: ["lite"],
			labels: ["SQLite"],
			multiple: false,
		});
		expect(await userMessages(runtime)).toHaveLength(1);
		expect((await runtime.root.questions()).pending).toEqual([]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("supports multiple selection in option order, text-only answers and option-less questions", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(multi), ask({ question: "Anything else?" }), fauxAssistantMessage("ok")]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const a = await firstPending(runtime);
		await runtime.root.respondQuestion(a.id, a.version, answer(["lite", "pg"]));
		const b = await until(
			() => runtime.root.questions(),
			(l) => l.pending.length === 1 && l.pending[0]!.id !== a.id,
		).then((l) => l.pending[0]!);
		expect(b.optionCount).toBe(0);
		await runtime.root.respondQuestion(b.id, b.version, answer(undefined, "No, thanks"));
		await runtime.waitAnswer(job);
		const [first, second] = await results(runtime);
		expect(text(first!)).toContain('- "PostgreSQL" (id: pg)\n- "SQLite" (id: lite)');
		expect(text(second!)).toContain("No, thanks");
		expect(text(second!)).not.toContain("Selected options");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("tells the model a skip is not consent, and the run was not stopped", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single), fauxAssistantMessage("assuming SQLite")]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		expect(await runtime.root.respondQuestion(q.id, q.version, { kind: "skip" })).toMatchObject({
			status: "skipped",
			answer: null,
		});
		expect(await runtime.waitAnswer(job)).toEqual({ status: "done", text: "assuming SQLite" });
		const [result] = await results(runtime);
		expect(text(result!)).toContain("skipped");
		expect(text(result!)).toContain("not approval");
		expect(result!.details).toMatchObject({ status: "skipped" });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("rejects invalid arguments without creating a pending question", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		ask({
			question: "Q",
			options: [
				{ id: "a", label: "A" },
				{ id: "a", label: "B" },
			],
		}),
		ask({ question: "  " }),
		ask({ question: "Q", multiple: true, options: [{ id: "a", label: "A" }] }),
		ask({
			question: "Q",
			options: [
				{ id: "a", label: "A" },
				{ id: "b", label: "a" },
				{ id: "c", label: "A " },
			],
		}),
		ask({ question: "Q", mystery: true }),
		fauxAssistantMessage("giving up"),
	]);
	const runtime = await open(faux);
	try {
		await runtime.waitAnswer(await runtime.submit("go"));
		const out = await results(runtime);
		expect(out).toHaveLength(5);
		expect(out.every((m) => m.isError)).toBe(true);
		expect(await runtime.root.questions()).toEqual({ revision: 0, pending: [] });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("rejects a ninth pending question without dropping existing ones", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single)]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		const owner = await runtime.harness.commit(async (tx) => (await tx.task(q.id as never))!.owner!, runtime.context);
		const fake = [901, 902, 903, 904, 905, 906, 907];
		await runtime.harness.commit(async (tx) => {
			for (const id of fake) {
				const record = await tx.doc(QuestionDoc, runtime.root.id, String(id), {
					id,
					callId: `c${id}`,
					version: `v${id}`,
					question: "fake",
					multiple: false,
					options: [],
					status: "pending",
					answer: null,
					createdAt: 1,
					settledAt: null,
				});
				expect(record.version).toBe(`v${id}`);
			}
			const index = await tx.doc(QuestionsDoc, runtime.root.id);
			index.pending = [q.id, ...fake];
			index.revision += 1;
		}, runtime.context);
		const before = await runtime.harness.snapshot(QuestionsDoc, runtime.root.id, runtime.context);
		expect(before!.pending).toHaveLength(8);
		const args = { question: "Ninth?", multiple: false, options: [] };
		await expect(runtime.questions.ensure(runtime.root.id, owner, "call-9", args, runtime.context)).rejects.toThrow(
			/Too many unanswered questions/,
		);
		expect(await runtime.harness.snapshot(QuestionsDoc, runtime.root.id, runtime.context)).toEqual(before!);
		expect(
			await runtime.harness.snapshot(QuestionDoc, runtime.root.id, String(owner), runtime.context),
		).toBeUndefined();
		await runtime.harness.commit(async (tx) => {
			const index = await tx.doc(QuestionsDoc, runtime.root.id);
			index.pending = index.pending.filter((id) => id !== 907);
		}, runtime.context);
		const eighth = await runtime.questions.ensure(runtime.root.id, owner, "call-8", args, runtime.context);
		expect(eighth.status).toBe("pending");
		expect((await runtime.harness.snapshot(QuestionsDoc, runtime.root.id, runtime.context))!.pending).toHaveLength(8);
		await runtime.abort();
		await runtime.waitAnswer(job);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("settles once: concurrent answers return the same winner and later requests do not overwrite it", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single), fauxAssistantMessage("done")]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		const outcomes = await Promise.all([
			runtime.root.respondQuestion(q.id, q.version, answer(["pg"])),
			runtime.root.respondQuestion(q.id, q.version, answer(undefined, "my own")),
			runtime.root.respondQuestion(q.id, q.version, { kind: "skip" }),
		]);
		expect(new Set(outcomes.map((o) => JSON.stringify(o))).size).toBe(1);
		const winner = outcomes[0]!;
		expect(winner.status).not.toBe("pending");
		expect(await runtime.root.respondQuestion(q.id, q.version, answer(["my"]))).toEqual(winner);
		await expect(runtime.root.respondQuestion(q.id, q.version, answer(["nope"]))).rejects.toThrow(/Unknown option/);
		await runtime.waitAnswer(job);
		expect(await runtime.root.question(q.id)).toEqual(winner);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("rejects wrong versions, other sessions, unknown ids and invalid answers before any effect", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single), fauxAssistantMessage("done")]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		const other = await runtime.createConversation();
		await expect(runtime.root.respondQuestion(q.id, "stale", answer(["pg"]))).rejects.toThrow(/changed/);
		await expect(other.respondQuestion(q.id, q.version, answer(["pg"]))).rejects.toThrow(/not found/);
		await expect(runtime.root.respondQuestion(q.id + 1000, q.version, answer(["pg"]))).rejects.toThrow(/not found/);
		await expect(runtime.root.respondQuestion(q.id, q.version, answer(["pg", "my"]))).rejects.toThrow(/only one/);
		await expect(runtime.root.respondQuestion(q.id, q.version, answer())).rejects.toThrow(/Choose an option/);
		await expect(runtime.root.respondQuestion(q.id, q.version, answer(undefined, "   "))).rejects.toThrow(
			/Choose an option/,
		);
		await expect(runtime.root.respondQuestion(q.id, q.version, answer(undefined, "t".repeat(4001)))).rejects.toThrow(
			/too long/,
		);
		expect(await other.question(q.id)).toBeUndefined();
		expect((await other.questions()).pending).toEqual([]);
		expect(await runtime.root.question(q.id)).toMatchObject({ status: "pending" });
		await runtime.root.respondQuestion(q.id, q.version, answer(["my"]));
		await runtime.waitAnswer(job);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("cancels on stop: late answers get the cancelled record and start nothing", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single)]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		await runtime.abort();
		await runtime.waitAnswer(job);
		const late = await runtime.root.respondQuestion(q.id, q.version, answer(["pg"]));
		expect(late.status).toBe("cancelled");
		expect(late.answer).toBeNull();
		expect(await runtime.root.questions()).toMatchObject({ pending: [] });
		expect((await runtime.root.question(q.id))!.status).toBe("cancelled");
		await Bun.sleep(100);
		expect((await runtime.listConversations())[0]!.status).not.toBe("running");
		expect(await userMessages(runtime)).toHaveLength(1);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("keeps an answer that was saved before the stop and still stops the run", async () => {
	const faux = fauxProvider();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		ask(single),
		async () => {
			await gate;
			return fauxAssistantMessage("late reply");
		},
	]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		await runtime.root.respondQuestion(q.id, q.version, answer(["pg"]));
		await until(
			async () => (await results(runtime)).length,
			(n) => n === 1,
			"tool result",
		);
		const stopping = runtime.abort();
		release();
		await stopping;
		await runtime.waitAnswer(job);
		expect(await runtime.root.question(q.id)).toMatchObject({ status: "answered", answer: { optionIds: ["pg"] } });
		expect(await userMessages(runtime)).toHaveLength(1);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("reconciles a question whose run stopped while nobody listened", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-question-stale-"));
	const faux = fauxProvider();
	faux.setResponses([ask(single)]);
	const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], model };
	let runtime = await createNekoRuntime(options);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		await runtime.abort();
		await runtime.waitAnswer(job);
		await runtime.close();
		runtime = await createNekoRuntime(options);
		expect(await runtime.root.questions()).toMatchObject({ pending: [] });
		expect((await runtime.root.question(q.id))!.status).toBe("cancelled");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("keeps a pending question across a SQLite reopen with the same identity and continues after the answer", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-question-restart-"));
	const faux = fauxProvider();
	faux.setResponses([ask(multi), fauxAssistantMessage("continued")]);
	const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], model };
	let runtime = await createNekoRuntime(options);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		await Bun.sleep(50);
		await runtime.close();
		runtime = await createNekoRuntime(options);
		const again = await firstPending(runtime);
		expect(again).toMatchObject({ id: q.id, version: q.version, multiple: true, optionCount: 3 });
		expect((await runtime.root.questions()).pending).toHaveLength(1);
		await runtime.root.respondQuestion(q.id, q.version, answer(["pg", "my"], "both"));
		expect(await runtime.waitAnswer((await runtime.harness.submission(job.id, runtime.context))!)).toEqual({
			status: "done",
			text: "continued",
		});
		const out = await results(runtime);
		expect(out).toHaveLength(1);
		expect(text(out[0]!)).toContain("both");
		expect(await userMessages(runtime)).toHaveLength(1);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

for (const breakpoint of ["before-question", "answer-saved"] as const) {
	it(`recovers at ${breakpoint} without a second question or a lost answer`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "neko-question-break-"));
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
		let questions!: () => NekoRuntime["questions"];
		let first = true;
		const hold = defineExtension({
			name: "test-question-breakpoint",
			wraps: [
				wrapTool(
					createAskUserTool(() => questions()),
					(base) => ({
						...base,
						execute: async (args, api, ctx) => {
							if (first && breakpoint === "before-question") {
								first = false;
								await pause(ctx);
							}
							const result = await base.execute(args, api, ctx);
							if (first && breakpoint === "answer-saved") {
								first = false;
								await pause(ctx);
							}
							return result;
						},
					}),
				),
			],
		});
		faux.setResponses([ask(single), fauxAssistantMessage("finished")]);
		const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], extensions: [hold], model };
		let runtime = await createNekoRuntime(options);
		questions = () => runtime.questions;
		try {
			const job = await runtime.submit("go");
			let known: { id: number; version: string } | undefined;
			if (breakpoint === "answer-saved") {
				const q = await firstPending(runtime);
				known = q;
				await runtime.root.respondQuestion(q.id, q.version, answer(["my"]));
			}
			await barrier;
			await runtime.close();
			runtime = await createNekoRuntime(options);
			questions = () => runtime.questions;
			if (breakpoint === "before-question") {
				const q = await firstPending(runtime);
				expect((await runtime.root.questions()).pending).toHaveLength(1);
				await runtime.root.respondQuestion(q.id, q.version, answer(["lite"]));
			}
			await runtime.waitAnswer((await runtime.harness.submission(job.id, runtime.context))!);
			const out = await results(runtime);
			expect(out).toHaveLength(1);
			expect(text(out[0]!)).toContain(breakpoint === "answer-saved" ? "id: my" : "id: lite");
			if (known) expect((await runtime.root.question(known.id))!.version).toBe(known.version);
			expect((await runtime.root.questions()).pending).toEqual([]);
			const family = await runtime.harness.snapshot(QuestionsDoc, runtime.root.id, runtime.context);
			expect(family!.revision).toBe(2);
			expect(await userMessages(runtime)).toHaveLength(1);
		} finally {
			await runtime.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
}

it("does not let a fork see or answer the parent's open question", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single)]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		await Bun.sleep(30);
		const fork = await runtime.forkConversation(runtime.root.id);
		expect((await fork.questions()).pending).toEqual([]);
		expect(await fork.question(q.id)).toBeUndefined();
		await expect(fork.respondQuestion(q.id, q.version, answer(["pg"]))).rejects.toThrow(/not found/);
		expect(await runtime.root.question(q.id)).toMatchObject({ status: "pending" });
		await runtime.abort();
		await runtime.waitAnswer(job);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("keeps chat input queued behind the question and applies it only after the answer", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		ask(single),
		fauxAssistantMessage("after the answer"),
		fauxAssistantMessage("replied to follow-up"),
	]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		const queued = await runtime.submit("PG please", { whenBusy: "followUp" });
		const steered = await runtime.submit("hurry", { whenBusy: "steer" });
		await Bun.sleep(100);
		expect((await runtime.root.questions()).pending).toHaveLength(1);
		expect(await userMessages(runtime)).toHaveLength(1);
		expect(await results(runtime)).toHaveLength(0);
		await runtime.root.respondQuestion(q.id, q.version, answer(["pg"]));
		await runtime.waitAnswer(job);
		await runtime.waitAnswer(queued);
		await runtime.waitAnswer(steered);
		expect(
			(await userMessages(runtime)).map((m) => (typeof m.content === "string" ? m.content : text(m as never))),
		).toEqual(["go", "hurry", "PG please"]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("runs the rest of the round only after the question settles", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("ask_user", single),
				fauxToolCall("todo", { action: "replace", items: [{ id: "a", text: "x", status: "pending" }] }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		await Bun.sleep(100);
		expect((await runtime.root.todos()).revision).toBe(0);
		await runtime.root.respondQuestion(q.id, q.version, answer(["pg"]));
		await runtime.waitAnswer(job);
		expect((await runtime.root.todos()).revision).toBe(1);
		expect((await results(runtime)).map((m) => m.toolName)).toEqual(["ask_user", "todo"]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("presents consecutive questions of one round one at a time", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("ask_user", { question: "First?" }), fauxToolCall("ask_user", { question: "Second?" })],
			{
				stopReason: "toolUse",
			},
		),
		fauxAssistantMessage("done"),
	]);
	const runtime = await open(faux);
	try {
		const job = await runtime.submit("go");
		const first = await firstPending(runtime);
		expect(first.preview).toBe("First?");
		await Bun.sleep(80);
		expect((await runtime.root.questions()).pending).toHaveLength(1);
		await runtime.root.respondQuestion(first.id, first.version, answer(undefined, "one"));
		const second = await until(
			() => runtime.root.questions(),
			(l) => l.pending[0]?.preview === "Second?",
		).then((l) => l.pending[0]!);
		await runtime.root.respondQuestion(second.id, second.version, { kind: "skip" });
		await runtime.waitAnswer(job);
		expect((await results(runtime)).map((m) => m.isError)).toEqual([false, false]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("cancels pending questions when the session is archived", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single)]);
	const runtime = await open(faux);
	try {
		const session = await runtime.createConversation();
		faux.setResponses([ask(single)]);
		const job = await session.submit("go");
		const q = await firstPending(runtime, session);
		await runtime.archiveConversation(session.id);
		await session.waitAnswer(job);
		const record = await runtime.harness.snapshot(QuestionDoc, session.id, String(q.id), runtime.context);
		expect(record!.status).toBe("cancelled");
		expect((await runtime.harness.snapshot(QuestionsDoc, session.id, runtime.context))!.pending).toEqual([]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("waits on committed state only: settled before subscribing, aborted, closed, and always released", async () => {
	const { withAbortSignal } = await import("@earendil-works/chord/context");
	const faux = fauxProvider();
	faux.setResponses([ask(single), fauxAssistantMessage("done")]);
	const runtime = await open(faux);
	try {
		const watches: { closed: Promise<unknown> }[] = [];
		const watchDoc = runtime.harness.watchDoc.bind(runtime.harness) as (
			...args: unknown[]
		) => Promise<{ closed: Promise<unknown> }>;
		(runtime.harness as { watchDoc: unknown }).watchDoc = async (...args: unknown[]) => {
			const watch = await watchDoc(...args);
			if (watch) watches.push(watch);
			return watch;
		};
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		const controller = new AbortController();
		const aborted = runtime.questions.wait(runtime.root.id, q.id, withAbortSignal(controller.signal, runtime.context));
		await Bun.sleep(30);
		controller.abort(new Error("stopped by test"));
		await expect(aborted).rejects.toThrow("stopped by test");
		const settled = await runtime.root.respondQuestion(q.id, q.version, answer(["pg"]));
		await runtime.waitAnswer(job);
		expect(await runtime.questions.wait(runtime.root.id, q.id, runtime.context)).toEqual(settled);
		await expect(runtime.questions.wait(runtime.root.id, 424242, runtime.context)).rejects.toThrow(/unavailable/);
		const ended = await Promise.all(watches.map((w) => Promise.race([w.closed, Bun.sleep(1000).then(() => "LEAK")])));
		expect(watches.length).toBeGreaterThanOrEqual(3);
		expect(ended).not.toContain("LEAK");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("fails a wait explicitly when the store closes instead of hanging or inventing an answer", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single)]);
	const runtime = await open(faux);
	const q = await (async () => {
		await runtime.submit("go");
		return firstPending(runtime);
	})();
	const waiting = runtime.questions.wait(runtime.root.id, q.id, runtime.context);
	const outcome = waiting.then(
		() => "resolved",
		(error: Error) => error.message,
	);
	await Bun.sleep(30);
	await runtime.close();
	const result = await Promise.race([outcome, Bun.sleep(3000).then(() => "HUNG")]);
	expect(result).not.toBe("HUNG");
	expect(result).not.toBe("resolved");
});

it("projects the question and its settlement from persisted details, not from result text", async () => {
	const { projectChatView } = await import("../src/projection.ts");
	const faux = fauxProvider();
	faux.setResponses([ask(multi), fauxAssistantMessage("done")]);
	const runtime = await open(faux);
	const toolItem = async () => {
		const view = await runtime.root.follow();
		try {
			return projectChatView(view.value, "faux").items.find((i) => i.type === "tool" && i.name === "ask_user");
		} finally {
			view.dispose();
		}
	};
	try {
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		const pending = await until(
			toolItem,
			(item) => item?.type === "tool" && item.interaction?.kind === "ask_user" && item.interaction.status === "pending",
		);
		expect(pending).toMatchObject({
			summary: "Which features?",
			interaction: { kind: "ask_user", id: q.id, multiple: true, status: "pending" },
		});
		await runtime.root.respondQuestion(q.id, q.version, answer(["my", "pg"], "plus extras"));
		await runtime.waitAnswer(job);
		const settled = await toolItem();
		expect(settled).toMatchObject({
			phase: "done",
			isError: false,
			interaction: {
				kind: "ask_user",
				status: "answered",
				optionIds: ["pg", "my"],
				labels: ["PostgreSQL", "MySQL"],
				text: "plus extras",
				question: "Which features?",
			},
		});
	} finally {
		await runtime.close();
	}
}, 30_000);

it("summarizes todo calls and degrades unknown details to nothing", async () => {
	const { summarizeToolCall, toolInteraction } = await import("../src/projection.ts");
	expect(summarizeToolCall("todo", { action: "list" })).toEqual({ args: "Read todos" });
	expect(
		summarizeToolCall("todo", { action: "replace", items: [{ id: "a", text: "Do it", status: "in_progress" }] }),
	).toEqual({ args: "Update todos (1 items)", detail: "[~] a: Do it" });
	expect(
		summarizeToolCall("ask_user", { question: "Pick\none", options: [{ id: "a", label: "A", recommended: true }] }),
	).toEqual({
		args: "Pick one",
		detail: "Pick\none\n\n- A (recommended)",
	});
	expect(toolInteraction("ask_user", { question: "q" })).toBeUndefined();
	expect(toolInteraction("todo", { action: "replace", revision: 2, completed: 1, total: 3 })).toEqual({
		kind: "todo",
		action: "replace",
		revision: 2,
		completed: 1,
		total: 3,
	});
	expect(toolInteraction("bash", {})).toBeUndefined();
});

it("flags the directory entry while a question waits, without changing the status enum or forks", async () => {
	const faux = fauxProvider();
	faux.setResponses([ask(single), fauxAssistantMessage("done")]);
	const runtime = await open(faux);
	try {
		const before = (await runtime.listConversations())[0]!;
		expect(before.awaitingAnswer).toBe(false);
		let notified = 0;
		const stop = runtime.onDirectoryChange(() => notified++);
		const job = await runtime.submit("go");
		const q = await firstPending(runtime);
		const waiting = await until(
			() => runtime.listConversations(),
			(list) => list[0]!.awaitingAnswer,
			"awaiting flag",
		);
		expect(waiting[0]!.status).toBe("running");
		expect(notified).toBeGreaterThan(0);
		const fork = await runtime.forkConversation(runtime.root.id);
		const entry = (await runtime.listConversations()).find((c) => c.id === fork.id)!;
		expect(entry.awaitingAnswer).toBe(false);
		expect((await runtime.listConversations()).find((c) => c.id === runtime.root.id)!.awaitingAnswer).toBe(true);
		await runtime.root.respondQuestion(q.id, q.version, answer(["pg"]));
		await runtime.waitAnswer(job);
		const after = await until(
			() => runtime.listConversations(),
			(list) => !list.find((c) => c.id === runtime.root.id)!.awaitingAnswer,
			"flag cleared",
		);
		expect(after.find((c) => c.id === runtime.root.id)!.status).toBe("idle");
		stop();
	} finally {
		await runtime.close();
	}
}, 30_000);
