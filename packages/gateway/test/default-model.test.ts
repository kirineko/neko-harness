import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL } from "@neko-harness/core";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor as wait } from "./helpers.ts";

const waitFor = (predicate: () => boolean) => wait(predicate, "default model synchronization");

const openrouterModel = async (client: {
	models: { list(input: null): Promise<{ provider: string; modelId: string }[]> };
}) => {
	const list = await client.models.list(null);
	const target = list.find((model) => model.provider === "openrouter");
	if (!target) throw new Error("openrouter model missing from the catalog");
	return target;
};

it("reports the built-in default initially and synchronizes set/clear across clients", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-default-model-gateway-"));
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
	});
	const unix = await connectTestClient(gateway);
	const web = await connectTestWsClient(gateway);
	try {
		await waitFor(() => !!web.defaultModel.state.value && !!unix.defaultModel.state.value);
		expect(unix.defaultModel.state.value).toEqual({ effective: DEFAULT_MODEL, source: "default" });

		await unix.credentials.setEnabled({ provider: "openrouter", enabled: true });
		const target = await openrouterModel(web);
		await unix.defaultModel.set({ provider: target.provider, modelId: target.modelId });
		await waitFor(
			() =>
				web.defaultModel.state.value?.source === "saved" &&
				unix.defaultModel.state.value?.effective.modelId === target.modelId,
		);
		expect(web.defaultModel.state.value).toEqual({
			effective: { provider: "openrouter", modelId: target.modelId },
			source: "saved",
		});
		expect(unix.defaultModel.state.value).toEqual(web.defaultModel.state.value);

		await web.defaultModel.clear(null);
		await waitFor(
			() => web.defaultModel.state.value?.source === "default" && unix.defaultModel.state.value?.source === "default",
		);
		expect(unix.defaultModel.state.value).toEqual({ effective: DEFAULT_MODEL, source: "default" });
		expect(web.defaultModel.state.value).toEqual({ effective: DEFAULT_MODEL, source: "default" });
	} finally {
		await unix.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("reports source cli for a gateway launched with --model and keeps it across set/clear", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-default-model-gateway-"));
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	const client = await connectTestClient(gateway);
	try {
		await waitFor(() => !!client.defaultModel.state.value);
		expect(client.defaultModel.state.value).toEqual({
			effective: { provider: "faux", modelId: "faux-1" },
			source: "cli",
		});

		// --model wins over the saved value; the saved value resurfaces only without the override.
		await client.defaultModel.set({ provider: "faux", modelId: "faux-2" });
		await client.defaultModel.clear(null);
		expect(client.defaultModel.state.value).toEqual({
			effective: { provider: "faux", modelId: "faux-1" },
			source: "cli",
		});
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("reports source config when the config file sets defaultModel", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-default-model-gateway-"));
	await writeFile(
		join(dir, "neko.config.json"),
		JSON.stringify({ defaultModel: { provider: "deepseek", modelId: "deepseek-v4-pro" } }),
	);
	const gateway = await startGateway({
		configDir: dir,
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
	});
	const client = await connectTestClient(gateway);
	try {
		await waitFor(() => !!client.defaultModel.state.value);
		expect(client.defaultModel.state.value).toEqual({
			effective: { provider: "deepseek", modelId: "deepseek-v4-pro" },
			source: "config",
		});
		await client.defaultModel.clear(null);
		await waitFor(() => client.defaultModel.state.value?.source === "config");
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("rejects unknown models and disabled providers without publishing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-default-model-gateway-"));
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
	});
	const client = await connectTestClient(gateway);
	try {
		await waitFor(() => !!client.defaultModel.state.value);
		const unchanged = JSON.stringify(client.defaultModel.state.value);

		await expect(client.defaultModel.set({ provider: "openrouter", modelId: "no-such-model" })).rejects.toThrow(
			"Unknown model",
		);
		const xai = (await gateway.runtime.listModels()).find((model) => model.provider === "xai");
		if (xai === undefined) throw new Error("xai model missing from the catalog");
		await expect(client.defaultModel.set({ provider: "xai", modelId: xai.modelId })).rejects.toThrow(
			"PROVIDER_DISABLED",
		);
		expect(JSON.stringify(client.defaultModel.state.value)).toBe(unchanged);
		expect(await gateway.runtime.defaultModel()).toEqual({ effective: DEFAULT_MODEL, source: "default" });
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("does not publish when persistence fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-default-model-gateway-"));
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
	});
	const client = await connectTestClient(gateway);
	try {
		await waitFor(() => !!client.defaultModel.state.value);
		await client.credentials.setEnabled({ provider: "openrouter", enabled: true });
		const first = await openrouterModel(client);
		const second = (await client.models.list(null)).find(
			(model) => model.provider === "openrouter" && model.modelId !== first.modelId,
		);
		await client.defaultModel.set({ provider: first.provider, modelId: first.modelId });
		await waitFor(() => client.defaultModel.state.value?.source === "saved");

		const runtime = gateway.runtime as { setDefaultModel: (ref: unknown) => Promise<void> };
		const original = runtime.setDefaultModel;
		runtime.setDefaultModel = async () => {
			throw new Error("storage unavailable");
		};
		try {
			await expect(
				client.defaultModel.set({ provider: second?.provider ?? "openrouter", modelId: second?.modelId ?? "x" }),
			).rejects.toThrow();
			await expect(client.defaultModel.clear(null)).rejects.toThrow();
		} finally {
			runtime.setDefaultModel = original;
		}
		expect(client.defaultModel.state.value).toEqual({
			effective: { provider: first.provider, modelId: first.modelId },
			source: "saved",
		});
		expect(await gateway.runtime.defaultModel()).toEqual({
			effective: { provider: first.provider, modelId: first.modelId },
			source: "saved",
		});
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
