// 断连语义（spec: 断连释放）：某前端断开后其 attachment 在已受理调用结算后释放，
// 会话本身与其他 attachment 不受影响；重连 = 重新 attach + 取最新快照，不重放历史。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ChatView } from "@neko-harness/core";
import { connectNekoGateway, startGateway } from "../src/index.ts";
import {
	cleanup,
	connectTestClient,
	connectTestWsClient,
	IS_WINDOWS,
	makeGateway,
	type TestGateway,
	testAddress,
	waitFor,
} from "./helpers.ts";

let target: TestGateway;

beforeEach(async () => {
	target = await makeGateway();
});

afterEach(async () => {
	await cleanup(target);
});

function sawAssistantText(values: readonly ChatView[], text: string): boolean {
	return values.some((view) => view.items.some((item) => item.type === "assistant" && item.text.includes(text)));
}

function sawFollowUp(values: readonly ChatView[], followUp: string, answer: string): boolean {
	return values.some((view) => {
		const items = view.items;
		const followUpIndex = items.findIndex((item) => item.type === "user" && item.text.includes(followUp));
		return (
			followUpIndex >= 0 &&
			items.slice(followUpIndex).some((item) => item.type === "assistant" && item.text.includes(answer))
		);
	});
}

describe("disconnect semantics", () => {
	it("keeps the session and the other attachment alive when one frontend disconnects", async () => {
		const stable = await connectTestClient(target);
		const dying = await connectTestWsClient(target);
		try {
			const created = await stable.management.create({});
			const stableChat = await stable.attach(created.id);
			const dyingChat = await dying.attach(created.id);

			const seenByStable: ChatView[] = [];
			stableChat.view.subscribe((value) => {
				if (value) seenByStable.push(value);
			});

			// 已受理调用：dying 提交后立即断开，回答仍应结算并推给 stable。
			await dyingChat.submit({ content: "ping" });
			await dying.close();
			await waitFor(() => sawAssistantText(seenByStable, "pong"), "断连后会话仍完成回答并推给另一端");

			// 会话不受影响：stable 可以继续提交并得到回答。
			target.faux.appendResponses([fauxAssistantMessage([fauxText("pong")])]);
			await stableChat.submit({ content: "again" });
			await waitFor(() => sawFollowUp(seenByStable, "again", "pong"), "剩余前端可继续提交");

			// 网关整体无恙：新客户端可连接并看到目录。
			const newcomer = await connectTestClient(target);
			try {
				expect(newcomer.directory.state.value?.sessions.map((s) => s.id)).toContain(created.id);
			} finally {
				await newcomer.close();
			}
		} finally {
			await stable.close();
		}
	}, 30_000);

	it("reconnect starts from the latest snapshot without replaying history", async () => {
		const first = await connectTestClient(target);
		let sessionId: string;
		try {
			const created = await first.management.create({});
			sessionId = created.id;
			const chat = await first.attach(created.id);
			await chat.submit({ content: "ping" });
			await waitFor(
				() => chat.view.value?.items.some((item) => item.type === "assistant" && item.text.includes("pong")) ?? false,
				"首轮回答完成",
			);
		} finally {
			await first.close();
		}

		// 重连 = 重新 attach + 取最新快照：快照直接包含已有回答，不做历史重放。
		const second = await connectTestClient(target);
		try {
			const chat = await second.attach(sessionId);
			const snapshot = chat.view.value;
			expect(snapshot?.items.some((item) => item.type === "user" && item.text.includes("ping"))).toBe(true);
			expect(snapshot?.items.some((item) => item.type === "assistant" && item.text.includes("pong"))).toBe(true);
		} finally {
			await second.close();
		}
	}, 30_000);
});

describe("stale socket takeover", () => {
	// 裸 Unix socket 语义为 网关 POSIX 专用，Windows 无 Unix 传输。
	it.skipIf(IS_WINDOWS)(
		"adopts a stale socket file left by a dead process",
		async () => {
			const socketPath = target.socketPath;
			if (socketPath === undefined) throw new Error("POSIX 测试需要 unix socket 路径");
			await target.gateway.close();

			// 模拟进程死亡遗留：真实 socket 文件存在但无人监听（bind 后 close、不删除文件）。
			await new Promise<void>((resolve, reject) => {
				const server = createServer();
				server.once("error", reject);
				server.listen(socketPath, () => {
					server.close((error) => (error ? reject(error) : resolve()));
				});
			});

			const revived = await startGateway({
				storage: "memory",
				storagePath: join(target.dir, "revived.sqlite"),
				socketPath,
				port: 0,
				serverId: target.serverId,
				model: { provider: "faux", modelId: "faux-1" },
				providers: [target.faux.provider],
			});
			try {
				const client = await connectNekoGateway(testAddress({ socketPath, serverId: target.serverId }));
				try {
					expect(client.directory.state.value?.sessions.map((s) => s.id)).toEqual(["1"]);
				} finally {
					await client.close();
				}
			} finally {
				await revived.close();
			}
		},
		30_000,
	);
});
