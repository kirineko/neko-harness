// 多前端 attach（spec: 双前端同步 / attach 幂等）：
// Unix socket 与 WebSocket 两个客户端 attach 同一会话，一方提交，双方收到流式状态与回答。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChatView } from "@neko-harness/core";
import type { NekoGatewayClient } from "../src/index.ts";
import { cleanup, connectTestClient, connectTestWsClient, makeGateway, type TestGateway, waitFor } from "./helpers.ts";

let target: TestGateway;

beforeEach(async () => {
	target = await makeGateway();
});

afterEach(async () => {
	await cleanup(target);
});

function collect(view: { subscribe(listener: (value: ChatView | undefined) => void): () => void }): ChatView[] {
	const values: ChatView[] = [];
	view.subscribe((value) => {
		if (value) values.push(value);
	});
	return values;
}

function sawAssistantText(values: readonly ChatView[], text: string): boolean {
	return values.some((view) => view.items.some((item) => item.type === "assistant" && item.text.includes(text)));
}

function sawUserText(values: readonly ChatView[], text: string): boolean {
	return values.some((view) => view.items.some((item) => item.type === "user" && item.text.includes(text)));
}

describe("multi-frontend attach", () => {
	it("streams one submitted input to both attached frontends", async () => {
		const unix = await connectTestClient(target);
		const ws = await connectTestWsClient(target);
		try {
			const created = await unix.management.create({});
			const chatByUnix = await unix.attach(created.id);
			const chatByWs = await ws.attach(created.id);

			// attach 即得当前快照（D4：只消费"提交后的状态"）。
			expect(chatByUnix.view.value?.items).toEqual([]);
			expect(chatByWs.view.value?.items).toEqual([]);

			const seenByUnix = collect(chatByUnix.view);
			const seenByWs = collect(chatByWs.view);

			// 终端提交一条输入：双方都收到该输入及后续回答。
			await chatByUnix.submit({ content: "ping" });
			await waitFor(() => sawAssistantText(seenByUnix, "pong"), "unix 收到回答");
			await waitFor(() => sawAssistantText(seenByWs, "pong"), "ws 收到回答");
			expect(sawUserText(seenByUnix, "ping")).toBe(true);
			expect(sawUserText(seenByWs, "ping")).toBe(true);

			// 最终快照一致。
			const finalUnix = seenByUnix[seenByUnix.length - 1];
			const finalWs = seenByWs[seenByWs.length - 1];
			expect(finalUnix?.busy).toBe(false);
			expect(finalWs?.items).toEqual(finalUnix?.items);

			// usage 按会话统计。
			const usage = await chatByWs.usage(null);
			expect(usage.output).toBeGreaterThan(0);
		} finally {
			await unix.close();
			await ws.close();
		}
	}, 30_000);

	it("attach is idempotent per connection", async () => {
		const client: NekoGatewayClient = await connectTestClient(target);
		try {
			const created = await client.management.create({});
			await client.attach(created.id);
			const attachmentId = client.attachment?.attachmentId;
			const second = await client.attach(created.id);
			expect(client.attachment?.attachmentId).toBe(attachmentId);

			// 重复 attach 后订阅仍然有效（attachment 路由未变，快照照常推送）。
			const seen = collect(second.view);
			await second.submit({ content: "ping" });
			await waitFor(() => sawAssistantText(seen, "pong"), "重复 attach 后仍收到回答");
		} finally {
			await client.close();
		}
	}, 30_000);

	it("detach releases the attachment so another session can be attached", async () => {
		const client = await connectTestWsClient(target);
		try {
			const first = await client.management.create({});
			const second = await client.management.create({});
			const chat = await client.attach(first.id);
			const cwd = chat.view.value?.cwd;
			await client.detach();
			expect(client.attachment).toBeUndefined();
			const chat2 = await client.attach(second.id);
			expect(chat2.view.value?.cwd).toBe(cwd);
		} finally {
			await client.close();
		}
	}, 30_000);
});
