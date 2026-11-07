import { afterEach, describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { QUESTION_LIMITS, TODO_LIMITS } from "@neko-harness/core/interactions";
import {
	checkSchema,
	MOBILE_API_V1_METHODS,
	MOBILE_API_V1_NOTIFICATIONS,
	MOBILE_CAPABILITIES,
	MOBILE_LIMITS,
} from "../../src/mobile/protocol.ts";
import { eventually, type MobileHarness, rpcError, startMobileHarness } from "./harness.ts";

type Attached = {
	subscriptionId: string;
	sessionId: string;
	snapshot: {
		busy: boolean;
		todos?: { revision: number; count: number; completed: number };
		questions?: { revision: number; pendingCount: number };
		items: Array<{ type: string; text?: string; tool?: { name: string; interaction?: { status?: string } } }>;
	};
};
type Question = {
	id: number;
	version: string;
	status: string;
	answer: { optionIds: string[]; text: string | null } | null;
	options: Array<{ id: string }>;
};
type QuestionList = { revision: number; pending: Array<{ id: number; version: string; preview: string }> };
type Patch = { upserts: Array<{ type: string; text?: string }>; status?: { busy: boolean } };

const ok = (method: string, value: unknown) =>
	expect(checkSchema(MOBILE_API_V1_METHODS[method]?.result as never, value)).toBe(true);
const askRound = (args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall("ask_user", args as never)], { stopReason: "toolUse" });
const choices = [
	{ id: "pg", label: "PostgreSQL" },
	{ id: "my", label: "MySQL" },
];

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
	return { device, phone, sessionId };
}

describe("mobile todos and questions", () => {
	it("declares the capabilities without raising the api version", () => {
		expect(MOBILE_CAPABILITIES).toContain("todos");
		expect(MOBILE_CAPABILITIES).toContain("questions");
	});

	it("reports supported-and-empty summaries on attach and serves empty lists", async () => {
		const { phone, sessionId } = await openPhone();
		const attached = await phone.call<Attached>("chat.attach", { sessionId });
		ok("chat.attach", attached);
		expect(attached.snapshot.todos).toEqual({ revision: 0, count: 0, completed: 0 });
		expect(attached.snapshot.questions).toEqual({ revision: 0, pendingCount: 0 });
		const todos = await phone.call<{ revision: number; items: unknown[] }>("todos.get", {
			subscriptionId: attached.subscriptionId,
		});
		ok("todos.get", todos);
		expect(todos).toEqual({ revision: 0, items: [] });
		const list = await phone.call<QuestionList>("questions.list", { subscriptionId: attached.subscriptionId });
		ok("questions.list", list);
		expect(list.pending).toEqual([]);
	}, 30_000);

	it("shows todos, a pending question and the awaiting flag, then settles through the dedicated method", async () => {
		const { phone, sessionId } = await openPhone();
		harness!.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("todo", { action: "replace", items: [{ id: "a", text: "Pick storage", status: "completed" }] })],
				{ stopReason: "toolUse" },
			),
			askRound({ question: "Which database?", multiple: true, options: choices }),
			fauxAssistantMessage([fauxText("decided")]),
		]);
		const attached = await phone.call<Attached>("chat.attach", { sessionId });
		const { subscriptionId } = attached;
		await phone.call("chat.submit", { subscriptionId, requestId: "q-1", text: "decide storage" });
		const changed = await phone.notification("questions.changed", () => true);
		expect(checkSchema(MOBILE_API_V1_NOTIFICATIONS["questions.changed"] as never, changed)).toBe(true);
		await phone.notification("todos.changed", () => true);
		const todos = await phone.call<{ revision: number; items: Array<{ status: string }> }>("todos.get", {
			subscriptionId,
		});
		ok("todos.get", todos);
		expect(todos.items.map((i) => i.status)).toEqual(["completed"]);
		const list = await phone.call<QuestionList>("questions.list", { subscriptionId });
		ok("questions.list", list);
		expect(list.pending).toHaveLength(1);
		expect(list.pending[0]!.preview).toBe("Which database?");
		const summary = list.pending[0]!;
		const full = await phone.call<Question>("questions.get", { subscriptionId, id: summary.id });
		ok("questions.get", full);
		expect(full.status).toBe("pending");
		expect(full.options.map((o) => o.id)).toEqual(["pg", "my"]);

		const sessions = await phone.call<{ sessions: Array<{ id: string; awaitingAnswer?: boolean }> }>("sessions.list", {
			workspace: harness!.gateway.runtime.root.id ? (await harness!.gateway.runtime.listWorkspaces())[0]!.path : "",
		});
		ok("sessions.list", sessions);
		await eventually(async () => {
			const again = await phone.call<{ sessions: Array<{ id: string; awaitingAnswer?: boolean }> }>("sessions.list", {
				workspace: (await harness!.gateway.runtime.listWorkspaces())[0]!.path,
			});
			return again.sessions.find((s) => s.id === sessionId)?.awaitingAnswer === true;
		}, "awaiting flag in the session list");

		const settled = await phone.call<Question>("questions.respond", {
			subscriptionId,
			id: summary.id,
			version: summary.version,
			response: { kind: "answer", optionIds: ["my", "pg"], text: "both, thanks" },
		});
		ok("questions.respond", settled);
		expect(settled.status).toBe("answered");
		expect(settled.answer).toEqual({ optionIds: ["pg", "my"], text: "both, thanks" });
		await phone.notification("chat.patch", (p) =>
			(p as Patch).upserts.some((i) => i.type === "assistant" && i.text === "decided"),
		);
		const desktop = await harness!.desktop();
		const chat = await desktop.attach(sessionId);
		await eventually(() => chat.view.value?.busy === false, "idle");
		expect(chat.view.value?.items.filter((i) => i.type === "user")).toHaveLength(1);
		expect(chat.view.value?.questions?.pending).toEqual([]);
		const history = await phone.call<Attached>("chat.attach", { sessionId });
		const tool = history.snapshot.items.find((i) => i.tool?.name === "ask_user");
		expect(tool?.tool?.interaction?.status).toBe("answered");
	}, 40_000);

	it("returns the saved winner for a retry or a competing desktop answer and rejects bad requests", async () => {
		const { phone, sessionId } = await openPhone();
		harness!.faux.setResponses([
			askRound({ question: "Pick", options: choices }),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "c-1", text: "go" });
		await phone.notification("questions.changed", () => true);
		const [summary] = (await phone.call<QuestionList>("questions.list", { subscriptionId })).pending;
		const desktop = await harness!.desktop();
		const chat = await desktop.attach(sessionId);
		// The desktop wins; the phone's late and repeated answers get the saved record back.
		const won = await chat.questionRespond({ id: summary!.id, version: summary!.version, response: { kind: "skip" } });
		const first = await phone.call<Question>("questions.respond", {
			subscriptionId,
			id: summary!.id,
			version: summary!.version,
			response: { kind: "answer", optionIds: ["pg"] },
		});
		const retry = await phone.call<Question>("questions.respond", {
			subscriptionId,
			id: summary!.id,
			version: summary!.version,
			response: { kind: "answer", optionIds: ["my"] },
		});
		expect(first).toEqual(won);
		expect(retry).toEqual(won);
		expect(first.status).toBe("skipped");
		expect(first.answer).toBeNull();
		await eventually(() => chat.view.value?.busy === false, "run finished");
		// Invalid combinations are refused before any effect.
		expect(
			await rpcError(
				phone.call("questions.respond", {
					subscriptionId,
					id: summary!.id,
					version: "stale",
					response: { kind: "skip" },
				}),
			),
		).toBe("rejected");
		expect(await rpcError(phone.call("questions.get", { subscriptionId, id: 987_654 }))).toBe("not_found");
		expect(
			await rpcError(
				phone.call("questions.respond", {
					subscriptionId,
					id: summary!.id,
					version: summary!.version,
					response: { kind: "answer", extra: 1 },
				}),
			),
		).toBe("invalid_params");
		expect(await rpcError(phone.call("questions.list", { subscriptionId: "chat-unknown" }))).toBe("gone");
		expect(await rpcError(phone.call("todos.get", { subscriptionId: "chat-unknown" }))).toBe("gone");
	}, 40_000);

	it("keeps one answer for a single-choice question and refuses several options", async () => {
		const { phone, sessionId } = await openPhone();
		harness!.faux.setResponses([
			askRound({ question: "Pick", options: choices }),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "s-1", text: "go" });
		await phone.notification("questions.changed", () => true);
		const [summary] = (await phone.call<QuestionList>("questions.list", { subscriptionId })).pending;
		expect(
			await rpcError(
				phone.call("questions.respond", {
					subscriptionId,
					id: summary!.id,
					version: summary!.version,
					response: { kind: "answer", optionIds: ["pg", "my"] },
				}),
			),
		).toBe("rejected");
		expect(
			await rpcError(
				phone.call("questions.respond", {
					subscriptionId,
					id: summary!.id,
					version: summary!.version,
					response: { kind: "answer" },
				}),
			),
		).toBe("rejected");
		const still = await phone.call<Question>("questions.get", { subscriptionId, id: summary!.id });
		expect(still.status).toBe("pending");
		await phone.call("questions.respond", {
			subscriptionId,
			id: summary!.id,
			version: summary!.version,
			response: { kind: "answer", text: "free text" },
		});
	}, 40_000);

	it("rejects an old subscription after switching sessions and never shows another session's question", async () => {
		const { phone, sessionId } = await openPhone();
		harness!.faux.setResponses([askRound({ question: "Private?" }), fauxAssistantMessage([fauxText("ok")])]);
		const first = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId: first.subscriptionId, requestId: "o-1", text: "go" });
		await phone.notification("questions.changed", () => true);
		const [summary] = (await phone.call<QuestionList>("questions.list", { subscriptionId: first.subscriptionId }))
			.pending;
		const workspace = (await harness!.gateway.runtime.listWorkspaces())[0]!.path;
		const created = await phone.call<{ id: string }>("sessions.create", { workspace });
		const second = await phone.call<Attached>("chat.attach", { sessionId: created.id });
		expect(await rpcError(phone.call("questions.get", { subscriptionId: first.subscriptionId, id: summary!.id }))).toBe(
			"gone",
		);
		expect(
			await rpcError(phone.call("questions.get", { subscriptionId: second.subscriptionId, id: summary!.id })),
		).toBe("not_found");
		expect(
			await rpcError(
				phone.call("questions.respond", {
					subscriptionId: first.subscriptionId,
					id: summary!.id,
					version: summary!.version,
					response: { kind: "skip" },
				}),
			),
		).toBe("gone");
		expect(
			await rpcError(
				phone.call("questions.respond", {
					subscriptionId: second.subscriptionId,
					id: summary!.id,
					version: summary!.version,
					response: { kind: "skip" },
				}),
			),
		).toBe("rejected");
		expect(
			(await phone.call<QuestionList>("questions.list", { subscriptionId: second.subscriptionId })).pending,
		).toEqual([]);
		const desktop = await harness!.desktop();
		const chat = await desktop.attach(sessionId);
		expect((await chat.questionGet({ id: summary!.id }))?.status).toBe("pending");
		await chat.abort(null);
	}, 40_000);

	it("refuses reads and answers once the device is revoked", async () => {
		const { device, phone, sessionId } = await openPhone();
		harness!.faux.setResponses([askRound({ question: "Revoked?" }), fauxAssistantMessage([fauxText("ok")])]);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "rv-1", text: "go" });
		await phone.notification("questions.changed", () => true);
		const [summary] = (await phone.call<QuestionList>("questions.list", { subscriptionId })).pending;
		expect(await harness!.gateway.mobile.revoke(device.deviceId)).toBe(true);
		expect((await phone.ws.waitForClose()).code).toBe(4401);
		const desktop = await harness!.desktop();
		const chat = await desktop.attach(sessionId);
		// Nothing was applied: the question is still open for the desktop.
		expect((await chat.questionGet({ id: summary!.id }))?.status).toBe("pending");
		await chat.abort(null);
	}, 40_000);

	it("sends a change notice for a question that appears between attach and the first query", async () => {
		const { phone, sessionId } = await openPhone();
		harness!.faux.setResponses([askRound({ question: "Late?" }), fauxAssistantMessage([fauxText("ok")])]);
		const desktop = await harness!.desktop();
		const chat = await desktop.attach(sessionId);
		const attached = await phone.call<Attached>("chat.attach", { sessionId });
		expect(attached.snapshot.questions?.pendingCount).toBe(0);
		// The question is created after the snapshot was taken; the app must hear about it.
		await chat.submit({ content: "go" });
		const notice = await phone.notification("questions.changed", () => true);
		expect(Number(notice.revision)).toBeGreaterThan(attached.snapshot.questions!.revision);
		const list = await phone.call<QuestionList>("questions.list", { subscriptionId: attached.subscriptionId });
		expect(list.revision).toBeGreaterThanOrEqual(Number(notice.revision));
		expect(list.pending).toHaveLength(1);
		await chat.abort(null);
	}, 40_000);

	it("keeps the largest todo list and question records inside the payload and frame limits", async () => {
		const { phone, sessionId } = await openPhone();
		const control = "\u0000".repeat(10);
		// Per-field limits at their maximum; the JSON byte budgets then decide what fits.
		const heavyItems = Array.from({ length: TODO_LIMITS.maxItems }, (_, i) => ({
			id: `todo-${String(i).padStart(3, "0")}`,
			text: "界".repeat(Math.floor((TODO_LIMITS.itemsBytes - 100 * 80) / 100 / 3)),
			status: "pending",
		}));
		const bigOptions = Array.from({ length: QUESTION_LIMITS.maxOptions }, (_, i) => ({
			id: `option-${i}`,
			label: `L${i}${"界".repeat(20)}`,
			description: `${control}${"d".repeat(40)}`,
		}));
		harness!.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("todo", { action: "replace", items: heavyItems })], { stopReason: "toolUse" }),
			askRound({ question: `${"界".repeat(400)}${control}`, multiple: true, options: bigOptions }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "big-1", text: "go" });
		await phone.notification("questions.changed", () => true);
		const todos = await phone.call<{ revision: number; items: unknown[] }>("todos.get", { subscriptionId });
		expect(todos.items).toHaveLength(TODO_LIMITS.maxItems);
		expect(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result: todos }))).toBeLessThan(
			MOBILE_LIMITS.maxPayloadBytes,
		);
		const [summary] = (await phone.call<QuestionList>("questions.list", { subscriptionId })).pending;
		const full = await phone.call<Question>("questions.get", { subscriptionId, id: summary!.id });
		const record = JSON.stringify({ jsonrpc: "2.0", id: 2, result: full });
		expect(Buffer.byteLength(record)).toBeLessThan(QUESTION_LIMITS.recordBytes);
		expect(Buffer.byteLength(record)).toBeLessThan(MOBILE_LIMITS.maxPayloadBytes);
		expect(full.options).toHaveLength(QUESTION_LIMITS.maxOptions);
		expect((full as unknown as { question: string }).question).toBe(`${"界".repeat(400)}${control}`);
		const settled = await phone.call<Question>("questions.respond", {
			subscriptionId,
			id: summary!.id,
			version: summary!.version,
			response: { kind: "answer", optionIds: bigOptions.map((o) => o.id), text: `${control}${"t".repeat(500)}` },
		});
		const answered = JSON.stringify({ jsonrpc: "2.0", id: 3, result: settled });
		expect(Buffer.byteLength(answered)).toBeLessThan(QUESTION_LIMITS.recordBytes);
		expect(settled.answer?.optionIds).toHaveLength(QUESTION_LIMITS.maxOptions);
		expect(settled.answer?.text).toBe(`${control}${"t".repeat(500)}`);
	}, 60_000);
});
