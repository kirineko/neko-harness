import type { NekoSelectableModel } from "@neko-harness/core";
import { expect, it } from "vitest";
import type { NekoCredentialState } from "../src/client/lib/contract.ts";
import {
	describeModel,
	filterProviderOptions,
	formatContextWindow,
	groupModels,
	isDefaultModel,
	providerIssue,
	providerName,
	resolveProviderId,
} from "../src/client/lib/providers.ts";

const model = (provider: string, modelId: string, name: string, available = true): NekoSelectableModel => ({
	provider,
	modelId,
	name,
	available,
	contextWindow: 200_000,
	input: ["text", "image"],
	reasoning: true,
	supportedThinkingLevels: ["off", "high"],
	thinkingLevelAdjustments: {
		off: "off",
		minimal: "off",
		low: "off",
		medium: "high",
		high: "high",
		xhigh: "high",
		max: "high",
	},
});
const status = (source: "saved" | "none", enabled?: boolean) => ({
	savedConfigured: source === "saved",
	environmentConfigured: false,
	source,
	...(enabled === undefined ? {} : { enabled }),
});

it("groups models in catalog order and filters by name, id and provider", () => {
	const models = [
		model("openrouter", "anthropic/claude-haiku-4.5", "Claude Haiku"),
		model("opencode-go", "kimi-k3", "Kimi K3"),
		model("deepseek", "deepseek-flash", "DeepSeek Flash"),
		model("custom", "x", "Custom"),
	];
	expect(groupModels(models, "").map((group) => group.provider)).toEqual([
		"deepseek",
		"openrouter",
		"opencode-go",
		"custom",
	]);
	expect(groupModels(models, "claude").map((group) => [group.provider, group.models.length])).toEqual([
		["openrouter", 1],
	]);
	expect(groupModels(models, "anthropic/claude")[0]?.models[0]?.modelId).toBe("anthropic/claude-haiku-4.5");
	expect(groupModels(models, "opencode kimi").map((group) => group.name)).toEqual(["OpenCode Go"]);
	expect(groupModels(models, "nothing-matches")).toEqual([]);
	expect(groupModels([model("openrouter", "a", "A", false)], "")[0]?.available).toBe(false);
});

it("reports why a provider cannot send and ignores providers outside the catalog", () => {
	const state = (statuses: NekoCredentialState["statuses"]): NekoCredentialState => ({ revision: 1, statuses });
	expect(providerIssue(null, "deepseek")).toBeNull();
	expect(providerIssue(state({ deepseek: status("none", true) }), "deepseek")).toBe("missing-key");
	expect(providerIssue(state({ openrouter: status("saved", false) }), "openrouter")).toBe("disabled");
	expect(providerIssue(state({ openrouter: status("saved", true) }), "openrouter")).toBeNull();
	expect(providerIssue(state({}), "faux")).toBeNull();
	expect(providerIssue(state({ tavily: status("none") }), "tavily")).toBeNull();
});

it("formats names and model descriptions", () => {
	expect(providerName("opencode-go")).toBe("OpenCode Go");
	expect(providerName("unknown")).toBe("unknown");
	expect(formatContextWindow(1_000_000)).toBe("1M");
	expect(formatContextWindow(128_000)).toBe("128K");
	expect(describeModel(model("deepseek", "a", "A"))).toBe("200K 上下文 · 支持图片 · 支持思考");
});

it("matches the default model by provider and modelId regardless of source", () => {
	const ref = { provider: "deepseek", modelId: "deepseek-flash" };
	expect(isDefaultModel(null, ref)).toBe(false);
	expect(isDefaultModel({ effective: ref, source: "saved" }, null)).toBe(false);
	expect(isDefaultModel({ effective: ref, source: "saved" }, undefined)).toBe(false);
	expect(isDefaultModel({ effective: ref, source: "saved" }, { provider: "deepseek", modelId: "other" })).toBe(false);
	expect(
		isDefaultModel({ effective: ref, source: "saved" }, { provider: "openrouter", modelId: "deepseek-flash" }),
	).toBe(false);
	// 来源（cli / saved / config / default）不影响标识：一律按 effective 命中。
	for (const source of ["cli", "saved", "config", "default"] as const)
		expect(isDefaultModel({ effective: ref, source }, ref)).toBe(true);
});

it("resolves the provider a picker starts on: preferred, else first usable, else first, else none", () => {
	const groups = groupModels(
		[model("openrouter", "a", "A", false), model("opencode-go", "b", "B"), model("deepseek", "c", "C", false)],
		"",
	);
	expect(resolveProviderId(groups, "opencode-go")).toBe("opencode-go");
	// 当前 provider 不在可选集合（被取消启用）：改选首个可用的，而不是首个。
	expect(resolveProviderId(groups, "openai")).toBe("opencode-go");
	expect(resolveProviderId(groups, undefined)).toBe("opencode-go");
	// 无可用（全缺 Key）：退回首个，仍能显示未配置提示。
	expect(
		resolveProviderId(
			groups.filter((group) => !group.available),
			"openai",
		),
	).toBe("deepseek");
	expect(resolveProviderId([], "deepseek")).toBeNull();
});

it("filters provider options by every word over name, id and keywords, keeping order", () => {
	const options = [
		{ id: "openai", name: "OpenAI", keywords: "OPENAI_API_KEY" },
		{ id: "openrouter", name: "OpenRouter", keywords: "OPENROUTER_API_KEY" },
		{ id: "deepseek", name: "DeepSeek", keywords: "DEEPSEEK_API_KEY" },
	];
	expect(filterProviderOptions(options, "").map((item) => item.id)).toEqual(["openai", "openrouter", "deepseek"]);
	expect(filterProviderOptions(options, "open").map((item) => item.id)).toEqual(["openai", "openrouter"]);
	expect(filterProviderOptions(options, "open router").map((item) => item.id)).toEqual(["openrouter"]);
	expect(filterProviderOptions(options, "deepseek_api").map((item) => item.id)).toEqual(["deepseek"]);
	expect(filterProviderOptions(options, "zzz")).toEqual([]);
});
