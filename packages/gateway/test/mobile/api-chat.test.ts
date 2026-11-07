import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { downloadImage, uploadImage } from "@neko-harness/core/image-transfer";
import sharp from "sharp";
import type { WebSocket } from "ws";
import { MobileAdapter } from "../../src/mobile/adapter.ts";
import { checkSchema, MOBILE_API_V1_METHODS, MOBILE_API_V1_NOTIFICATIONS } from "../../src/mobile/protocol.ts";
import { IS_WINDOWS } from "../helpers.ts";
import { eventually, type MobileHarness, rpcError, startMobileHarness } from "./harness.ts";

type Snapshot = {
	busy: boolean;
	items: Array<{ key: string; type: string; text?: string; images?: Array<{ entryId: number; contentIndex: number }> }>;
	subagents: Array<{ taskId: number; agentId: string; status: string; approvalCount: number }>;
	approvalCount: number;
};
type Attached = { subscriptionId: string; sessionId: string; snapshot: Snapshot };
type Patch = { subscriptionId: string; upserts: Array<{ type: string; text?: string }>; status?: Snapshot };

const resultOk = (method: string, value: unknown) =>
	expect(checkSchema(MOBILE_API_V1_METHODS[method]?.result as never, value)).toBe(true);
const hasAssistant = (text: string) => (params: Record<string, unknown>) =>
	(params as Patch).upserts.some((item) => item.type === "assistant" && item.text === text);

let harness: MobileHarness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe("mobile chat api", () => {
	it("attaches with a bounded snapshot, streams patches and keeps requestId submissions idempotent", async () => {
		harness = await startMobileHarness();
		harness.faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
		const device = await harness.pair();
		const phone = await harness.connect(device);
		const sessionId = String(harness.gateway.runtime.root.id);
		const attached = await phone.call<Attached>("chat.attach", { sessionId });
		resultOk("chat.attach", attached);
		const subscriptionId = attached.subscriptionId;

		expect(await phone.call<unknown>("chat.submissionStatus", { subscriptionId, requestId: "r-1" })).toEqual({
			status: "unknown",
		});
		expect(await phone.call<unknown>("chat.submit", { subscriptionId, requestId: "r-1", text: "hello" })).toEqual({
			accepted: true,
			queued: false,
		});
		const patch = await phone.notification("chat.patch", hasAssistant("pong"));
		expect(checkSchema(MOBILE_API_V1_NOTIFICATIONS["chat.patch"] as never, patch)).toBe(true);
		expect(patch.subscriptionId).toBe(subscriptionId);
		expect(await phone.call<unknown>("chat.submissionStatus", { subscriptionId, requestId: "r-1" })).toEqual({
			status: "accepted",
		});
		await phone.call("chat.submit", { subscriptionId, requestId: "r-1", text: "hello" });

		// 断线重连后以同一 requestId 重试，仍只有一条输入。
		phone.ws.terminate();
		const again = await harness.connect(device);
		const reattached = await again.call<Attached>("chat.attach", { sessionId });
		await again.call("chat.submit", { subscriptionId: reattached.subscriptionId, requestId: "r-1", text: "hello" });
		const desktop = await harness.desktop();
		const chat = await desktop.attach(sessionId);
		await eventually(() => chat.view.value?.busy === false, "idle");
		expect(chat.view.value?.items.filter((item) => item.type === "user" && item.text === "hello")).toHaveLength(1);
	}, 30_000);

	it("keeps submissions idempotent across a gateway restart", async () => {
		harness = await startMobileHarness({ storage: "sqlite" });
		harness.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		const device = await harness.pair();
		const sessionId = String(harness.gateway.runtime.root.id);
		let phone = await harness.connect(device);
		let attached = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId: attached.subscriptionId, requestId: "r-restart", text: "once" });
		await phone.notification("chat.patch", hasAssistant("first"));
		await harness.restart();
		phone = await harness.connect(device);
		attached = await phone.call<Attached>("chat.attach", { sessionId });
		const subscriptionId = attached.subscriptionId;
		expect(await phone.call<unknown>("chat.submissionStatus", { subscriptionId, requestId: "r-restart" })).toEqual({
			status: "accepted",
		});
		await phone.call("chat.submit", { subscriptionId, requestId: "r-restart", text: "once" });
		const desktop = await harness.desktop();
		const chat = await desktop.attach(sessionId);
		await eventually(() => chat.view.value?.busy === false, "idle");
		expect(chat.view.value?.items.filter((item) => item.type === "user" && item.text === "once")).toHaveLength(1);
	}, 30_000);

	it("queues a submission while busy instead of rejecting it", async () => {
		harness = await startMobileHarness();
		const hold = gate();
		harness.faux.setResponses([
			async () => {
				await hold.promise;
				return fauxAssistantMessage("first answer");
			},
			fauxAssistantMessage("second answer"),
		]);
		const phone = await harness.connect(await harness.pair());
		const { subscriptionId } = await phone.call<Attached>("chat.attach", {
			sessionId: String(harness.gateway.runtime.root.id),
		});
		expect(await phone.call<unknown>("chat.submit", { subscriptionId, requestId: "q-1", text: "one" })).toEqual({
			accepted: true,
			queued: false,
		});
		await phone.notification("chat.patch", (params) => (params as Patch).status?.busy === true);
		expect(await phone.call<unknown>("chat.submit", { subscriptionId, requestId: "q-2", text: "two" })).toEqual({
			accepted: true,
			queued: true,
		});
		hold.release();
		await phone.notification("chat.patch", hasAssistant("second answer"));
	}, 30_000);

	it("lists queued inputs in the status and withdraws one without stopping the run", async () => {
		harness = await startMobileHarness();
		const hold = gate();
		harness.faux.setResponses([
			async () => {
				await hold.promise;
				return fauxAssistantMessage("first answer");
			},
			fauxAssistantMessage("kept answer"),
		]);
		const phone = await harness.connect(await harness.pair());
		const { subscriptionId, snapshot } = await phone.call<Attached & { snapshot: Snapshot & { queued?: unknown[] } }>(
			"chat.attach",
			{ sessionId: String(harness.gateway.runtime.root.id) },
		);
		expect(snapshot.queued).toEqual([]);
		await phone.call("chat.submit", { subscriptionId, requestId: "w-1", text: "one" });
		await phone.notification("chat.patch", (params) => (params as Patch).status?.busy === true);
		await phone.call("chat.submit", { subscriptionId, requestId: "w-2", text: "drop me" });
		await phone.call("chat.submit", { subscriptionId, requestId: "w-3", text: "keep me", mode: "steer" });
		type Queued = { id: number; mode: string; preview: string; images: number };
		const queuedOf = (params: Record<string, unknown>) => (params as { status?: { queued?: Queued[] } }).status?.queued;
		const patch = await phone.notification("chat.patch", (params) => queuedOf(params)?.length === 2);
		const queued = queuedOf(patch)!;
		expect(queued.map((q) => [q.mode, q.preview, q.images])).toEqual([
			["followUp", "drop me", 0],
			["steer", "keep me", 0],
		]);
		expect(checkSchema(MOBILE_API_V1_NOTIFICATIONS["chat.patch"] as never, patch)).toBe(true);
		// 桌面前端看到同一份排队列表，并在手机撤回后同步消失。
		const desktop = await harness.desktop();
		const desktopChat = await desktop.attach(String(harness.gateway.runtime.root.id));
		await eventually(() => desktopChat.view.value?.queued?.length === 2, "desktop sees the queue");
		expect(desktopChat.view.value!.queued!.map((q) => q.id)).toEqual(queued.map((q) => q.id));

		const steered = await phone.call<{ result: string; id?: number }>("chat.steer", {
			subscriptionId,
			id: queued[0]!.id,
		});
		resultOk("chat.steer", steered);
		expect(steered.result).toBe("steered");
		const afterSteer = await phone.notification(
			"chat.patch",
			(params) => queuedOf(params)?.some((q) => q.preview === "drop me" && q.mode === "steer") === true,
		);
		expect(queuedOf(afterSteer)!.map((q) => q.mode)).toEqual(["steer", "steer"]);
		await eventually(
			() => desktopChat.view.value?.queued?.every((q) => q.mode === "steer") === true,
			"desktop sees the steer",
		);
		const droppedId = steered.id!;
		const dropped = await phone.call<unknown>("chat.withdraw", { subscriptionId, id: droppedId });
		resultOk("chat.withdraw", dropped);
		expect(dropped).toEqual({ result: "withdrawn", text: "drop me", images: 0 });
		const after = await phone.notification("chat.patch", (params) => queuedOf(params)?.length === 1);
		await eventually(() => desktopChat.view.value?.queued?.length === 1, "desktop sees the withdrawal");
		expect(queuedOf(after)![0]!.preview).toBe("keep me");
		expect(((after as unknown as Patch).status as Snapshot).busy).toBe(true);
		expect(await phone.call<{ result: string }>("chat.withdraw", { subscriptionId, id: droppedId })).not.toEqual(
			expect.objectContaining({ result: "withdrawn" }),
		);
		hold.release();
		await phone.notification("chat.patch", hasAssistant("kept answer"));
		const chat = desktopChat;
		await eventually(() => chat.view.value?.busy === false, "idle");
		expect(chat.view.value?.items.flatMap((item) => (item.type === "user" ? [item.text] : []))).toEqual([
			"one",
			"keep me",
		]);
	}, 30_000);

	it("invalidates the old subscription on re-attach and returns gone for archived sessions", async () => {
		harness = await startMobileHarness();
		harness.faux.setResponses([fauxAssistantMessage("desktop answer")]);
		const desktop = await harness.desktop();
		await desktop.workspaces.add({ path: harness.dir });
		const phone = await harness.connect(await harness.pair());
		const rootId = String(harness.gateway.runtime.root.id);
		const first = await phone.call<Attached>("chat.attach", { sessionId: rootId });
		const created = await phone.call<{ id: string }>("sessions.create", { workspace: harness.dir });
		const second = await phone.call<Attached>("chat.attach", { sessionId: created.id });
		expect(second.subscriptionId).not.toBe(first.subscriptionId);
		expect(await rpcError(phone.call("chat.history", { subscriptionId: first.subscriptionId, before: "x" }))).toBe(
			"gone",
		);
		expect(
			await rpcError(
				phone.call("chat.submit", { subscriptionId: first.subscriptionId, requestId: "stale", text: "x" }),
			),
		).toBe("gone");

		phone.notifications.length = 0;
		const chat = await desktop.attach(rootId);
		await chat.submit({ content: "desktop question" });
		await eventually(() => chat.view.value?.items.some((item) => item.type === "assistant") === true, "desktop answer");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(phone.notifications.some((entry) => entry.params.subscriptionId === first.subscriptionId)).toBe(false);

		await desktop.management.archive(created.id);
		expect(
			await rpcError(
				phone.call("chat.submit", { subscriptionId: second.subscriptionId, requestId: "late", text: "x" }),
			),
		).toBe("gone");
	}, 30_000);

	it("lists and decides subagent approvals, racing the desktop exactly once", async () => {
		harness = await startMobileHarness();
		harness.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Approval", task: "Inspect" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf approval", timeout: 30 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Child report"),
			fauxAssistantMessage("Main report"),
		]);
		const phone = await harness.connect(await harness.pair());
		const sessionId = String(harness.gateway.runtime.root.id);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "ap-1", text: "Investigate" });
		const changed = await phone.notification("approvals.changed");
		expect(checkSchema(MOBILE_API_V1_NOTIFICATIONS["approvals.changed"] as never, changed)).toBe(true);
		const listed = await phone.call<{
			approvals: Array<{ id: number; version: string; taskId: number; command: string; timeoutSeconds?: number }>;
		}>("approvals.list", { subscriptionId });
		resultOk("approvals.list", listed);
		const approval = listed.approvals[0];
		if (approval === undefined) throw new Error("missing approval");
		expect(approval).toMatchObject({ command: "printf approval", timeoutSeconds: 30 });
		expect(await phone.call<unknown>("approvals.get", { subscriptionId, id: approval.id })).toMatchObject({
			id: approval.id,
		});

		const desktop = await harness.desktop();
		await desktop.attach(sessionId);
		const [mine, theirs] = await Promise.all([
			phone.call<{ status: string }>("approvals.decide", {
				subscriptionId,
				taskId: approval.taskId,
				id: approval.id,
				version: approval.version,
				decision: "allow",
			}),
			desktop
				.subagent(approval.taskId)
				.decideApproval({ id: approval.id, version: approval.version, decision: "denied" }),
		]);
		expect(mine.status).toBe(theirs);
		const again = await phone.call<{ status: string }>("approvals.decide", {
			subscriptionId,
			taskId: approval.taskId,
			id: approval.id,
			version: approval.version,
			decision: "deny",
		});
		expect(again.status).toBe(theirs);
		await eventually(
			async () =>
				(await phone.call<{ approvals: unknown[] }>("approvals.list", { subscriptionId })).approvals.length === 0,
			"approval settled",
		);
		expect(await rpcError(phone.call("approvals.get", { subscriptionId, id: approval.id }))).toBe("not_found");
	}, 30_000);

	it("opens a subagent by identity, pages its history and refuses to stop a finished round", async () => {
		harness = await startMobileHarness();
		harness.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Inspect files" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Child report")]),
			fauxAssistantMessage([fauxText("Main report")]),
		]);
		const phone = await harness.connect(await harness.pair());
		const sessionId = String(harness.gateway.runtime.root.id);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "sa-1", text: "Investigate" });
		await phone.notification("chat.patch", hasAssistant("Main report"));
		const attached = await phone.call<Attached>("chat.attach", { sessionId });
		const round = attached.snapshot.subagents[0];
		if (round === undefined) throw new Error("missing round");
		expect(round.status).toBe("completed");
		const opened = await phone.call<{ subagentSubscriptionId: string; agentId: string; snapshot: Snapshot }>(
			"subagents.open",
			{ subscriptionId: attached.subscriptionId, agentId: round.agentId },
		);
		resultOk("subagents.open", opened);
		expect(opened.agentId).toBe(round.agentId);
		expect(opened.snapshot.items.some((item) => item.type === "user" && item.text === "Inspect files")).toBe(true);
		expect(opened.snapshot.items.some((item) => item.type === "assistant" && item.text === "Child report")).toBe(true);
		expect(
			await rpcError(phone.call("subagents.stop", { subscriptionId: attached.subscriptionId, taskId: round.taskId })),
		).toBe("gone");
		expect(
			await rpcError(phone.call("subagents.open", { subscriptionId: attached.subscriptionId, agentId: "agent-404" })),
		).toBe("not_found");
		await phone.call("subagents.close", { subagentSubscriptionId: opened.subagentSubscriptionId });
		expect(
			await rpcError(
				phone.call("subagents.history", { subagentSubscriptionId: opened.subagentSubscriptionId, before: "x" }),
			),
		).toBe("gone");
	}, 30_000);

	it("stops only the exact active round", async () => {
		harness = await startMobileHarness();
		const hold = gate();
		harness.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Slow", task: "Wait" })], {
				stopReason: "toolUse",
			}),
			async (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
				await Promise.race([
					hold.promise,
					new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true })),
				]);
				return fauxAssistantMessage("child report", { stopReason: options?.signal?.aborted ? "aborted" : "stop" });
			},
			fauxAssistantMessage("integrated"),
		]);
		const phone = await harness.connect(await harness.pair());
		const sessionId = String(harness.gateway.runtime.root.id);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "stop-1", text: "Investigate" });
		const running = await phone.notification("chat.patch", (params) =>
			((params as Patch).status?.subagents ?? []).some((round) => round.status === "running"),
		);
		const round = (running as Patch).status?.subagents[0];
		if (round === undefined) throw new Error("missing round");
		expect(await phone.call<unknown>("subagents.stop", { subscriptionId, taskId: round.taskId })).toEqual({
			stopped: true,
		});
		await phone.notification("chat.patch", (params) =>
			((params as Patch).status?.subagents ?? []).some((entry) => entry.status === "cancelled"),
		);
		hold.release();
	}, 30_000);

	it("reads attachment images in bounded chunks and rejects foreign references", async () => {
		if (IS_WINDOWS) return;
		harness = await startMobileHarness({ models: { models: [{ id: "vision", input: ["text", "image"] }] } });
		harness.faux.setResponses([fauxAssistantMessage([fauxText("An image")])]);
		const desktop = await harness.desktop();
		const sessionId = String(harness.gateway.runtime.root.id);
		const chat = await desktop.attach(sessionId);
		const bytes = await sharp(randomBytes(400 * 300 * 3), { raw: { width: 400, height: 300, channels: 3 } })
			.png()
			.toBuffer();
		const upload = await uploadImage(
			{ name: "grey.png", mimeType: "image/png", bytes },
			{
				begin: (input) => chat.beginImage(input),
				append: (input) => chat.appendImage(input),
				finish: (input) => chat.finishImage(input),
				release: (input) => chat.releaseImage(input),
			},
		);
		await chat.submit({ content: "look", images: [upload], requestId: "img-1" });
		await eventually(() => chat.view.value?.busy === false && (chat.view.value?.items.length ?? 0) > 1, "answered");

		const phone = await harness.connect(await harness.pair());
		const { subscriptionId, snapshot } = await phone.call<Attached>("chat.attach", { sessionId });
		const image = snapshot.items.find((item) => item.images !== undefined)?.images?.[0];
		if (image === undefined) throw new Error("missing image");
		const parts: Buffer[] = [];
		let offset = 0;
		let total = 0;
		for (;;) {
			const chunk = await phone.call<{ data: string; nextOffset: number; total: number; done: boolean }>("media.read", {
				subscriptionId,
				entryId: image.entryId,
				contentIndex: image.contentIndex,
				offset,
			});
			resultOk("media.read", chunk);
			const raw = Buffer.from(chunk.data, "base64");
			expect(raw.length).toBeLessThanOrEqual(65_536);
			parts.push(raw);
			offset = chunk.nextOffset;
			total = chunk.total;
			if (chunk.done) break;
		}
		const expected = await downloadImage((offset) =>
			chat.getImage({ entryId: image.entryId, contentIndex: image.contentIndex, offset }),
		);
		expect(Buffer.concat(parts).equals(Buffer.from(expected.bytes))).toBe(true);
		expect(total).toBeGreaterThan(65_536);
		expect(
			await rpcError(phone.call("media.read", { subscriptionId, entryId: 99_999, contentIndex: 0, offset: 0 })),
		).toBe("invalid_params");
	}, 30_000);

	it("keeps accepted work running when the device is revoked right after submitting", async () => {
		harness = await startMobileHarness();
		const hold = gate();
		harness.faux.setResponses([
			async () => {
				await hold.promise;
				return fauxAssistantMessage("finished anyway");
			},
		]);
		const device = await harness.pair();
		const phone = await harness.connect(device);
		const sessionId = String(harness.gateway.runtime.root.id);
		const { subscriptionId } = await phone.call<Attached>("chat.attach", { sessionId });
		await phone.call("chat.submit", { subscriptionId, requestId: "rv-1", text: "work" });
		expect(await harness.gateway.mobile.revoke(device.deviceId)).toBe(true);
		expect((await phone.ws.waitForClose()).code).toBe(4401);
		hold.release();
		const desktop = await harness.desktop();
		const chat = await desktop.attach(sessionId);
		await eventually(
			() =>
				chat.view.value?.items.some((item) => item.type === "assistant" && item.text === "finished anyway") === true,
			"accepted run completes",
		);
	}, 30_000);
});

describe("mobile adapter transport guards", () => {
	class FakeSocket extends EventEmitter {
		bufferedAmount = 0;
		sent: string[] = [];
		closed: { code: number; reason: string } | undefined;
		send(data: string) {
			this.sent.push(data);
		}
		close(code: number, reason: string) {
			this.closed = { code, reason };
			this.emit("close");
		}
		terminate() {
			this.emit("close");
		}
	}

	const pendingState = { value: undefined, subscribe: () => () => {} };

	function adapter(socket: FakeSocket, authorized = () => true) {
		const value = new MobileAdapter({
			socket: socket as unknown as WebSocket,
			connectionId: "c-1",
			deviceId: "d-1",
			grantRevision: 1,
			serverId: "s",
			serverName: "PC",
			services: () => ({ workspaces: { state: pendingState } }) as never,
			authorized,
			onClose: () => {},
		});
		value.start();
		socket.emit(
			"message",
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "server.hello",
					params: { apiVersions: [1], app: { version: "1", platform: "android", build: "t" } },
				}),
			),
		);
		return value;
	}

	it("closes a slow consumer with 4408 once the send buffer exceeds the limit", () => {
		const socket = new FakeSocket();
		const value = adapter(socket);
		socket.bufferedAmount = 3 * 1024 * 1024;
		value.sendNotification("sessions.changed", { revision: 2 });
		expect(socket.closed?.code).toBe(4408);
	});

	it("answers busy_limit beyond the in-flight limit and keeps the connection open", () => {
		const socket = new FakeSocket();
		adapter(socket);
		for (let id = 2; id <= 10; id++)
			socket.emit(
				"message",
				Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "workspaces.list", params: null })),
			);
		const replies = socket.sent.slice(1).map((text) => JSON.parse(text) as unknown);
		expect(replies).toEqual([
			{
				jsonrpc: "2.0",
				id: 10,
				error: { code: -32_000, message: "too many concurrent requests", data: { code: "busy_limit" } },
			},
		]);
		expect(socket.closed).toBeUndefined();
	});

	it("closes with 4401 when the grant is no longer valid before dispatching", () => {
		const socket = new FakeSocket();
		let valid = true;
		adapter(socket, () => valid);
		valid = false;
		socket.emit(
			"message",
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspaces.list", params: null })),
		);
		expect(socket.closed?.code).toBe(4401);
	});
});
