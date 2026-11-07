import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
// core 会话管理 API：列出 / 创建 / 按 id 获取 / 归档（软删除），
// 以及按会话 id 订阅 follow/watch/usage。

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { createNekoRuntime } from "../src/index.ts";

async function makeRuntime() {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
	return createNekoRuntime({
		credentials: new InMemoryCredentialStore(),
		storage: "memory",
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
}

describe("conversation management", () => {
	it("lists, creates, acquires, and archives conversations", async () => {
		const runtime = await makeRuntime();
		try {
			// Root is listed.
			const initial = await runtime.listConversations();
			expect(initial.map((info) => info.id)).toEqual([ROOT_CONVERSATION_ID]);
			expect(initial[0]!.archived).toBe(false);

			// Create: independent conversation, root's model/thinking/cwd as the starting agent.
			const created = await runtime.createConversation();
			expect(created.id).not.toBe(runtime.conversation.id);
			const listed = await runtime.listConversations();
			expect(new Set(listed.map((info) => info.id))).toEqual(new Set([ROOT_CONVERSATION_ID, created.id]));

			// Acquire by id; unknown ids yield undefined.
			const acquired = await runtime.getConversation(created.id);
			expect(acquired?.id).toBe(created.id);
			expect(await runtime.getConversation(999 as never)).toBeUndefined();

			// The created session works end to end and is subscribable by id.
			const answer = await created.waitAnswer(await created.submit("ping"));
			expect(answer).toEqual({ status: "done", text: "pong" });
			const view = await runtime.follow(created.id);
			expect(view.value.entries.length).toBeGreaterThan(0);
			view.dispose();
			const usage = await runtime.usage(created.id);
			expect(Object.keys(usage.models)).toContain("faux/faux-1");
			const watch = await runtime.watch(created.id);
			await watch.stop();

			// Archive (soft delete): hidden from listings and lookups.
			await runtime.archiveConversation(created.id);
			const after = await runtime.listConversations();
			expect(after.map((info) => info.id)).toEqual([ROOT_CONVERSATION_ID]);
			expect(await runtime.getConversation(created.id)).toBeUndefined();
			await expect(runtime.follow(created.id)).rejects.toThrow(/not available/);
		} finally {
			await runtime.close();
		}
	}, 30_000);
});
