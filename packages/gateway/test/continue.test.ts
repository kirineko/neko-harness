import { expect, it } from "bun:test";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { CONTINUE_UNSUPPORTED, continueClient } from "../src/client-session.ts";
import { ChatViewSchema, type NekoChat } from "../src/contract.ts";
import { cleanup, connectTestClient, makeGateway, waitFor } from "./helpers.ts";

const users = (chat: NekoChat) => chat.view.value?.items.filter((item) => item.type === "user").length ?? 0;

it("shares a run failure with every client and continues it once", async () => {
	const target = await makeGateway();
	let answer = false;
	// Waits until aborted until `answer` is set, so the first run can only end by Stop.
	const respond: FauxResponseFactory = (_context, options) =>
		answer
			? fauxAssistantMessage([fauxText("continued answer")])
			: new Promise((_resolve, reject) =>
					options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				);
	target.faux.setResponses(Array.from({ length: 10 }, () => respond));
	const id = String(target.gateway.runtime.root.id);
	const a = await connectTestClient(target);
	const b = await connectTestClient(target);
	try {
		const chatA = await a.attach(id);
		const chatB = await b.attach(id);
		expect(continueClient(chatA).supported).toBe(true);
		expect(continueClient(chatA).failure()).toBeUndefined();
		await expect(continueClient(chatA).continueRun()).rejects.toThrow(/CONTINUE_UNAVAILABLE/);
		await chatA.submit({ content: "question" });
		await waitFor(() => chatB.view.value?.busy === true, "run on both clients");
		await chatB.abort(null);
		await waitFor(
			() =>
				continueClient(chatA).failure()?.reason === "aborted" && continueClient(chatB).failure()?.reason === "aborted",
			"failure on both clients",
		);
		expect(compile(ChatViewSchema).check(chatA.view.value)).toBe(true);
		const before = users(chatA);
		answer = true;
		await continueClient(chatA).continueRun();
		await waitFor(
			() =>
				chatB.view.value?.busy === false &&
				chatB.view.value.runFailure === undefined &&
				chatB.view.value.items.some((item) => item.type === "assistant" && item.text === "continued answer"),
			"continued answer on the other client",
		);
		expect(users(chatB)).toBe(before);
	} finally {
		await a.close();
		await b.close();
		await cleanup(target);
	}
}, 30_000);

it("hides continue on a gateway without it instead of failing", async () => {
	const target = await makeGateway();
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(String(target.gateway.runtime.root.id));
		const { continuable: _continuable, runFailure: _runFailure, ...old } = chat.view.value!;
		expect(compile(ChatViewSchema).check(old)).toBe(true);
		const oldChat = { view: { value: old }, continueRun: () => Promise.resolve(null) } as unknown as NekoChat;
		expect(continueClient(oldChat).supported).toBe(false);
		expect(continueClient(oldChat).failure()).toBeUndefined();
		await expect(continueClient(oldChat).continueRun()).rejects.toThrow(CONTINUE_UNSUPPORTED);
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 30_000);
