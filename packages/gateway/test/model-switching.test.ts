import { fauxProvider } from "../../../test/faux.ts";
// spec: model-providers「会话级切换模型」——经网关契约 configure 切换某会话模型后，
// 该会话下一次请求用新模型（faux 记录实际收到的 modelId），投影即时反映新值，其他会话不受影响。

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChordError } from "@earendil-works/chord";
import {
	type FauxProviderHandle,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
} from "@earendil-works/pi-ai";
import type { ChatView } from "@neko-harness/core";
import { rm } from "../../../test/temp-dir.ts";
import { type NekoGateway, startGateway } from "../src/index.ts";
import { connectTestClient, testSocketPath, waitFor } from "./helpers.ts";

let dir: string;
let gateway: NekoGateway;
let faux: FauxProviderHandle;
let requestedModels: string[];
let socketPath: string | undefined;
let serverId: string;

/** faux 双模型网关：每个请求记录实际生效的 modelId。 */
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-gateway-models-"));
	requestedModels = [];
	const recordRequest: FauxResponseFactory = (_context, _options, _state, model) => {
		requestedModels.push(model.id);
		return fauxAssistantMessage([fauxText("pong")]);
	};
	faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2", reasoning: true }] });
	faux.setResponses([recordRequest, recordRequest, recordRequest, recordRequest]);
	serverId = randomUUID();
	socketPath = testSocketPath(dir) ?? undefined;
	gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath,
		port: 0,
		serverId,
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
});

afterEach(async () => {
	await gateway.close().catch(() => {});
	await rm(dir, { recursive: true, force: true });
});

function sawAgent(values: readonly ChatView[], modelId: string, thinkingLevel?: string): boolean {
	return values.some((view) => {
		if (view.agent.model?.modelId !== modelId) return false;
		return thinkingLevel === undefined || view.agent.thinkingLevel === thinkingLevel;
	});
}

describe("per-conversation model switching over the gateway", () => {
	it("serves the global model list from the server-level models service", async () => {
		const client = await connectTestClient(gateway);
		try {
			const models = await client.models.list(null);
			// Models registry 是全集（内置 deepseek + 注入的 faux），faux 双模型必须在列。
			const ids = models.map((model) => `${model.provider}/${model.modelId}`);
			expect(ids).toContain("faux/faux-1");
			expect(ids).toContain("faux/faux-2");
			expect(ids).toContain("deepseek/deepseek-flash");
			const second = models.find((model) => model.modelId === "faux-2");
			expect(second?.reasoning).toBe(true);
			expect(typeof second?.contextWindow).toBe("number");
		} finally {
			await client.close();
		}
	}, 30_000);

	it("configure switches the attached session's model for its next request and updates the projection", async () => {
		const client = await connectTestClient(gateway);
		try {
			const chat = await client.attach("1");
			const seen: ChatView[] = [];
			chat.view.subscribe((value) => {
				if (value) seen.push(value);
			});
			// 初始投影：宿主默认模型。
			expect(chat.view.value?.agent.model).toEqual({ provider: "faux", modelId: "faux-1" });
			expect(chat.view.value?.model).toBe("faux/faux-1");

			await chat.configure({ model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "high" });

			// 投影即时反映新值（pi.agent doc 随 configure 提交进视图，推送更新）。
			await waitFor(() => sawAgent(seen, "faux-2", "high"), "ChatView 投影更新为 faux-2/high");
			const latest = seen[seen.length - 1];
			expect(latest?.model).toBe("faux/faux-2");

			// 下一次请求 faux 实际收到 faux-2。
			await chat.submit({ content: "ping" });
			await waitFor(
				() => seen.some((view) => view.items.some((item) => item.type === "assistant" && item.text.includes("pong"))),
				"收到回答",
			);
			expect(requestedModels[requestedModels.length - 1]).toBe("faux-2");
		} finally {
			await client.close();
		}
	}, 30_000);

	it("leaves other sessions of the same gateway on their model (isolation)", async () => {
		const client = await connectTestClient(gateway);
		try {
			const first = await client.attach("1");
			await first.configure({ model: { provider: "faux", modelId: "faux-2" } });

			const created = await client.management.create({});
			const second = await client.attach(created.id);
			const seen: ChatView[] = [];
			second.view.subscribe((value) => {
				if (value) seen.push(value);
			});
			expect(second.view.value?.agent.model).toEqual({ provider: "faux", modelId: "faux-1" });

			await second.submit({ content: "ping from session 2" });
			await waitFor(
				() => seen.some((view) => view.items.some((item) => item.type === "assistant" && item.text.includes("pong"))),
				"会话 2 收到回答",
			);
			expect(requestedModels[requestedModels.length - 1]).toBe("faux-1");
			expect(sawAgent(seen, "faux-1")).toBe(true);
		} finally {
			await client.close();
		}
	}, 30_000);

	it("rejects configuring an unknown session with a clear remote error", async () => {
		const client = await connectTestClient(gateway);
		try {
			// 未知会话：attach 即被路由层拒绝，客户端收到带 code 的 ChordError。
			const failure = await client.attach("999").then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(ChordError);
			expect((failure as ChordError).code).toBe("gone");
		} finally {
			await client.close();
		}
	}, 30_000);

	it("configure on a released session fails with a clear error", async () => {
		const client = await connectTestClient(gateway);
		try {
			const created = await client.management.create({});
			const chat = await client.attach(created.id);
			// 归档会释放 attachment 并关闭句柄：此后 configure 的会话路由已失效，
			// 客户端门面本地拒绝（chord 绑定守卫），错误信息清晰指明目标不可用。
			await client.management.archive(created.id);
			const failure = await chat.configure({ model: { provider: "faux", modelId: "faux-2" } }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toMatch(/unavailable/);
		} finally {
			await client.close();
		}
	}, 30_000);
});
