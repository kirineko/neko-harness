import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor as wait } from "./helpers.ts";

const waitFor = (predicate: () => boolean) => wait(predicate, "provider enablement synchronization");

it("synchronizes provider enablement across clients and rejects invalid changes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-provider-gateway-"));
	const saved = process.env.OPENROUTER_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
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
		await waitFor(() => !!web.credentials.state.value && !!unix.credentials.state.value);
		const statuses = web.credentials.state.value!.statuses;
		expect(statuses.deepseek?.enabled).toBe(true);
		expect(statuses.openrouter?.enabled).toBe(false);
		expect(statuses.tavily?.enabled).toBeUndefined();
		expect(new Set((await web.models.list(null)).map((m) => m.provider))).toEqual(new Set(["deepseek"]));

		await unix.credentials.setEnabled({ provider: "openrouter", enabled: true });
		await waitFor(() => web.credentials.state.value?.statuses.openrouter?.enabled === true);
		const list = await web.models.list(null);
		expect(new Set(list.map((m) => m.provider))).toEqual(new Set(["deepseek", "openrouter"]));
		expect(list.filter((m) => m.provider === "openrouter").every((m) => !m.available)).toBe(true);

		await web.credentials.save({ provider: "openrouter", key: "test-openrouter-secret" });
		await waitFor(() => unix.credentials.state.value?.statuses.openrouter?.source === "saved");
		expect((await unix.models.list(null)).filter((m) => m.provider === "openrouter").every((m) => m.available)).toBe(
			true,
		);
		expect(JSON.stringify(web.credentials.state.value)).not.toContain("test-openrouter-secret");

		const revision = web.credentials.state.value!.revision;
		await expect(web.credentials.setEnabled({ provider: "deepseek", enabled: false })).rejects.toThrow(
			"always enabled",
		);
		await expect(web.credentials.setEnabled({ provider: "anthropic", enabled: true })).rejects.toThrow(
			"Unknown model provider",
		);
		await expect(web.credentials.setEnabled({ provider: "tavily", enabled: true })).rejects.toThrow(
			"Unknown model provider",
		);
		await expect(web.credentials.save({ provider: "anthropic", key: "test-x" })).rejects.toThrow(
			"Unknown credential provider",
		);
		expect(web.credentials.state.value!.revision).toBe(revision);
		expect(web.credentials.state.value!.statuses.deepseek?.enabled).toBe(true);

		await unix.credentials.setEnabled({ provider: "openrouter", enabled: false });
		await waitFor(() => web.credentials.state.value?.statuses.openrouter?.enabled === false);
		expect(web.credentials.state.value!.statuses.openrouter?.source).toBe("saved");
		expect((await web.models.list(null)).some((m) => m.provider === "openrouter")).toBe(false);

		const session = await unix.management.create({});
		const chat = await unix.attach(session.id);
		await waitFor(() => !!chat.view.value);
		await unix.credentials.setEnabled({ provider: "openrouter", enabled: true });
		const target = (await unix.models.list(null)).find((m) => m.provider === "openrouter")!;
		await chat.configure({ model: { provider: "openrouter", modelId: target.modelId } });
		await waitFor(() => chat.view.value?.agent.model?.provider === "openrouter");
		await unix.credentials.setEnabled({ provider: "openrouter", enabled: false });
		await expect(chat.submit({ content: "hello" })).rejects.toThrow("PROVIDER_DISABLED");
		await unix.credentials.setEnabled({ provider: "openrouter", enabled: true });
		await unix.credentials.remove({ provider: "openrouter" });
		await expect(chat.submit({ content: "hello" })).rejects.toThrow("PROVIDER_KEY_REQUIRED");
	} finally {
		await unix.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
		if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = saved;
	}
});
