import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor as wait } from "./helpers.ts";

const waitFor = (predicate: () => boolean) => wait(predicate, "search settings synchronization");

it("synchronizes the search provider across clients without touching credentials", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-search-gateway-"));
	const old = process.env.DEEPSEEK_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
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
		await waitFor(() => !!web.searchSettings.state.value && !!unix.searchSettings.state.value);
		expect(web.searchSettings.state.value!.selected).toBe("tavily");

		await unix.searchSettings.set({ provider: "deepseek" });
		await waitFor(() => web.searchSettings.state.value?.selected === "deepseek");
		expect(unix.searchSettings.state.value).toEqual(web.searchSettings.state.value);

		// Saving or removing a DeepSeek key never changes the explicit choice.
		await unix.credentials.save({ provider: "deepseek", key: "test-private-value" });
		await waitFor(() => web.credentials.state.value?.statuses.deepseek?.source === "saved");
		expect(JSON.stringify(web.searchSettings.state.value)).not.toContain("test-private-value");
		await web.credentials.remove({ provider: "deepseek" });
		await waitFor(() => unix.credentials.state.value?.statuses.deepseek?.source === "none");
		expect(unix.searchSettings.state.value!.selected).toBe("deepseek");

		await web.searchSettings.set({ provider: "tavily" });
		await waitFor(() => unix.searchSettings.state.value?.selected === "tavily");
	} finally {
		await unix.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
		if (old === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = old;
	}
});

it("rejects unknown providers and does not publish when persistence fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-search-gateway-"));
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
		await waitFor(() => !!client.searchSettings.state.value);
		await client.searchSettings.set({ provider: "deepseek" });
		await waitFor(() => client.searchSettings.state.value?.selected === "deepseek");
		const revision = client.searchSettings.state.value!.revision;

		for (const provider of ["auto", "bing"])
			await expect(client.searchSettings.set({ provider: provider as never })).rejects.toThrow();

		const runtime = gateway.runtime as { setSearchProvider: (provider: string) => Promise<void> };
		const original = runtime.setSearchProvider;
		runtime.setSearchProvider = async () => {
			throw new Error("storage unavailable");
		};
		try {
			await expect(client.searchSettings.set({ provider: "tavily" })).rejects.toThrow();
		} finally {
			runtime.setSearchProvider = original;
		}
		expect(client.searchSettings.state.value).toMatchObject({ selected: "deepseek", revision });
		expect((await gateway.runtime.searchSettings()).selected).toBe("deepseek");
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
