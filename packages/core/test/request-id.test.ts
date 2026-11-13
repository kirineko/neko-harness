import { fauxProvider } from "../../../test/faux.ts";

// 2.3 requestId 幂等：同一 requestId 重复提交返回同一 submission，重开后依然成立。

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { createNekoRuntime, InMemoryCredentialStore, type NekoRuntimeOptions } from "../src/index.ts";

let directory = "";
afterAll(async () => {
	if (directory !== "") await rm(directory, { recursive: true, force: true });
});

describe("requestId idempotency (2.3)", () => {
	it("deduplicates submissions by requestId, also after reopen", async () => {
		directory = await mkdtemp(join(tmpdir(), "neko-request-id-"));
		const storagePath = join(directory, "session.sqlite");
		const options = (): NekoRuntimeOptions => {
			const faux = fauxProvider();
			faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
			return {
				credentials: new InMemoryCredentialStore(),
				storagePath,
				model: { provider: "faux", modelId: "faux-1" },
				providers: [faux.provider],
			};
		};

		const runtimeA = await createNekoRuntime(options());
		const first = await runtimeA.submit("Hello", { requestId: "greeting-1" });
		const again = await runtimeA.submit("Hello", { requestId: "greeting-1" });
		expect(again.id).toBe(first.id);
		const answer = await runtimeA.waitAnswer(first);
		expect(answer).toEqual({ status: "done", text: "ok" });
		// Admitted once: one user entry in the transcript.
		const page = await runtimeA.conversation.entries({}, 10, undefined, runtimeA.context);
		expect(page.items.filter((entry) => entry.kind === "app.neko.input").length).toBe(1);
		await runtimeA.close();

		// After reopen, the same requestId finds the same submission.
		const runtimeB = await createNekoRuntime(options());
		try {
			const reacquired = await runtimeB.submit("Hello", { requestId: "greeting-1" });
			expect(reacquired.id).toBe(first.id);
			const pageAfter = await runtimeB.conversation.entries({}, 10, undefined, runtimeB.context);
			expect(pageAfter.items.filter((entry) => entry.kind === "app.neko.input").length).toBe(1);
		} finally {
			await runtimeB.close();
		}
	}, 30_000);
});
