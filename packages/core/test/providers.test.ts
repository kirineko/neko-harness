import { expect, it } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createNekoRuntime } from "../src/runtime.ts";

it("uses published DeepSeek capabilities directly", async () => {
	const runtime = await createNekoRuntime({ storage: "memory" });
	try {
		const models = await runtime.listSelectableModels();
		expect(models.map((m) => m.provider)).toEqual(["deepseek", "deepseek"]);
		expect(models.find((m) => m.modelId === "deepseek-flash")).toMatchObject({
			input: ["text", "image"],
			supportedThinkingLevels: ["off", "low", "high", "max"],
		});
		expect(models.find((m) => m.modelId === "deepseek-v4-pro")).toMatchObject({
			input: ["text"],
			supportedThinkingLevels: ["off", "high", "max"],
		});
	} finally {
		await runtime.close();
	}
});

it("sends requests to a custom provider's baseUrl", async () => {
	const faux = fauxProvider();
	const baseUrl = "https://custom-provider.invalid/v1";
	const provider = {
		...faux.provider,
		baseUrl,
		getModels: () => faux.models.map((model) => ({ ...model, baseUrl })),
	};
	let url = "";
	faux.setResponses([
		(_ctx, _options, _state, model) => {
			url = model.baseUrl;
			return fauxAssistantMessage("answer");
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [provider],
		model: { provider: provider.id, modelId: faux.models[0].id },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("custom URL"));
		expect(url).toBe(baseUrl);
	} finally {
		await runtime.close();
	}
});
