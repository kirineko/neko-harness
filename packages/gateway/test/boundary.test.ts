import { expect, it, spyOn } from "bun:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { GatewayConnection } from "../../web/src/client/lib/gateway.ts";
import { NekoChat } from "../src/contract.ts";
import { cleanup, connectTestClient, connectTestWsClient, makeGateway, waitFor } from "./helpers.ts";

it("closes malformed native Chord frames without affecting another client", async () => {
	const target = await makeGateway();
	const peer = await connectTestClient(target);
	const socket = new WebSocket(target.wsUrl);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", reject);
		});
		socket.send(JSON.stringify({ t: "hello", name: "bad", kind: "client", epoch: "invalid" }));
		await waitFor(() => socket.readyState === 3, "malformed frame closed", 2000);
		expect((await peer.models.list(null)).length).toBeGreaterThan(0);
	} finally {
		socket.close();
		await peer.close();
		await cleanup(target);
	}
});

it("rejects forged attachments and malformed calls before side effects, preserving a usable connection", async () => {
	const target = await makeGateway();
	const a = await connectTestClient(target);
	const b = await connectTestWsClient(target);
	try {
		const chat = await a.attach("1");
		await b.attach("1");
		await expect(b.host.get(NekoChat, a.attachment!)).rejects.toThrow("Attachment");
		const before = await target.gateway.runtime.listConversations();
		await expect(a.management.create({ cwd: 42 } as never)).rejects.toMatchObject({ code: "invalid" });
		expect(await target.gateway.runtime.listConversations()).toHaveLength(before.length);
		await expect(chat.beginImage({ name: "bad", mimeType: "image/png", size: -1 })).rejects.toMatchObject({
			code: "invalid",
		});
		const error = await a.credentials
			.save({ provider: "deepseek", key: "sensitive-test-marker".repeat(1000) })
			.catch((error) => error);
		expect(String(error)).not.toContain("sensitive-test-marker");
		expect(JSON.stringify(error)).not.toContain("sensitive-test-marker");
		expect(error.code).toBe("invalid");
		await expect(
			a.skillMarket.uninstall({ name: "missing-test-skill", scope: "project", workspaceRoot: target.dir }),
		).rejects.toMatchObject({ code: "gone", reason: "skill_not_installed" });
		const id = (await a.management.create({})).id;
		await chat.submit({ content: "valid after errors" });
		await waitFor(
			() => chat.view.value?.busy === false && chat.view.value.items.some((item) => item.type === "assistant"),
			"valid request",
		);
		await a.attach(id);
		await expect(chat.usage(null)).rejects.toThrow();
	} finally {
		await a.close();
		await b.close();
		await cleanup(target);
	}
}, 15000);
it("closes both transports and clears Web busy state after fatal storage failure", async () => {
	const target = await makeGateway();
	const peer = await connectTestClient(target);
	let view: import("@neko-harness/core").ChatView | null = null;
	const web = new GatewayConnection({
		url: target.wsUrl,
		serverId: target.serverId,
		workspaceRoot: (await target.gateway.runtime.listConversations())[0]!.workspaceRoot,
		retryBaseMs: 10000,
		events: {
			onPhase() {},
			onError() {},
			onDirectory() {},
			onWorkspaces() {},
			onWorkspace() {},
			onOperation() {},
			onModels() {},
			onSessionChange() {},
			onView(value) {
				view = value;
			},
		},
	});
	await web.start();
	const chat = await peer.attach("1");
	target.faux.setResponses([
		async (_ctx, options) => {
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				timestamp: Date.now(),
			};
		},
	]);
	let spy: ReturnType<typeof spyOn> | undefined;
	try {
		await chat.submit({ content: "hold" });
		await waitFor(() => view?.busy === true, "both busy");
		spy = spyOn(MemoryStorage.prototype, "scanEntries").mockImplementation(async () => {
			throw new Error("disk read failure");
		});
		await expect(
			target.gateway.runtime.conversation.entries({}, 1, undefined, target.gateway.runtime.context),
		).rejects.toThrow("disk read failure");
		expect((await target.gateway.runtime.closed).reason).toBe("failed");
		await waitFor(() => peer.link.closed && view === null, "closed links and idle Web");
		await expect(chat.submit({ content: "later" })).rejects.toThrow();
	} finally {
		spy?.mockRestore();
		web.dispose();
		await peer.close();
		await cleanup(target);
	}
}, 15000);
