import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NekoSelectableModel } from "@neko-harness/core";
import { expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../../gateway/src/gateway.ts";
import { testSocketPath, waitFor } from "../../gateway/test/helpers.ts";
import type { NekoDefaultModelState } from "../src/client/lib/contract.ts";
import { GatewayConnection } from "../src/client/lib/gateway.ts";

it("refetches the selectable models when provider enablement or keys change", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-web-models-"));
	const previous = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "db.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
	});
	let models: readonly NekoSelectableModel[] = [];
	const connection = new GatewayConnection({
		url: gateway.wsUrl!,
		serverId: gateway.serverId,
		workspaceRoot: dir,
		events: {
			onPhase: () => {},
			onError: () => {},
			onDirectory: () => {},
			onWorkspaces: () => {},
			onWorkspace: () => {},
			onOperation: () => {},
			onModels: (value) => {
				models = value;
			},
			onSessionChange: () => {},
			onView: () => {},
		},
	});
	const providers = () => new Set(models.map((m) => m.provider));
	try {
		await connection.start();
		await waitFor(() => models.length > 0, "initial models");
		expect(providers()).toEqual(new Set(["deepseek"]));
		await connection.setProviderEnabled("openrouter", true);
		await waitFor(() => providers().has("openrouter"), "openrouter models");
		expect(models.filter((m) => m.provider === "openrouter").every((m) => !m.available)).toBe(true);
		await connection.saveCredential("openrouter", "test-openrouter");
		await waitFor(
			() =>
				models.some((m) => m.provider === "openrouter") &&
				models.filter((m) => m.provider === "openrouter").every((m) => m.available),
			"openrouter available",
		);
		await connection.setProviderEnabled("openrouter", false);
		await waitFor(() => !providers().has("openrouter"), "openrouter hidden");
		await expect(connection.setProviderEnabled("deepseek", false)).rejects.toThrow();
	} finally {
		connection.dispose();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
		if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
	}
});

it("keeps the default model aligned with the list across credential-driven refetches", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-web-default-model-"));
	const previous = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "db.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
	});
	let models: readonly NekoSelectableModel[] = [];
	const defaultBox: { current: NekoDefaultModelState | null } = { current: null };
	const connection = new GatewayConnection({
		url: gateway.wsUrl!,
		serverId: gateway.serverId,
		workspaceRoot: dir,
		events: {
			onPhase: () => {},
			onError: () => {},
			onDirectory: () => {},
			onWorkspaces: () => {},
			onWorkspace: () => {},
			onOperation: () => {},
			onModels: (value) => {
				models = value;
			},
			onDefaultModel: (value) => {
				defaultBox.current = value;
			},
			onSessionChange: () => {},
			onView: () => {},
		},
	});
	try {
		await connection.start();
		await waitFor(() => models.length > 0, "initial models");
		// 未保存过默认时按内置默认解析；标识据此落在 deepseek-flash 上。
		expect(defaultBox.current).toEqual({
			effective: { provider: "deepseek", modelId: "deepseek-flash" },
			source: "default",
		});

		await connection.setProviderEnabled("openrouter", true);
		await waitFor(() => models.some((m) => m.provider === "openrouter"), "openrouter models");
		const target = models.find((m) => m.provider === "openrouter");
		if (!target) throw new Error("openrouter model missing");
		// 服务端 set 不查 Key，无 Key 时也能保存默认；此时该行尚不可选、不带「设为默认」入口。
		await connection.setDefaultModel({ provider: target.provider, modelId: target.modelId });
		await waitFor(() => defaultBox.current?.source === "saved", "saved default");
		expect(defaultBox.current?.effective).toEqual({ provider: target.provider, modelId: target.modelId });

		// Key 到位触发重拉后，默认模型所在行变为可选；订阅状态未变，标识仍可正确落在重拉后的该行上。
		await connection.saveCredential("openrouter", "test-openrouter");
		await waitFor(() => models.some((m) => m.provider === "openrouter" && m.available), "openrouter available");
		const refreshed = models.find((m) => m.provider === target.provider && m.modelId === target.modelId);
		expect(refreshed?.available).toBe(true);
		expect(defaultBox.current).toEqual({
			effective: { provider: target.provider, modelId: target.modelId },
			source: "saved",
		});

		await connection.clearDefaultModel();
		await waitFor(() => defaultBox.current?.source === "default", "cleared default");
		expect(defaultBox.current?.effective).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
	} finally {
		connection.dispose();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
		if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
	}
});
