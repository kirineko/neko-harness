import { fauxProvider } from "../../../test/faux.ts";

// 2.2 持久化与崩溃恢复：两个 runtime 实例先后打开同一 SQLite 文件。
// 实例 A 提交后在工具执行中"崩溃"（close 中止在飞调用）；实例 B 重开同一文件，
// 断言 replay:"safe" 的工具重跑，未声明的工具以 interrupted 错误结果收场。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionResult, ToolResultEntry } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { afterAll, describe, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { createNekoRuntime, type NekoRuntimeOptions } from "../src/index.ts";

const attempts: string[] = [];
let releaseRecovery = (): void => {};
const released = new Promise<void>((resolve) => {
	releaseRecovery = resolve;
});

/** Rejects when the invocation's abort signal fires (Harness close / abort). */
function aborts(context: Context): Promise<never> {
	return new Promise((_, reject) => {
		const signal = context.abortSignal;
		if (signal === undefined) return;
		const onAbort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function gatedTool(name: string, replay?: "safe") {
	return defineTool({
		name,
		description: `Gated test tool ${name}: blocks until released or the call is aborted.`,
		parameters: obj({}, { open: true }),
		...(replay !== undefined ? { replay } : {}),
		execute: async (_args, _api, context): Promise<ToolExecutionResult> => {
			attempts.push(name);
			// Block like a long-running effect: ends only when the harness closes (abort)
			// or the test releases the recovery run.
			await Promise.race([aborts(context), released]);
			return { output: [{ type: "text", text: `${name} done` }] };
		},
	});
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

let directory = "";
afterAll(async () => {
	releaseRecovery();
	if (directory !== "") await rm(directory, { recursive: true, force: true });
});

describe("crash recovery (2.2)", () => {
	it("reruns replay-safe tools and settles unsafe ones as interrupted", async () => {
		directory = await mkdtemp(join(tmpdir(), "neko-recovery-"));
		const storagePath = join(directory, "session.sqlite");
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("gated_safe", {}, { id: "call-safe" }),
					fauxToolCall("gated_fragile", {}, { id: "call-fragile" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("recovered")]),
		]);
		const extension = defineExtension({
			name: "test-gated",
			tools: [gatedTool("gated_safe", "safe"), gatedTool("gated_fragile")],
		});
		const options: NekoRuntimeOptions = {
			storagePath,
			model: { provider: "faux", modelId: "faux-1" },
			providers: [faux.provider],
			extensions: [extension],
		};

		// Instance A: both tools start executing and block mid-call.
		const runtimeA = await createNekoRuntime(options);
		const submission = await runtimeA.submit("run the gated tools");
		await waitFor(() => attempts.length === 2, 10_000, "both tools to be in flight");
		// "Crash": close aborts the in-flight calls; the run stays pending in storage.
		await runtimeA.close();

		// Instance B over the same file: the safe tool reruns, the fragile one does not.
		const runtimeB = await createNekoRuntime(options);
		try {
			await waitFor(() => attempts.length === 3, 10_000, "the replay-safe tool to rerun");
			releaseRecovery();
			const reacquired = await runtimeB.harness.submission(submission.id, runtimeB.context);
			expect(reacquired).toBeDefined();
			const settled = await reacquired!.wait(runtimeB.context);
			expect(settled.status).toBe("done");
			const answer = await runtimeB.waitAnswer(reacquired!);
			expect(answer).toEqual({ status: "done", text: "recovered" });

			expect(attempts.filter((name) => name === "gated_safe").length).toBe(2);
			expect(attempts.filter((name) => name === "gated_fragile").length).toBe(1);

			// The fragile call settled as an interrupted error result; the safe one succeeded.
			const page = await runtimeB.conversation.entries({}, 50, undefined, runtimeB.context);
			const results = page.items.filter((entry) => ToolResultEntry.is(entry));
			const fragile = results.find((entry) =>
				(entry.data?.diagnostics ?? []).some(
					(diagnostic) => diagnostic.code === "interrupted" || diagnostic.message.includes("interrupted"),
				),
			);
			expect(fragile).toBeDefined();
			const safe = results.find(
				(entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "gated_safe",
			);
			expect(safe?.model?.[0]).toMatchObject({ isError: false });
		} finally {
			releaseRecovery();
			await runtimeB.close();
		}
	}, 60_000);
});
