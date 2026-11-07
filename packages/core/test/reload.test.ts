import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
// spec: agent-runtime「热替换扩展」——同名扩展重新 install 后：
// 已开始执行的工具调用在原实现下完成，新发起的调用使用新实现。
// 参考 reference/pi/packages/durable/test/examples/31-reload-and-restart.ts。

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionResult, ToolResultEntry } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { createNekoRuntime } from "../src/index.ts";

function loadVersioned(version: string, gate: Promise<void>, started: () => void) {
	return defineExtension({
		name: "versioned",
		tools: [
			defineTool({
				name: "version",
				description: "Report the tool's code version",
				parameters: obj({}, { open: true }),
				execute: async (): Promise<ToolExecutionResult> => {
					started();
					await gate;
					return { output: [{ type: "text", text: version }] };
				},
			}),
		],
	});
}

describe("extension hot reload", () => {
	it("finishes the running call on the old code and runs the next call on the new code", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markStarted = (): void => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});

		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("version", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Done 1")]),
			fauxAssistantMessage([fauxToolCall("version", {}, { id: "call-2" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Done 2")]),
		]);
		const runtime = await createNekoRuntime({
			credentials: new InMemoryCredentialStore(),
			storage: "memory",
			model: { provider: "faux", modelId: "faux-1" },
			providers: [faux.provider],
			extensions: [loadVersioned("v1", gate, markStarted)],
		});
		const lastToolResultText = async (): Promise<string> => {
			const page = await runtime.conversation.entries({}, 20, undefined, runtime.context);
			const result = page.items.find((entry) => ToolResultEntry.is(entry));
			const message = result?.model?.[0];
			return message?.role === "toolResult"
				? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
				: "";
		};
		try {
			// First call: the tool starts executing v1 and blocks.
			const first = await runtime.submit("Which version?");
			await started;
			// Same-name install while the call runs.
			runtime.installExtension(loadVersioned("v2", gate, () => {}));
			// The running call was resolved from v1: it finishes with v1's result.
			release();
			expect(await runtime.waitAnswer(first)).toEqual({ status: "done", text: "Done 1" });
			expect(await lastToolResultText()).toBe("v1");

			// The next call resolves the tool from the registry again: v2.
			const second = await runtime.submit("And now?");
			expect(await runtime.waitAnswer(second)).toEqual({ status: "done", text: "Done 2" });
			expect(await lastToolResultText()).toBe("v2");
		} finally {
			release();
			await runtime.close();
		}
	}, 30_000);
});
