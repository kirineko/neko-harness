// 会话管理契约（steer/follow-up 透传 + fork）：
// - submit 的 whenBusy:"steer" 把输入插入当前工具轮之后（与 pi-durable postTools 边界一致），
//   whenBusy:"followUp" 排队到当前 run 结束（最终边界），二者经由 ChatView 的条目顺序可区分。
// - fork 从会话当前状态分叉：新会话带父会话历史、可独立继续；空会话 fork 退化为新建。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ChatItem, ChatView } from "@neko-harness/core";
import { rm } from "../../../test/temp-dir.ts";
import type { NekoGatewayClient } from "../src/index.ts";
import { cleanup, connectTestClient, makeGateway, type TestGateway, waitFor } from "./helpers.ts";

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

function indexOfItem(items: readonly ChatItem[], match: (item: ChatItem) => boolean): number {
	return items.findIndex(match);
}

describe("submit whenBusy", () => {
	it("places steer at the postTools boundary and followUp at the final boundary", async () => {
		const gateDir = await mkdtemp(join(tmpdir(), "neko-steer-test-"));
		const gateFile = join(gateDir, "go");
		// 第一轮：调用一个被闸门阻塞的 bash 工具；之后两轮分别回答 steer 与 follow-up。
		target.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: `while [ ! -f '${gateFile}' ]; do sleep 0.05; done; echo tool-done` })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxText("after tools")]),
			fauxAssistantMessage([fauxText("follow-up")]),
		]);
		const client = await connectTestClient(target);
		try {
			const chat = await client.attach("1");
			const seen = collect(chat.view);
			await chat.submit({ content: "a" });
			// 工具轮已开始（工具条目出现）但 bash 仍在等闸门：此刻会话忙碌。
			await waitFor(
				() => seen.some((view) => view.items.some((item) => item.type === "tool" && item.name === "bash")),
				"bash 工具开始运行",
			);

			await chat.submit({ content: "s", whenBusy: "steer" });
			await chat.submit({ content: "f", whenBusy: "followUp" });
			await writeFile(gateFile, "go");

			await waitFor(() => {
				const items = seen[seen.length - 1]?.items ?? [];
				return (
					items.some((item) => item.type === "assistant" && item.text.includes("after tools")) &&
					items.some((item) => item.type === "assistant" && item.text.includes("follow-up"))
				);
			}, "steer 与 follow-up 都被回答");
			const final = seen[seen.length - 1];
			expect(final?.busy).toBe(false);
			const items = final?.items ?? [];
			const at = (match: (item: ChatItem) => boolean): number => {
				const index = indexOfItem(items, match);
				expect(index).toBeGreaterThanOrEqual(0);
				return index;
			};
			const userA = at((item) => item.type === "user" && item.text === "a");
			const tool = at((item) => item.type === "tool" && item.name === "bash");
			const userS = at((item) => item.type === "user" && item.text === "s");
			const afterTools = at((item) => item.type === "assistant" && item.text.includes("after tools"));
			const userF = at((item) => item.type === "user" && item.text === "f");
			const followUp = at((item) => item.type === "assistant" && item.text.includes("follow-up"));
			// steer 在工具轮之后、postTools 回答之前；followUp 在 run 结束之后。
			expect(userA).toBeLessThan(tool);
			expect(tool).toBeLessThan(userS);
			expect(userS).toBeLessThan(afterTools);
			expect(afterTools).toBeLessThan(userF);
			expect(userF).toBeLessThan(followUp);
			await rm(gateDir, { recursive: true, force: true });
		} finally {
			await client.close();
		}
	}, 60_000);
});

describe("fork", () => {
	it("forks a session with its history and both evolve independently", async () => {
		target.faux.setResponses([fauxAssistantMessage([fauxText("pong")]), fauxAssistantMessage([fauxText("pong-2")])]);
		const client = await connectTestClient(target);
		try {
			const chat = await client.attach("1");
			const seen = collect(chat.view);
			await chat.submit({ content: "hello" });
			await waitFor(
				() => seen.some((view) => view.items.some((item) => item.type === "assistant" && item.text.includes("pong"))),
				"父会话收到回答",
			);

			// fork 当前会话：目录新增，新会话带父会话历史。
			const forked = await client.management.fork("1");
			expect(forked.id).not.toBe("1");
			await waitFor(
				() => client.directory.state.value?.sessions.some((session) => session.id === forked.id) === true,
				"fork 出现在目录",
			);
			const directory = client.directory.state.value?.sessions.map((session) => session.id) ?? [];
			expect(directory).toContain("1");
			expect(directory).toContain(forked.id);

			const forkChat = await client.attach(forked.id);
			const forkSeen = collect(forkChat.view);
			const forkItems = forkSeen[0]?.items ?? [];
			expect(forkItems.some((item) => item.type === "user" && item.text === "hello")).toBe(true);
			expect(forkItems.some((item) => item.type === "assistant" && item.text.includes("pong"))).toBe(true);

			// 分叉后各自独立演进：fork 提交新输入并收到第二个回答。
			await forkChat.submit({ content: "again" });
			await waitFor(
				() => (forkSeen[forkSeen.length - 1]?.items.length ?? 0) >= forkItems.length + 2,
				"fork 会话收到新回答",
			);

			// 父会话快照不受影响（forkChat 的新输入不在其中）。
			const parentAgain = await client.attach("1");
			const parentItems = parentAgain.view.value?.items ?? [];
			expect(parentItems.some((item) => item.type === "user" && item.text === "again")).toBe(false);
			expect(parentItems.length).toBe(2);
		} finally {
			await client.close();
		}
	}, 60_000);

	it("fork of an empty session falls back to create", async () => {
		const client: NekoGatewayClient = await connectTestClient(target);
		try {
			const empty = await client.management.create({});
			const forked = await client.management.fork(empty.id);
			expect(forked.id).not.toBe(empty.id);
			const chat = await client.attach(forked.id);
			expect(chat.view.value?.items).toEqual([]);
		} finally {
			await client.close();
		}
	}, 30_000);
});
