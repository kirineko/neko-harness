import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	createModels,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { followConversation } from "../src/conversation-follow.ts";
import {
	CREDENTIAL_PROVIDERS,
	DEFAULT_ENABLED_PROVIDERS,
	isModelProvider,
	MODEL_PROVIDERS,
	normalizeEnabledProviders,
} from "../src/credential-providers.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { SessionMetadataDoc } from "../src/session-metadata.ts";
import { listDelegations } from "../src/subagents.ts";

const dirs: string[] = [];
const saved = new Map<string, string | undefined>();
beforeEach(() => {
	for (const spec of MODEL_PROVIDERS) saved.set(spec.envVar, process.env[spec.envVar]);
	for (const spec of MODEL_PROVIDERS) delete process.env[spec.envVar];
});
afterEach(async () => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("keeps the catalog in sync with Pi's api-key providers and environment variables", async () => {
	const pi = new Map(builtinProviders().map((provider) => [provider.id, provider]));
	expect(MODEL_PROVIDERS).toHaveLength(32);
	expect(new Set(MODEL_PROVIDERS.map((item) => item.id)).size).toBe(32);
	for (const spec of MODEL_PROVIDERS) {
		const provider = pi.get(spec.id);
		expect(provider, spec.id).toBeDefined();
		expect(provider!.auth.apiKey, spec.id).toBeDefined();
		expect(provider!.getModels().length, spec.id).toBeGreaterThan(0);
		const models = createModels({ credentials: new InMemoryCredentialStore() });
		models.setProvider(provider!);
		expect(await models.checkAuth(spec.id), spec.id).toBeUndefined();
		process.env[spec.envVar] = "test-env";
		try {
			expect(await models.checkAuth(spec.id), spec.id).toMatchObject({ type: "api_key", source: spec.envVar });
		} finally {
			delete process.env[spec.envVar];
		}
	}
	expect(CREDENTIAL_PROVIDERS.map((item) => item.id)).toContain("tavily");
	expect(isModelProvider("tavily")).toBe(false);
	expect(isModelProvider("anthropic")).toBe(false);
});

it("normalizes enabled providers to catalog members and always keeps DeepSeek", () => {
	expect(normalizeEnabledProviders(null)).toEqual([...DEFAULT_ENABLED_PROVIDERS]);
	expect(normalizeEnabledProviders(["openrouter", "bogus"])).toEqual(["deepseek", "openrouter"]);
	expect(normalizeEnabledProviders([])).toEqual(["deepseek"]);
});

it("defaults to DeepSeek, persists enablement, locks DeepSeek and keeps saved keys", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-providers-"));
	dirs.push(dir);
	const opts = { storagePath: join(dir, "db.sqlite"), credentialsPath: join(dir, "credentials.json") };
	let runtime = await createNekoRuntime(opts);
	try {
		expect(runtime.enabledProviders()).toEqual(["deepseek"]);
		expect(new Set((await runtime.listSelectableModels()).map((m) => m.provider))).toEqual(new Set(["deepseek"]));
		await expect(runtime.setProviderEnabled("deepseek", false)).rejects.toThrow("always enabled");
		await expect(runtime.setProviderEnabled("anthropic" as never, true)).rejects.toThrow("Unknown model provider");
		await expect(runtime.setProviderEnabled("openrouter", "yes" as never)).rejects.toThrow("boolean");
		await runtime.saveCredential("openrouter", "test-or");
		await runtime.setProviderEnabled("openrouter", true);
		expect(runtime.enabledProviders()).toEqual(["deepseek", "openrouter"]);
	} finally {
		await runtime.close();
	}
	runtime = await createNekoRuntime(opts);
	try {
		expect(runtime.enabledProviders()).toEqual(["deepseek", "openrouter"]);
		await runtime.setProviderEnabled("openrouter", false);
		expect(runtime.enabledProviders()).toEqual(["deepseek"]);
		expect((await runtime.credentialStatus("openrouter")).source).toBe("saved");
		expect((await runtime.listSelectableModels()).some((m) => m.provider === "openrouter")).toBe(false);
	} finally {
		await runtime.close();
	}
});

it("lists selectable models for enabled providers with availability and keeps OpenRouter ids intact", async () => {
	const runtime = await createNekoRuntime({ storage: "memory", credentials: new InMemoryCredentialStore() });
	try {
		await runtime.setProviderEnabled("openrouter", true);
		await runtime.setProviderEnabled("opencode-go", true);
		const list = await runtime.listSelectableModels();
		expect(new Set(list.map((m) => m.provider))).toEqual(new Set(["deepseek", "openrouter", "opencode-go"]));
		expect(list.filter((m) => m.provider === "openrouter").every((m) => !m.available)).toBe(true);
		expect(list.filter((m) => m.provider === "deepseek").every((m) => !m.available)).toBe(true);
		const target = list.find((m) => m.provider === "openrouter" && m.modelId.includes("/"))!;
		expect(target).toBeDefined();
		expect(runtime.listModels().some((m) => m.provider === "xai")).toBe(true);
		await runtime.saveCredential("openrouter", "test-or");
		const after = await runtime.listSelectableModels();
		expect(after.filter((m) => m.provider === "openrouter").every((m) => m.available)).toBe(true);
		await runtime.configureConversation(runtime.conversation.id, {
			model: { provider: "openrouter", modelId: target.modelId },
		});
		expect((await runtime.getAgent()).model).toEqual({ provider: "openrouter", modelId: target.modelId });
		const xai = runtime.listModels().find((m) => m.provider === "xai")!;
		await expect(
			runtime.configureConversation(runtime.conversation.id, { model: { provider: "xai", modelId: xai.modelId } }),
		).rejects.toThrow("PROVIDER_DISABLED");
		expect((await runtime.getAgent()).model?.provider).toBe("openrouter");
		await runtime.setProviderEnabled("openrouter", false);
		await runtime.configureConversation(runtime.conversation.id, { thinkingLevel: "off" });
	} finally {
		await runtime.close();
	}
});

it("rejects input for disabled providers without accepting it, and keeps history readable", async () => {
	const faux = fauxProvider({ provider: "openrouter" });
	faux.setResponses([fauxAssistantMessage([fauxText("first answer")])]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "openrouter", modelId: "faux-1" },
	});
	try {
		await expect(runtime.submit("hi")).rejects.toThrow("PROVIDER_DISABLED");
		await runtime.setProviderEnabled("openrouter", true);
		expect(await runtime.waitAnswer(await runtime.submit("hello"))).toEqual({ status: "done", text: "first answer" });
		await runtime.setProviderEnabled("openrouter", false);
		await expect(runtime.submit("zzq-rejected")).rejects.toThrow("PROVIDER_DISABLED");
		await expect(runtime.compact()).rejects.toThrow("PROVIDER_DISABLED");
		const view = await followConversation(runtime.conversation, runtime.context);
		expect(JSON.stringify(view.value.entries)).toContain("first answer");
		expect(JSON.stringify(view.value.entries)).not.toContain("zzq-rejected");
		view.dispose();
	} finally {
		await runtime.close();
	}
});

it("starts with an unenabled --model and enforces enablement, then keys, at submit time", async () => {
	const modelId = builtinProviders()
		.find((provider) => provider.id === "openrouter")!
		.getModels()[0]!.id;
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		model: { provider: "openrouter", modelId },
	});
	try {
		const before = await runtime.listConversations();
		await expect(runtime.submit("hi")).rejects.toThrow("PROVIDER_DISABLED");
		await runtime.setProviderEnabled("openrouter", true);
		await expect(runtime.submit("hi")).rejects.toThrow("PROVIDER_KEY_REQUIRED");
		expect(await runtime.listConversations()).toEqual(before);
	} finally {
		await runtime.close();
	}
});

it("blocks subagent launches once the main model's provider is disabled", async () => {
	const faux = fauxProvider({ provider: "openrouter" });
	let runtimeRef: Awaited<ReturnType<typeof createNekoRuntime>> | undefined;
	faux.setResponses([
		async () => {
			await runtimeRef!.setProviderEnabled("openrouter", false);
			return fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Find" })], {
				stopReason: "toolUse",
			});
		},
		fauxAssistantMessage([fauxText("done")]),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "openrouter", modelId: "faux-1" },
	});
	runtimeRef = runtime;
	try {
		await runtime.setProviderEnabled("openrouter", true);
		expect(await runtime.waitAnswer(await runtime.submit("delegate"))).toEqual({ status: "done", text: "done" });
		expect(await listDelegations(runtime.harness, runtime.conversation.id, runtime.context)).toHaveLength(0);
		const view = await followConversation(runtime.conversation, runtime.context);
		expect(JSON.stringify(view.value.entries)).toContain("PROVIDER_DISABLED");
		view.dispose();
	} finally {
		await runtime.close();
	}
}, 30_000);

it("falls back to the first-question title when the provider is disabled before naming", async () => {
	const faux = fauxProvider({ provider: "openrouter" });
	let runtimeRef: Awaited<ReturnType<typeof createNekoRuntime>> | undefined;
	faux.setResponses([
		async () => {
			await runtimeRef!.setProviderEnabled("openrouter", false);
			return fauxAssistantMessage([fauxText("answer")]);
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "openrouter", modelId: "faux-1" },
	});
	runtimeRef = runtime;
	try {
		await runtime.setProviderEnabled("openrouter", true);
		await runtime.waitAnswer(await runtime.submit("What is the title?"));
		for (let i = 0; i < 300; i++) {
			const doc = await runtime.harness.snapshot(SessionMetadataDoc, runtime.conversation.id, runtime.context);
			if (doc?.naming === "fallback") return;
			expect(doc?.naming).not.toBe("ready");
			await sleep(20);
		}
		throw new Error("naming did not fall back");
	} finally {
		await runtime.close();
	}
}, 30_000);
