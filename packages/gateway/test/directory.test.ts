// 会话目录（spec: 会话目录 / 新会话广播 / 传输支持-浏览器连接）：
// 目录随创建/归档实时推送给所有已连接前端（Unix socket 与 WebSocket 两端都要收到）。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChordError } from "@earendil-works/chord";
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

async function connectUnix(): Promise<NekoGatewayClient> {
	return connectTestClient(target);
}

async function connectWs(): Promise<NekoGatewayClient> {
	return connectTestWsClient(target);
}

describe("session directory", () => {
	it("lists the root session and broadcasts create/archive to unix and ws clients", async () => {
		const unix = await connectUnix();
		const ws = await connectWs();
		try {
			// 握手 + 初始目录（root 会话 id 为 "1"）。
			expect(unix.directory.state.value?.sessions.map((s) => s.id)).toEqual(["1"]);
			expect(ws.directory.state.value?.sessions.map((s) => s.id)).toEqual(["1"]);

			const seenByUnix: Array<{ revision: number; ids: string[] }> = [];
			const seenByWs: Array<{ revision: number; ids: string[] }> = [];
			unix.directory.state.subscribe(
				(value) => value && seenByUnix.push({ revision: value.revision, ids: value.sessions.map((s) => s.id) }),
			);
			ws.directory.state.subscribe(
				(value) => value && seenByWs.push({ revision: value.revision, ids: value.sessions.map((s) => s.id) }),
			);

			// 新会话广播：两端都收到 revision 递增后的目录。
			const created = await unix.management.create({});
			await waitFor(
				() => seenByUnix.some((entry) => entry.revision >= 2 && entry.ids.includes(created.id)),
				"unix 收到新会话广播",
			);
			await waitFor(
				() => seenByWs.some((entry) => entry.revision >= 2 && entry.ids.includes(created.id)),
				"ws 收到新会话广播",
			);
			expect(unix.directory.state.value?.sessions.map((s) => s.id).sort()).toEqual(["1", created.id]);

			// 归档同样广播：两端都收到 revision 再次递增、且该会话消失的目录。
			const revisionAfterCreate = unix.directory.state.value?.revision ?? 0;
			await unix.management.archive(created.id);
			await waitFor(
				() => seenByUnix.some((entry) => entry.revision > revisionAfterCreate && !entry.ids.includes(created.id)),
				"unix 收到归档广播",
			);
			const wsRevisionAfterCreate = seenByWs.find((entry) => entry.ids.includes(created.id))?.revision ?? 0;
			await waitFor(
				() => seenByWs.some((entry) => entry.revision > wsRevisionAfterCreate && !entry.ids.includes(created.id)),
				"ws 收到归档广播",
			);

			// 归档后 attach 未知会话 → 明确的 not-found 错误。
			await expect(unix.management.attach(created.id)).rejects.toBeInstanceOf(ChordError);
		} finally {
			await unix.close();
			await ws.close();
		}
	}, 30_000);

	it("serves the projected chat snapshot over both transports", async () => {
		const unix = await connectUnix();
		try {
			const chat = await unix.attach("1");
			const view: ChatView | undefined = chat.view.value;
			expect(view).toBeDefined();
			expect(view?.model).toBe("faux/faux-1");
			expect(view?.busy).toBe(false);
			expect(view?.items).toEqual([]);
		} finally {
			await unix.close();
		}
	}, 30_000);
});

it("broadcasts background title and final-message time without requiring an attachment", async () => {
	const unix = await connectUnix(),
		ws = await connectWs();
	try {
		const { fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
		let finish!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
		target.faux.setResponses([
			() =>
				new Promise((r) => {
					finish = r;
				}),
		]);
		const chat = await unix.attach("1");
		await chat.submit({ content: "Name this session", requestId: "naming" });
		await waitFor(() => !!finish, "provider running");
		await waitFor(() => ws.directory.state.value!.sessions[0]!.lastMessageAt !== null, "input metadata");
		const sent = ws.directory.state.value!.sessions[0]!.lastMessageAt!;
		await unix.detach();
		finish(fauxAssistantMessage([fauxText("A complete answer")]));
		await waitFor(() => ws.directory.state.value!.sessions[0]?.title === "Test session", "background title");
		const info = ws.directory.state.value!.sessions[0]!;
		expect(info.firstPromptPreview).toBe("Name this session");
		expect(info.lastMessageAt).toBeGreaterThanOrEqual(sent);
		expect(info.status).toBe("idle");
		expect(unix.directory.state.value!.sessions[0]).toEqual(info);
		await unix.attach("1");
		expect(ws.directory.state.value!.sessions[0]!.lastMessageAt).toBe(info.lastMessageAt);
	} finally {
		await unix.close();
		await ws.close();
	}
});
