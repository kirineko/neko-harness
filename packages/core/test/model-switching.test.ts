import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";

// spec: model-providers「会话级切换模型」——某会话切换模型后其下一次请求用新模型，其他会话不受影响。

import { type FauxResponseFactory, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createNekoRuntime } from "../src/index.ts";

describe("per-conversation model switching", () => {
	it("switches the model for one conversation's next request only", async () => {
		// 每个请求记录 faux 实际收到的 modelId。
		const requestedModels: string[] = [];
		const recordRequest: FauxResponseFactory = (_context, _options, _state, model) => {
			requestedModels.push(model.id);
			return fauxAssistantMessage([fauxText("pong")]);
		};
		const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2", reasoning: true }] });
		faux.setResponses([recordRequest, recordRequest, recordRequest, recordRequest]);
		const runtime = await createNekoRuntime({
			credentials: new InMemoryCredentialStore(),
			storage: "memory",
			model: { provider: "faux", modelId: "faux-1" },
			providers: [faux.provider],
		});
		try {
			const sessionA = runtime.root;
			const sessionB = await runtime.createConversation();

			// Before the switch: both conversations run faux-1.
			await sessionA.waitAnswer(await sessionA.submit("ping"));
			expect(requestedModels[0]).toBe("faux-1");
			expect((await runtime.getAgent(sessionA.id)).model).toEqual({ provider: "faux", modelId: "faux-1" });

			// Switch session A to faux-2 with a thinking level.
			expect(
				await runtime.configureConversation(sessionA.id, {
					model: { provider: "faux", modelId: "faux-2" },
					thinkingLevel: "high",
				}),
			).toBe(true);
			const agentA = await runtime.getAgent(sessionA.id);
			expect(agentA.model).toEqual({ provider: "faux", modelId: "faux-2" });
			expect(agentA.thinkingLevel).toBe("high");

			// A's next request uses faux-2; B still runs faux-1.
			await sessionA.waitAnswer(await sessionA.submit("ping again"));
			expect(requestedModels[1]).toBe("faux-2");
			await sessionB.waitAnswer(await sessionB.submit("ping from B"));
			expect(requestedModels[2]).toBe("faux-1");
			const agentB = await runtime.getAgent(sessionB.id);
			expect(agentB.model).toEqual({ provider: "faux", modelId: "faux-1" });
			expect(agentB.thinkingLevel).not.toBe("high");

			// Unknown conversations reject the change.
			expect(
				await runtime.configureConversation(999 as never, { model: { provider: "faux", modelId: "faux-2" } }),
			).toBe(false);
			await expect(runtime.getAgent(999 as never)).rejects.toThrow(/not available/);
		} finally {
			await runtime.close();
		}
	}, 30_000);
});
