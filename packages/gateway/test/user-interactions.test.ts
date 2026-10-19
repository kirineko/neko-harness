import { expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { QUESTIONS_UNSUPPORTED, questionsClient, TODOS_UNSUPPORTED, todosClient } from "../src/client-session.ts";
import {
	ChatViewSchema,
	DirectoryStateSchema,
	type NekoChat,
	QuestionRecordSchema,
	QuestionResponseSchema,
} from "../src/contract.ts";
import { cleanup, connectTestClient, makeGateway, waitFor } from "./helpers.ts";

const options = [
	{ id: "pg", label: "PostgreSQL", recommended: true },
	{ id: "my", label: "MySQL" },
];
const askRound = (args: Record<string, unknown> = { question: "Which database?", options }) =>
	fauxAssistantMessage([fauxToolCall("ask_user", args as never)], { stopReason: "toolUse" });
const toolItems = (chat: NekoChat) => chat.view.value?.items.filter((i) => i.type === "tool") ?? [];
const users = (chat: NekoChat) => chat.view.value?.items.flatMap((i) => (i.type === "user" ? [i.text] : [])) ?? [];
const pendingId = (chat: NekoChat) => chat.view.value?.questions?.pending[0];

it("publishes todos and questions as optional supported fields and keeps the view schema valid", async () => {
	const target = await makeGateway();
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(String(target.gateway.runtime.root.id));
		expect(chat.view.value?.todos).toEqual({ revision: 0, items: [] });
		expect(chat.view.value?.questions).toEqual({ revision: 0, pending: [] });
		expect(Value.Check(ChatViewSchema, chat.view.value)).toBe(true);
		expect(todosClient(chat).supported).toBe(true);
		expect(questionsClient(chat).supported).toBe(true);
		expect(questionsClient(chat).pending()).toEqual([]);
		// A view from a gateway built before these fields is still valid.
		const { todos: _t, questions: _q, ...old } = chat.view.value!;
		expect(Value.Check(ChatViewSchema, old)).toBe(true);
		expect(Value.Check(DirectoryStateSchema, client.directory.state.value)).toBe(true);
		expect(client.directory.state.value?.sessions[0]?.awaitingAnswer).toBe(false);
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 30_000);

it("shares todos and a pending question with every client and settles it once", async () => {
	const target = await makeGateway();
	target.faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("todo", { action: "replace", items: [{ id: "a", text: "Pick storage", status: "in_progress" }] })],
			{ stopReason: "toolUse" },
		),
		askRound(),
		fauxAssistantMessage([fauxText("storage decided")]),
	]);
	const id = String(target.gateway.runtime.root.id);
	const a = await connectTestClient(target);
	const b = await connectTestClient(target);
	try {
		const chatA = await a.attach(id);
		const chatB = await b.attach(id);
		await chatA.submit({ content: "set up storage" });
		await waitFor(() => !!pendingId(chatA) && !!pendingId(chatB), "pending question on both clients");
		expect(chatA.view.value?.todos).toEqual({
			revision: 1,
			items: [{ id: "a", text: "Pick storage", status: "in_progress" }],
		});
		expect(chatB.view.value?.todos).toEqual(chatA.view.value?.todos);
		const summary = pendingId(chatA)!;
		expect(summary).toMatchObject({ preview: "Which database?", multiple: false, optionCount: 2 });
		expect(chatA.view.value!.busy).toBe(true);
		expect(Value.Check(ChatViewSchema, chatA.view.value)).toBe(true);
		const interaction = toolItems(chatA).find((t) => t.type === "tool" && t.name === "ask_user");
		expect(interaction).toMatchObject({ interaction: { kind: "ask_user", status: "pending" } });
		await waitFor(
			() => a.directory.state.value?.sessions[0]?.awaitingAnswer === true,
			"awaiting flag in the directory",
		);
		expect(a.directory.state.value?.sessions[0]?.status).toBe("running");

		const record = await chatB.questionGet({ id: summary.id });
		expect(Value.Check(QuestionRecordSchema, record)).toBe(true);
		expect(record).toMatchObject({ id: summary.id, version: summary.version, status: "pending", answer: null });
		expect(record!.options[0]).toMatchObject({ id: "pg", recommended: true });

		const outcomes = await Promise.all([
			chatA.questionRespond({
				id: summary.id,
				version: summary.version,
				response: { kind: "answer", optionIds: ["pg"] },
			}),
			chatB.questionRespond({
				id: summary.id,
				version: summary.version,
				response: { kind: "answer", optionIds: ["my"], text: "ignored loser" },
			}),
		]);
		expect(outcomes[0]).toEqual(outcomes[1]);
		expect(outcomes[0].status).toBe("answered");
		await waitFor(
			() => !pendingId(chatA) && !pendingId(chatB) && users(chatA).length === 1 && chatA.view.value?.busy === false,
			"answer settled and the run finished",
		);
		expect(users(chatA)).toEqual(["set up storage"]);
		expect(toolItems(chatB).find((t) => t.type === "tool" && t.name === "ask_user")).toMatchObject({
			isError: false,
			interaction: { kind: "ask_user", status: "answered", optionIds: outcomes[0].answer!.optionIds },
		});
		await waitFor(() => a.directory.state.value?.sessions[0]?.awaitingAnswer === false, "awaiting flag cleared");
		expect(toolItems(chatA).find((t) => t.type === "tool" && t.name === "todo")).toMatchObject({
			interaction: { kind: "todo", revision: 1, completed: 0, total: 1 },
		});
	} finally {
		await a.close();
		await b.close();
		await cleanup(target);
	}
}, 40_000);

it("rejects wrong identity, versions and answers and never leaks another session's question", async () => {
	const target = await makeGateway();
	target.faux.setResponses([askRound(), fauxAssistantMessage([fauxText("ok")])]);
	const id = String(target.gateway.runtime.root.id);
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(id);
		await chat.submit({ content: "go" });
		await waitFor(() => !!pendingId(chat), "pending question");
		const summary = pendingId(chat)!;
		const other = await client.management.create({});
		const otherChat = await client.attach(other.id);
		expect(await otherChat.questionGet({ id: summary.id })).toBeNull();
		await expect(
			otherChat.questionRespond({ id: summary.id, version: summary.version, response: { kind: "skip" } }),
		).rejects.toThrow(/not found/);
		// The first handle is stale after switching: nothing is read or applied through it.
		await expect(chat.questionGet({ id: summary.id })).rejects.toThrow();
		await expect(
			chat.questionRespond({ id: summary.id, version: summary.version, response: { kind: "skip" } }),
		).rejects.toThrow();
		const again = await client.attach(id);
		expect(await again.questionGet({ id: 424242 })).toBeNull();
		await expect(
			again.questionRespond({ id: summary.id, version: "stale", response: { kind: "skip" } }),
		).rejects.toThrow(/changed/);
		await expect(
			again.questionRespond({
				id: summary.id,
				version: summary.version,
				response: { kind: "answer", optionIds: ["pg", "my"] },
			}),
		).rejects.toThrow(/only one/);
		await expect(
			again.questionRespond({ id: summary.id, version: summary.version, response: { kind: "answer" } }),
		).rejects.toThrow(/Choose an option/);
		await expect(
			// The schema rejects it before anything reaches the question.
			again.questionRespond({ id: summary.id, version: summary.version, response: { kind: "option" } as never }),
		).rejects.toThrow();
		expect((await again.questionGet({ id: summary.id }))!.status).toBe("pending");
		await again.questionRespond({ id: summary.id, version: summary.version, response: { kind: "skip" } });
		await waitFor(() => !pendingId(again) && again.view.value?.busy === false, "finished after skip");
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("keeps the question when a client detaches and shows it again to a new one", async () => {
	const target = await makeGateway();
	target.faux.setResponses([askRound({ question: "Name it?" }), fauxAssistantMessage([fauxText("named")])]);
	const id = String(target.gateway.runtime.root.id);
	const first = await connectTestClient(target);
	const chat = await first.attach(id);
	await chat.submit({ content: "go" });
	await waitFor(() => !!pendingId(chat), "pending question");
	const summary = pendingId(chat)!;
	await first.detach();
	await first.close();
	const second = await connectTestClient(target);
	try {
		const reattached = await second.attach(id);
		await waitFor(() => pendingId(reattached)?.id === summary.id, "same question after reconnect");
		expect(pendingId(reattached)).toEqual(summary);
		expect(reattached.view.value?.busy).toBe(true);
		await reattached.questionRespond({
			id: summary.id,
			version: summary.version,
			response: { kind: "answer", text: "Neko" },
		});
		await waitFor(() => reattached.view.value?.busy === false && !pendingId(reattached), "done after the late answer");
		expect(users(reattached)).toEqual(["go"]);
	} finally {
		await second.close();
		await cleanup(target);
	}
}, 40_000);

it("cancels a question when the run is stopped and reports it to every client", async () => {
	const target = await makeGateway();
	target.faux.setResponses([askRound()]);
	const id = String(target.gateway.runtime.root.id);
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(id);
		await chat.submit({ content: "go" });
		await waitFor(() => !!pendingId(chat), "pending question");
		const summary = pendingId(chat)!;
		await chat.abort(null);
		await waitFor(() => !pendingId(chat) && chat.view.value?.busy === false, "cancelled and idle");
		const late = await chat.questionRespond({ id: summary.id, version: summary.version, response: { kind: "skip" } });
		expect(late.status).toBe("cancelled");
		expect(users(chat)).toEqual(["go"]);
		await waitFor(() => client.directory.state.value?.sessions[0]?.awaitingAnswer === false, "flag cleared");
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 40_000);

it("degrades on a gateway without the fields: no method is called and the error is explicit", async () => {
	const calls: string[] = [];
	const chat = {
		view: { value: { items: [], busy: false } },
		questionGet: async () => calls.push("get"),
		questionRespond: async () => calls.push("respond"),
	} as unknown as NekoChat;
	const questions = questionsClient(chat);
	expect(questions.supported).toBe(false);
	expect(questions.pending()).toEqual([]);
	expect(questions.revision).toBe(0);
	await expect(questions.get(1)).rejects.toThrow(QUESTIONS_UNSUPPORTED);
	await expect(questions.respond({ id: 1, version: "v", response: { kind: "skip" } })).rejects.toThrow(
		QUESTIONS_UNSUPPORTED,
	);
	expect(calls).toEqual([]);
	const todos = todosClient(chat);
	expect(todos.supported).toBe(false);
	expect(todos.list()).toEqual({ revision: 0, items: [] });
	expect(TODOS_UNSUPPORTED).toContain("todos");
	// Supported and empty is a different state from unsupported.
	const supported = {
		view: { value: { todos: { revision: 0, items: [] }, questions: { revision: 0, pending: [] } } },
	} as unknown as NekoChat;
	expect(todosClient(supported).supported).toBe(true);
	expect(questionsClient(supported).supported).toBe(true);
	expect(Value.Check(QuestionResponseSchema, { kind: "answer", optionIds: [], text: "x" })).toBe(true);
	expect(Value.Check(QuestionResponseSchema, { kind: "skip", text: "x" })).toBe(false);
});
