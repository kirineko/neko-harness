import { expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { QUEUE_UNSUPPORTED, queueClient } from "../src/client-session.ts";
import { ChatViewSchema, type NekoChat } from "../src/contract.ts";
import { cleanup, connectTestClient, makeGateway, waitFor } from "./helpers.ts";

/** The first model request blocks until the run is aborted or `release` is called. */
function holdFirstRun(target: Awaited<ReturnType<typeof makeGateway>>) {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started!: () => void;
	const active = new Promise<void>((resolve) => {
		started = resolve;
	});
	target.faux.setResponses([
		async (_context, options) => {
			started();
			await Promise.race([
				released,
				new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true })),
			]);
			return fauxAssistantMessage([fauxText("first answer")]);
		},
		...Array.from({ length: 6 }, () => fauxAssistantMessage([fauxText("next answer")])),
	]);
	return { release, active };
}

const users = (chat: NekoChat) => chat.view.value?.items.flatMap((i) => (i.type === "user" ? [i.text] : [])) ?? [];

it("shows queued inputs to every client, withdraws one and keeps the rest", async () => {
	const target = await makeGateway();
	const { release, active } = holdFirstRun(target);
	const id = String(target.gateway.runtime.root.id);
	const a = await connectTestClient(target);
	const b = await connectTestClient(target);
	try {
		const chatA = await a.attach(id);
		const chatB = await b.attach(id);
		expect(chatA.view.value?.queued).toEqual([]);
		await chatA.submit({ content: "first" });
		await active;
		await chatA.submit({ content: "steer me", whenBusy: "steer" });
		await chatB.submit({ content: "follow up" });
		await waitFor(
			() => chatA.view.value?.queued?.length === 2 && chatB.view.value?.queued?.length === 2,
			"both queued",
		);
		expect(chatA.view.value!.queued!.map((q) => [q.mode, q.preview])).toEqual([
			["steer", "steer me"],
			["followUp", "follow up"],
		]);
		expect(chatB.view.value!.queued).toEqual(chatA.view.value!.queued);
		expect(Value.Check(ChatViewSchema, chatA.view.value)).toBe(true);
		// A view from a gateway without queue visibility is still valid.
		const { queued: _queued, ...withoutQueued } = chatA.view.value!;
		expect(Value.Check(ChatViewSchema, withoutQueued)).toBe(true);

		const [steer] = chatA.view.value!.queued!;
		expect(await chatB.withdraw({ id: steer!.id })).toEqual({ result: "withdrawn", text: "steer me", images: 0 });
		await waitFor(
			() => chatA.view.value?.queued?.length === 1 && chatB.view.value?.queued?.length === 1,
			"withdrawn everywhere",
		);
		expect(chatA.view.value!.queued![0]!.preview).toBe("follow up");
		expect(chatA.view.value!.busy).toBe(true);
		expect((await chatA.withdraw({ id: steer!.id })).result).not.toBe("withdrawn");

		release();
		await waitFor(() => users(chatA).includes("follow up") && chatA.view.value?.queued?.length === 0, "placed");
		expect(users(chatA)).toEqual(["first", "follow up"]);
		expect(users(chatB)).toEqual(["first", "follow up"]);
	} finally {
		release();
		await a.close();
		await b.close();
		await cleanup(target);
	}
}, 30_000);

it("turns a queued input into a steer for every client and refuses foreign sessions", async () => {
	const target = await makeGateway();
	const { release, active } = holdFirstRun(target);
	const id = String(target.gateway.runtime.root.id);
	const a = await connectTestClient(target);
	const b = await connectTestClient(target);
	const c = await connectTestClient(target);
	try {
		const chatA = await a.attach(id);
		const chatB = await b.attach(id);
		await chatA.submit({ content: "first" });
		await active;
		await chatA.submit({ content: "plain" });
		await chatA.submit({ content: "promote me" });
		await waitFor(() => chatB.view.value?.queued?.length === 2, "queued everywhere");
		const target2 = chatB.view.value!.queued![1]!;
		const outcome = await chatB.steer({ id: target2.id });
		expect(outcome.result).toBe("steered");
		await waitFor(
			() => chatA.view.value?.queued?.some((q) => q.mode === "steer" && q.preview === "promote me") === true,
			"steer visible to the other client",
		);
		expect(chatA.view.value!.queued!.map((q) => q.mode)).toEqual(["followUp", "steer"]);
		expect(chatA.view.value!.busy).toBe(true);
		expect(await chatB.steer({ id: outcome.id! })).toEqual({ result: "steered", id: outcome.id! });
		const session = await target.gateway.runtime.createConversation();
		const foreign = await c.attach(String(session.id));
		expect((await foreign.steer({ id: outcome.id! })).result).toBe("unknown");
		release();
		await waitFor(() => users(chatA).length === 3 && chatA.view.value?.queued?.length === 0, "all placed");
		// Without a tool round the run just ends, so placement order is not asserted here (see the core test).
		expect([...users(chatA)].sort()).toEqual(["first", "plain", "promote me"]);
	} finally {
		release();
		await a.close();
		await b.close();
		await c.close();
		await cleanup(target);
	}
}, 30_000);

it("clears the queue on stop and bounds previews", async () => {
	const target = await makeGateway();
	const { active } = holdFirstRun(target);
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(String(target.gateway.runtime.root.id));
		await chat.submit({ content: "first" });
		await active;
		await chat.submit({ content: "y".repeat(50_000) });
		await waitFor(() => chat.view.value?.queued?.length === 1, "queued");
		expect(JSON.stringify(chat.view.value!.queued).length).toBeLessThan(1000);
		await chat.abort(null);
		await waitFor(() => chat.view.value?.queued?.length === 0 && chat.view.value.busy === false, "stopped");
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 30_000);

it("does not let one session withdraw another session's input", async () => {
	const target = await makeGateway();
	const { release, active } = holdFirstRun(target);
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(String(target.gateway.runtime.root.id));
		await chat.submit({ content: "first" });
		await active;
		await chat.submit({ content: "mine" });
		await waitFor(() => chat.view.value?.queued?.length === 1, "queued");
		const session = await target.gateway.runtime.createConversation();
		const other = await connectTestClient(target);
		try {
			const foreign = await other.attach(String(session.id));
			expect((await foreign.withdraw({ id: chat.view.value!.queued![0]!.id })).result).toBe("unknown");
		} finally {
			await other.close();
		}
		expect(chat.view.value!.queued).toHaveLength(1);
	} finally {
		release();
		await client.close();
		await cleanup(target);
	}
}, 30_000);

it("degrades on a gateway without queue visibility instead of failing", async () => {
	const calls: number[] = [];
	const old = {
		view: { value: { items: [] } },
		withdraw: async ({ id }: { id: number }) => void calls.push(id),
	} as unknown as NekoChat;
	const client = queueClient(old);
	expect(client.supported).toBe(false);
	expect(client.list()).toEqual([]);
	await expect(client.withdraw(1)).rejects.toThrow(QUEUE_UNSUPPORTED);
	await expect(client.steer(1)).rejects.toThrow(QUEUE_UNSUPPORTED);
	expect(calls).toEqual([]);
});
