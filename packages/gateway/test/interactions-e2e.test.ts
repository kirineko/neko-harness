import { afterEach, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { questionsClient, todosClient } from "../src/client-session.ts";
import type { NekoChat } from "../src/contract.ts";
import { eventually, type MobileHarness, startMobileHarness } from "./mobile/harness.ts";

type Attached = { subscriptionId: string; sessionId: string };
type Question = {
	id: number;
	version: string;
	status: string;
	answer: { optionIds: string[]; text: string | null } | null;
};

const options = [
	{ id: "pg", label: "PostgreSQL" },
	{ id: "my", label: "MySQL" },
	{ id: "lite", label: "SQLite" },
];
const ask = (args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall("ask_user", args as never)], { stopReason: "toolUse" });
const todo = (items: Array<{ id: string; text: string; status: string }>) =>
	fauxAssistantMessage([fauxToolCall("todo", { action: "replace", items } as never)], { stopReason: "toolUse" });
const userTexts = (chat: NekoChat) =>
	chat.view.value?.items.flatMap((item) => (item.type === "user" ? [item.text] : [])) ?? [];
const assistantTexts = (chat: NekoChat) =>
	chat.view.value?.items.flatMap((item) => (item.type === "assistant" && item.text ? [item.text] : [])) ?? [];

let harness: MobileHarness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

it("runs a todo and a multi-choice question across desktop and phone, restart, competing answers and a queued steer", async () => {
	harness = await startMobileHarness({ storage: "sqlite" });
	harness.faux.setResponses([
		todo([
			{ id: "a", text: "Choose storage", status: "in_progress" },
			{ id: "b", text: "Write migration", status: "pending" },
		]),
		ask({ question: "Which databases?", multiple: true, options }),
		fauxAssistantMessage([fauxText("storage chosen")]),
	]);
	const device = await harness.pair();
	const sessionId = String(harness.gateway.runtime.root.id);
	let phone = await harness.connect(device);
	let desktop = await harness.desktop();
	let chat = await desktop.attach(sessionId);
	const other = await desktop.management.create({});
	let attached = await phone.call<Attached>("chat.attach", { sessionId });

	await phone.call("chat.submit", {
		subscriptionId: attached.subscriptionId,
		requestId: "e2e-1",
		text: "decide storage",
	});
	await eventually(() => questionsClient(chat).pending().length === 1, "pending question on the desktop");
	expect(
		todosClient(chat)
			.list()
			.items.map((i) => i.status),
	).toEqual(["in_progress", "pending"]);
	await eventually(
		() => desktop.directory.state.value?.sessions.find((s) => s.id === sessionId)?.awaitingAnswer === true,
		"directory flag",
	);
	// Another session is not affected by it.
	expect(desktop.directory.state.value?.sessions.find((s) => s.id === other.id)).toMatchObject({
		status: "idle",
		awaitingAnswer: false,
	});

	// A steer submitted while the question waits is queued and not placed.
	await phone.call("chat.submit", {
		subscriptionId: attached.subscriptionId,
		requestId: "e2e-steer",
		text: "also keep it cheap",
		mode: "steer",
	});
	await eventually(() => chat.view.value?.queued?.length === 1, "steer queued");
	await Bun.sleep(150);
	expect(userTexts(chat)).toEqual(["decide storage"]);
	const before = questionsClient(chat).pending()[0]!;

	// The gateway restarts while the question waits; nothing is lost or asked twice.
	await harness.restart();
	phone = await harness.connect(device);
	desktop = await harness.desktop();
	chat = await desktop.attach(sessionId);
	attached = await phone.call<Attached>("chat.attach", { sessionId });
	await eventually(() => questionsClient(chat).pending().length === 1, "question after restart");
	expect(questionsClient(chat).pending()[0]).toMatchObject({ id: before.id, version: before.version });
	expect(todosClient(chat).list().items).toHaveLength(2);
	expect(chat.view.value?.queued).toHaveLength(1);
	expect(chat.view.value?.busy).toBe(true);
	expect(userTexts(chat)).toEqual(["decide storage"]);

	// The desktop and the phone answer at the same time; one saved decision wins for both.
	const [byDesktop, byPhone] = await Promise.all([
		questionsClient(chat).respond({
			id: before.id,
			version: before.version,
			response: { kind: "answer", optionIds: ["pg", "lite"] },
		}),
		phone.call<Question>("questions.respond", {
			subscriptionId: attached.subscriptionId,
			id: before.id,
			version: before.version,
			response: { kind: "answer", optionIds: ["my"], text: "phone note" },
		}),
	]);
	expect(byPhone).toEqual(byDesktop);
	expect(byDesktop.status).toBe("answered");
	await eventually(
		() => chat.view.value?.busy === false && assistantTexts(chat).includes("storage chosen"),
		"the run finishes after the answer",
		20_000,
	);
	// One original input plus the steer; the answer created no chat input, and the steer landed after the answer.
	expect(userTexts(chat)).toEqual(["decide storage", "also keep it cheap"]);
	const order = chat.view.value!.items.map((item) =>
		item.type === "tool" ? item.name : item.type === "user" ? `user:${item.text}` : item.type,
	);
	expect(order.indexOf("user:also keep it cheap")).toBeGreaterThan(order.indexOf("ask_user"));
	expect(chat.view.value?.queued).toEqual([]);
	expect(questionsClient(chat).pending()).toEqual([]);
	await eventually(
		() => desktop.directory.state.value?.sessions.find((s) => s.id === sessionId)?.awaitingAnswer === false,
		"directory flag cleared",
	);
}, 60_000);

it("continues after a skip and fails a late answer after stop without starting anything", async () => {
	harness = await startMobileHarness();
	harness.faux.setResponses([
		ask({ question: "Skip me?", options }),
		fauxAssistantMessage([fauxText("assumed pg")]),
		ask({ question: "Stop me?" }),
	]);
	const desktop = await harness.desktop();
	const sessionId = String(harness.gateway.runtime.root.id);
	const chat = await desktop.attach(sessionId);

	await chat.submit({ content: "first" });
	await eventually(() => questionsClient(chat).pending().length === 1, "first question");
	const skipped = await questionsClient(chat).respond({
		id: questionsClient(chat).pending()[0]!.id,
		version: questionsClient(chat).pending()[0]!.version,
		response: { kind: "skip" },
	});
	expect(skipped).toMatchObject({ status: "skipped", answer: null });
	await eventually(() => chat.view.value?.busy === false && assistantTexts(chat).includes("assumed pg"), "continued");

	await chat.submit({ content: "second" });
	await eventually(() => questionsClient(chat).pending().length === 1, "second question");
	const open = questionsClient(chat).pending()[0]!;
	await chat.abort(null);
	await eventually(() => chat.view.value?.busy === false && questionsClient(chat).pending().length === 0, "stopped");
	const late = await questionsClient(chat).respond({ id: open.id, version: open.version, response: { kind: "skip" } });
	expect(late.status).toBe("cancelled");
	await Bun.sleep(150);
	expect(chat.view.value?.busy).toBe(false);
	expect(userTexts(chat)).toEqual(["first", "second"]);
	await eventually(
		() => desktop.directory.state.value?.sessions.find((s) => s.id === sessionId)?.awaitingAnswer === false,
		"flag cleared after stop",
	);
}, 60_000);

it("keeps a background job running while a question waits and reports it only after the answer", async () => {
	harness = await startMobileHarness();
	harness.faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("job", { action: "start", command: "sleep 1.5; printf finished", title: "quick" })],
			{
				stopReason: "toolUse",
			},
		),
		ask({ question: "Wait for it?", options }),
		fauxAssistantMessage([fauxText("answered")]),
	]);
	const desktop = await harness.desktop();
	const chat = await desktop.attach(String(harness.gateway.runtime.root.id));
	await chat.submit({ content: "start a job and ask" });
	await eventually(() => questionsClient(chat).pending().length === 1, "question while the job runs");
	await eventually(
		() => chat.view.value?.jobs?.some((job) => job.title === "quick" && job.status === "exited") === true,
		"job exited",
	);
	// The job ended while the user had not answered; its report waits behind the question like any queued input.
	await Bun.sleep(150);
	expect(chat.view.value?.busy).toBe(true);
	expect(assistantTexts(chat)).toEqual([]);
	const open = questionsClient(chat).pending()[0]!;
	await questionsClient(chat).respond({
		id: open.id,
		version: open.version,
		response: { kind: "answer", optionIds: ["pg"] },
	});
	await eventually(
		() => assistantTexts(chat).includes("answered") && chat.view.value?.busy === false,
		"the run continues after the answer",
		20_000,
	);
	// The report that arrived while the question waited was placed after the answer, as a system notice.
	const order = chat.view.value!.items.map((item) => (item.type === "tool" ? item.name : item.type));
	expect(order.indexOf("system")).toBeGreaterThan(order.lastIndexOf("ask_user"));
	expect(userTexts(chat)).toEqual(["start a job and ask"]);
}, 60_000);
