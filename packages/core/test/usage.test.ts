import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
// 2.5 用量统计：一轮带工具调用的对话后，usage 按 provider/modelId 与工具名分组，
// 且带 usage 的失败工具结果也计入。

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Usage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createNekoRuntime } from "../src/index.ts";

const meteredUsage = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const Metered = defineExtension({
	name: "test-metered",
	tools: [
		defineTool({
			name: "metered",
			description: "Succeeds and reports usage.",
			parameters: obj({}, { open: true }),
			execute: async () => ({
				output: [{ type: "text", text: "metered ok" }],
				usage: meteredUsage(3, 2),
			}),
		}),
		defineTool({
			name: "metered_fail",
			description: "Fails and still reports usage.",
			parameters: obj({}, { open: true }),
			execute: async () => ({
				isError: true,
				output: [{ type: "text", text: "boom" }],
				usage: meteredUsage(1, 1),
			}),
		}),
	],
});

describe("usage accounting (2.5)", () => {
	it("groups model usage by provider/modelId and tool usage by name, failures included", async () => {
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("metered", {}, { id: "call-1" }), fauxToolCall("metered_fail", {}, { id: "call-2" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const runtime = await createNekoRuntime({
			credentials: new InMemoryCredentialStore(),
			storage: "memory",
			model: { provider: "faux", modelId: "faux-1" },
			providers: [faux.provider],
			extensions: [Metered],
		});
		try {
			const answer = await runtime.waitAnswer(await runtime.submit("run the metered tools"));
			expect(answer).toEqual({ status: "done", text: "done" });

			const usage = await runtime.usage();
			// Models bucket, keyed provider/modelId, counts the real model turns
			// (totalTokens = input + output + cache reads/writes).
			const model = usage.models["faux/faux-1"];
			expect(model).toBeDefined();
			// Pi 1.5's faux provider reports the prompt as cache reads and writes, not as input.
			expect(model!.input + model!.cacheRead + model!.cacheWrite).toBeGreaterThan(0);
			expect(model!.totalTokens).toBe(model!.input + model!.output + model!.cacheRead + model!.cacheWrite);
			// Tools bucket, keyed by tool name.
			expect(usage.tools.metered).toMatchObject({ input: 3, output: 2, totalTokens: 5 });
			// A failed tool result still counts when it carries usage.
			expect(usage.tools.metered_fail).toMatchObject({ input: 1, output: 1, totalTokens: 2 });
		} finally {
			await runtime.close();
		}
	}, 30_000);
});
