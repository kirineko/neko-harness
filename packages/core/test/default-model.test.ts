import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { MODEL_PROVIDERS } from "../src/credential-providers.ts";
import { createNekoRuntime, DEFAULT_MODEL, type NekoModelRef } from "../src/runtime.ts";

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

const openrouterModels = (): [NekoModelRef, NekoModelRef] => {
	const models = builtinProviders()
		.find((provider) => provider.id === "openrouter")!
		.getModels();
	return [
		{ provider: "openrouter", modelId: models[0]!.id },
		{ provider: "openrouter", modelId: models[1]!.id },
	];
};

it("falls back to the built-in default with source default when nothing is set", async () => {
	const runtime = await createNekoRuntime({ storage: "memory", credentials: new InMemoryCredentialStore() });
	try {
		expect(await runtime.defaultModel()).toEqual({ effective: DEFAULT_MODEL, source: "default" });
		const session = await runtime.createConversation();
		expect((await runtime.getAgent(session.id)).model).toEqual(DEFAULT_MODEL);
	} finally {
		await runtime.close();
	}
});

it("reports source config and uses options.model for new sessions", async () => {
	const config = openrouterModels()[0];
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		model: config,
	});
	try {
		expect(await runtime.defaultModel()).toEqual({ effective: config, source: "config" });
		const session = await runtime.createConversation();
		expect((await runtime.getAgent(session.id)).model).toEqual(config);
	} finally {
		await runtime.close();
	}
});

it("lets modelOverride beat the saved default and options.model", async () => {
	const [config, override] = openrouterModels();
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		model: config,
		modelOverride: override,
	});
	try {
		await runtime.setProviderEnabled("openrouter", true);
		await runtime.setDefaultModel(config);
		expect(await runtime.defaultModel()).toEqual({ effective: override, source: "cli" });
		const session = await runtime.createConversation();
		expect((await runtime.getAgent(session.id)).model).toEqual(override);
	} finally {
		await runtime.close();
	}
});

it("prefers the saved default over options.model and falls back when cleared", async () => {
	const [config, savedRef] = openrouterModels();
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		model: config,
	});
	try {
		await runtime.setProviderEnabled("openrouter", true);
		await runtime.setDefaultModel(savedRef);
		expect(await runtime.defaultModel()).toEqual({ effective: savedRef, source: "saved" });
		const session = await runtime.createConversation();
		expect((await runtime.getAgent(session.id)).model).toEqual(savedRef);
		await runtime.setDefaultModel(null);
		expect(await runtime.defaultModel()).toEqual({ effective: config, source: "config" });
		const fallback = await runtime.createConversation();
		expect((await runtime.getAgent(fallback.id)).model).toEqual(config);
	} finally {
		await runtime.close();
	}
});

it("clears back to the built-in default when there is no config model", async () => {
	const runtime = await createNekoRuntime({ storage: "memory", credentials: new InMemoryCredentialStore() });
	try {
		await runtime.setProviderEnabled("openrouter", true);
		const savedRef = openrouterModels()[0];
		await runtime.setDefaultModel(savedRef);
		expect((await runtime.defaultModel()).source).toBe("saved");
		await runtime.setDefaultModel(null);
		expect(await runtime.defaultModel()).toEqual({ effective: DEFAULT_MODEL, source: "default" });
	} finally {
		await runtime.close();
	}
});

it("lets an explicit createConversation model beat the whole chain", async () => {
	const [config, savedRef] = openrouterModels();
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		model: config,
	});
	try {
		await runtime.setProviderEnabled("openrouter", true);
		await runtime.setDefaultModel(savedRef);
		const session = await runtime.createConversation({ model: config });
		expect((await runtime.getAgent(session.id)).model).toEqual(config);
	} finally {
		await runtime.close();
	}
});

it("rejects unknown models and disabled providers but does not require a key", async () => {
	const runtime = await createNekoRuntime({ storage: "memory", credentials: new InMemoryCredentialStore() });
	try {
		await expect(runtime.setDefaultModel({ provider: "openrouter", modelId: "no-such-model" })).rejects.toThrow(
			"Unknown model",
		);
		const xai = runtime.listModels().find((model) => model.provider === "xai")!;
		await expect(runtime.setDefaultModel({ provider: "xai", modelId: xai.modelId })).rejects.toThrow(
			"PROVIDER_DISABLED",
		);
		await runtime.setProviderEnabled("openrouter", true);
		const target = openrouterModels()[0];
		await runtime.setDefaultModel(target); // enabled without a saved key
		expect(await runtime.defaultModel()).toEqual({ effective: target, source: "saved" });
	} finally {
		await runtime.close();
	}
});

it("persists the saved default across runtime restarts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-default-model-"));
	dirs.push(dir);
	const opts = { storagePath: join(dir, "db.sqlite"), credentialsPath: join(dir, "credentials.json") };
	const target = openrouterModels()[0];
	let runtime = await createNekoRuntime(opts);
	try {
		await runtime.setProviderEnabled("openrouter", true);
		await runtime.setDefaultModel(target);
	} finally {
		await runtime.close();
	}
	runtime = await createNekoRuntime(opts);
	try {
		expect(await runtime.defaultModel()).toEqual({ effective: target, source: "saved" });
		const session = await runtime.createConversation();
		expect((await runtime.getAgent(session.id)).model).toEqual(target);
	} finally {
		await runtime.close();
	}
});

it("keeps the saved model for new sessions when its provider is later disabled", async () => {
	const runtime = await createNekoRuntime({ storage: "memory", credentials: new InMemoryCredentialStore() });
	try {
		const target = openrouterModels()[0];
		await runtime.setProviderEnabled("openrouter", true);
		await runtime.setDefaultModel(target);
		await runtime.setProviderEnabled("openrouter", false);
		expect(await runtime.defaultModel()).toEqual({ effective: target, source: "saved" });
		const session = await runtime.createConversation();
		expect((await runtime.getAgent(session.id)).model).toEqual(target);
	} finally {
		await runtime.close();
	}
});
