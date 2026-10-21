import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { NekoModelRef, NekoSelectableModel } from "@neko-harness/core";
import type { NekoCredentialState, NekoDefaultModelState } from "@neko-harness/gateway";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { modelDisplayName } from "../src/format.ts";
import { commands } from "../src/labels.ts";
import { isProviderRejection, modelItems, openModelPanel, providerSendBlock } from "../src/provider-ui.ts";

const model = (provider: string, modelId: string, extra: Partial<NekoSelectableModel> = {}): NekoSelectableModel =>
	({
		provider,
		modelId,
		name: modelId,
		available: true,
		contextWindow: 200_000,
		input: ["text"],
		reasoning: false,
		supportedThinkingLevels: ["off"],
		...extra,
	}) as NekoSelectableModel;

const models = [
	model("openrouter", "anthropic/claude-haiku-4.5", {
		name: "Claude Haiku 4.5",
		reasoning: true,
		input: ["text", "image"],
	}),
	model("openrouter", "openai/gpt-5-mini", { name: "GPT-5 Mini" }),
	model("deepseek", "deepseek-flash", { name: "DeepSeek Flash", contextWindow: 1_000_000, reasoning: true }),
	model("openai", "gpt-5", { name: "GPT-5", available: false }),
];

const text = (panel: PickerPanel, width = 100) => panel.render(width).map(stripTerminalSequences).join("\n");
async function openModels(current = { provider: "deepseek", modelId: "deepseek-flash" }) {
	const picked: string[] = [];
	let closed = 0;
	const panel = new PickerPanel(
		() => {},
		() => closed++,
	);
	panel.height = 20;
	panel.groupedFilter = true;
	await panel.show(
		"Models",
		async () => modelItems(models, current),
		async (value) => {
			picked.push(value);
		},
	);
	return { panel, picked, closed: () => closed };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("keeps the vendor prefix and drops only the provider", () => {
	expect(modelDisplayName("deepseek/deepseek-flash")).toBe("deepseek-flash");
	expect(modelDisplayName("openrouter/anthropic/claude-haiku-4.5")).toBe("anthropic/claude-haiku-4.5");
	expect(modelDisplayName("opencode/anthropic/claude-haiku-4.5")).toBe("anthropic/claude-haiku-4.5");
	expect(modelDisplayName("Flash")).toBe("Flash");
	expect(modelDisplayName("deepseek/")).toBe("deepseek/");
});

it("shows vendor-prefixed model names in the footer so same-named models differ", () => {
	const footer = new StatusFooter();
	const render = (modelName: string) => {
		footer.setStats({ cwd: "/work/neko", model: modelName, thinkingLevel: null, usageText: "", busy: undefined });
		return footer.render(100).map(stripTerminalSequences).join("\n");
	};
	const router = render("openrouter/anthropic/claude-haiku-4.5");
	expect(router).toContain("anthropic/claude-haiku-4.5");
	expect(router).not.toContain("openrouter/");
	expect(render("deepseek/deepseek-flash")).toContain("deepseek-flash");
	expect(render("opencode-go/zai/glm-5")).toContain("zai/glm-5");
});

it("groups models by provider with the current provider first and marks the current model", async () => {
	const { panel } = await openModels();
	const out = text(panel);
	expect(out.indexOf("DeepSeek")).toBeLessThan(out.indexOf("OpenRouter"));
	expect(out.indexOf("OpenRouter")).toBeLessThan(out.indexOf("OpenAI"));
	expect(out).toMatch(/deepseek\/deepseek-flash \(Current\)\s+1\.0M · Thinking/);
	expect(out).toMatch(/openrouter\/anthropic\/claude-haiku-4\.5\s+200\.0k · Thinking · Images/);
	expect(out).toContain("OpenAI · needs key");
	expect(out).toMatch(/openai\/gpt-5\s+needs key · 200\.0k/);
});

it("filters by model name, provider/id and provider name while keeping group headers", async () => {
	const { panel } = await openModels();
	for (const query of ["haiku", "openrouter/anthropic", "claude haiku"]) {
		panel.search.setValue(query);
		panel.handleInput("");
		const out = text(panel);
		expect(out).toContain("openrouter/anthropic/claude-haiku-4.5");
		expect(out).toContain("OpenRouter");
		expect(out).not.toContain("gpt-5-mini");
		expect(out).not.toContain("DeepSeek");
	}
	panel.search.setValue("open");
	panel.handleInput("");
	const out = text(panel);
	expect(out).toContain("OpenRouter");
	expect(out).toContain("OpenAI");
	expect(out).not.toContain("deepseek-flash");
	panel.search.setValue("zzz");
	panel.handleInput("");
	expect(text(panel)).toContain("No results");
});

it("selects with Enter and cancels with Esc without picking", async () => {
	const first = await openModels();
	text(first.panel);
	first.panel.handleInput("\x1b[B");
	first.panel.handleInput("\r");
	await tick();
	expect(first.picked).toEqual(["openrouter/anthropic/claude-haiku-4.5"]);
	expect(first.panel.open).toBe(false);
	const second = await openModels();
	second.panel.handleInput("\x1b");
	await tick();
	expect(second.picked).toEqual([]);
	expect(second.panel.open).toBe(false);
	expect(second.closed()).toBe(1);
});

it("cannot confirm a model whose provider needs a key and points to /login", async () => {
	const { panel, picked } = await openModels();
	panel.handleInput("gpt-5");
	let out = text(panel);
	expect(out).toContain("openai/gpt-5");
	expect(out).toContain("openrouter/openai/gpt-5-mini");
	// Down to the OpenAI item (gpt-5-mini is first, then gpt-5).
	panel.handleInput("\x1b[B");
	panel.handleInput("\r");
	await tick();
	out = text(panel);
	expect(picked).toEqual([]);
	expect(panel.open).toBe(true);
	expect(out).toContain("OpenAI needs a key. Use /login to configure it.");
	// Moving away clears the hint.
	panel.handleInput("\x1b[A");
	expect(text(panel)).not.toContain("Use /login to configure it.");
});

it("renders the grouped list inside 80x24 and 60x16 style panel heights without overflow", async () => {
	for (const [width, height] of [
		[78, 16],
		[58, 8],
	] as const) {
		const { panel } = await openModels();
		panel.height = height;
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		const lines = panel.render(width).map(stripTerminalSequences);
		expect(lines.length).toBe(height);
		expect(lines.every((line) => line.length <= width)).toBe(true);
		expect(lines.join("\n")).toContain("Esc Close");
		expect(lines.join("\n")).toContain("❯");
	}
});

it("blocks sending when the current provider is disabled or has no key", () => {
	const statuses = (patch: Record<string, Partial<NekoCredentialState["statuses"][string]>>) =>
		({
			revision: 1,
			statuses: Object.fromEntries(
				Object.entries(patch).map(([id, value]) => [
					id,
					{ savedConfigured: false, environmentConfigured: false, source: "none", ...value },
				]),
			),
		}) as NekoCredentialState;
	expect(providerSendBlock({ provider: "deepseek" }, statuses({ deepseek: { enabled: true } }))).toBe(
		"Configure DeepSeek with /login before sending.",
	);
	expect(
		providerSendBlock({ provider: "openrouter" }, statuses({ openrouter: { enabled: false, source: "saved" } })),
	).toBe("OpenRouter is disabled. Enable it with /login or switch model.");
	expect(
		providerSendBlock({ provider: "openrouter" }, statuses({ openrouter: { enabled: true, source: "saved" } })),
	).toBe(undefined);
	expect(providerSendBlock({ provider: "openrouter" }, statuses({}))).toBeUndefined();
	expect(providerSendBlock(null, statuses({}))).toBeUndefined();
	expect(providerSendBlock({ provider: "deepseek" }, undefined)).toBeUndefined();
});

it("recognises gateway provider rejections", () => {
	expect(isProviderRejection("PROVIDER_KEY_REQUIRED: Configure a DeepSeek API key in /login or Web settings.")).toBe(
		true,
	);
	expect(isProviderRejection("PROVIDER_DISABLED: OpenRouter is not enabled.")).toBe(true);
	expect(isProviderRejection("Something PROVIDER_DISABLED: later")).toBe(false);
});

it("describes /login as provider and key management", () => {
	expect(commands().find((command) => command.name === "login")?.description).toBe(
		"Manage model providers and API keys",
	);
});

const defaultState = (effective: NekoModelRef, source: NekoDefaultModelState["source"]): NekoDefaultModelState => ({
	effective,
	source,
});

function fakeModelClient(initial: NekoDefaultModelState) {
	const listeners = new Set<(value: NekoDefaultModelState | undefined) => void>();
	const calls: { set: NekoModelRef[]; clear: number } = { set: [], clear: 0 };
	const state: {
		value: NekoDefaultModelState | undefined;
		subscribe(listener: (value: NekoDefaultModelState | undefined) => void): () => void;
	} = {
		value: initial,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const client = {
		models: { list: async (_input: null) => models },
		defaultModel: {
			state,
			set: async (input: NekoModelRef) => {
				calls.set.push(input);
			},
			clear: async (_input: null) => {
				calls.clear++;
			},
		},
	};
	return {
		client,
		calls,
		publish(value: NekoDefaultModelState) {
			state.value = value;
			for (const listener of listeners) listener(value);
		},
	};
}

async function openDefaultModels(
	initial: NekoDefaultModelState,
	current = { provider: "deepseek", modelId: "deepseek-flash" },
) {
	const fake = fakeModelClient(initial);
	const picked: NekoSelectableModel[] = [];
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	panel.height = 20;
	const stop = openModelPanel(
		panel,
		fake.client,
		current,
		async (model) => {
			picked.push(model);
		},
		() => {},
	);
	await tick();
	return { panel, fake, calls: fake.calls, picked, stop };
}

it("marks the resolved default model and advertises the d key in the footer", async () => {
	const { panel, fake } = await openDefaultModels(
		defaultState({ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" }, "saved"),
	);
	const out = text(panel);
	expect(out).toContain("openrouter/anthropic/claude-haiku-4.5 ★");
	expect(out).toContain("default · 200.0k · Thinking · Images");
	expect(out).not.toContain("deepseek/deepseek-flash ★");
	expect(out).toContain("D Toggle default");
	expect(out).toContain("Esc Close");
	// 标识完全以订阅状态为准（含 cli/config 来源的 effective）。
	fake.publish(defaultState({ provider: "deepseek", modelId: "deepseek-flash" }, "cli"));
	const moved = text(panel);
	expect(moved).toMatch(/deepseek\/deepseek-flash( \(Current\))? ★/);
	expect(moved).not.toContain("openrouter/anthropic/claude-haiku-4.5 ★");
});

it("d sets the highlighted available model as default and the marker follows the subscription", async () => {
	const { panel, fake, calls } = await openDefaultModels(
		defaultState({ provider: "deepseek", modelId: "deepseek-flash" }, "config"),
	);
	expect(text(panel)).toMatch(/deepseek\/deepseek-flash( \(Current\))? ★/);
	panel.handleInput("\x1b[B");
	panel.handleInput("d");
	await tick();
	expect(calls.set).toEqual([{ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" }]);
	expect(calls.clear).toBe(0);
	// 订阅回推后标识移动，无需重开面板（Web 修改同理）。
	fake.publish(defaultState({ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" }, "saved"));
	const out = text(panel);
	expect(out).toContain("openrouter/anthropic/claude-haiku-4.5 ★");
	expect(out).toContain("default · 200.0k · Thinking · Images");
	expect(out).not.toContain("deepseek/deepseek-flash ★");
	expect(panel.open).toBe(true);
});

it("d clears the highlighted row when it is the current default", async () => {
	const { panel, fake, calls } = await openDefaultModels(
		defaultState({ provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" }, "saved"),
	);
	expect(text(panel)).toContain("openrouter/anthropic/claude-haiku-4.5 ★");
	panel.handleInput("\x1b[B");
	panel.handleInput("d");
	await tick();
	expect(calls.clear).toBe(1);
	expect(calls.set).toEqual([]);
	// 清除保存值后回落到配置/内置默认，标识随之移动。
	fake.publish(defaultState({ provider: "deepseek", modelId: "deepseek-flash" }, "default"));
	const out = text(panel);
	expect(out).toMatch(/deepseek\/deepseek-flash( \(Current\))? ★/);
	expect(out).not.toContain("openrouter/anthropic/claude-haiku-4.5 ★");
	expect(panel.open).toBe(true);
});

it("d on a model without a key changes nothing and points to /login", async () => {
	const saved = defaultState({ provider: "openai", modelId: "gpt-5" }, "saved");
	const { panel, fake, calls } = await openDefaultModels(saved);
	expect(text(panel)).toContain("openai/gpt-5 ★");
	// 高亮移到 OpenAI 的 gpt-5（needs key 行）。
	for (let i = 0; i < 3; i++) panel.handleInput("\x1b[B");
	panel.handleInput("d");
	await tick();
	expect(calls.set).toEqual([]);
	expect(calls.clear).toBe(0);
	expect(fake.client.defaultModel.state.value).toEqual(saved);
	const out = text(panel);
	expect(out).toContain("OpenAI needs a key. Use /login to configure it.");
	expect(panel.open).toBe(true);
});
