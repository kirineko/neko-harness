import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/index.ts";

describe("createNekoRuntime", () => {
	it("allows configuration when the DeepSeek API key is missing", async () => {
		const original = process.env.DEEPSEEK_API_KEY;
		delete process.env.DEEPSEEK_API_KEY;
		try {
			const runtime = await createNekoRuntime({ credentials: new InMemoryCredentialStore(), storage: "memory" });
			await expect(runtime.submit("hello")).rejects.toThrow(/PROVIDER_KEY_REQUIRED/);
			await runtime.close();
		} finally {
			if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
		}
	});

	it("exposes the tavily runtime override as the active source without persisting it", async () => {
		const original = process.env.TAVILY_API_KEY;
		delete process.env.TAVILY_API_KEY;
		try {
			const runtime = await createNekoRuntime({
				credentials: new InMemoryCredentialStore(),
				storage: "memory",
				tavilyApiKey: "test-tavily-override",
			});
			try {
				expect((await runtime.credentialStatus("tavily")).source).toBe("runtime");
				expect(process.env.TAVILY_API_KEY).toBeUndefined();
				expect((await runtime.getAgent()).extensions).toContain("neko-web-search");
			} finally {
				await runtime.close();
			}
		} finally {
			if (original !== undefined) process.env.TAVILY_API_KEY = original;
		}
	});

	it("answers an input end to end on a memory runtime", async () => {
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage([fauxText("2")])]);
		const runtime = await createNekoRuntime({
			credentials: new InMemoryCredentialStore(),
			storage: "memory",
			model: { provider: "faux", modelId: "faux-1" },
			providers: [faux.provider],
		});
		try {
			const answer = await runtime.waitAnswer(await runtime.submit("1+1等于几？"));
			expect(answer).toEqual({ status: "done", text: "2" });

			const usage = await runtime.usage();
			expect(Object.keys(usage.models).length).toBeGreaterThan(0);

			const view = await runtime.follow();
			expect(view.value.entries.length).toBeGreaterThan(0);
			view.dispose();
		} finally {
			await runtime.close();
		}
	}, 30_000);
});
