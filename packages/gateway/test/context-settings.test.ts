import { expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor as wait } from "./helpers.ts";

const waitFor = (predicate: () => boolean) => wait(predicate, "context settings synchronization");

async function start(dir: string) {
	return startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
	});
}

it("synchronizes context settings across clients and restores defaults", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-context-gateway-"));
	const gateway = await start(dir);
	const unix = await connectTestClient(gateway);
	const web = await connectTestWsClient(gateway);
	try {
		await waitFor(() => !!web.contextSettings.state.value && !!unix.contextSettings.state.value);
		const initial = web.contextSettings.state.value!;
		expect(initial.effective.compaction.triggerPercent).toBeNull();
		expect(initial.effective.pruning.enabled).toBe(false);
		expect(initial.sources.pruning.enabled).toBe("default");

		await unix.contextSettings.set({ compaction: { triggerPercent: 50 }, pruning: { enabled: true } });
		await waitFor(() => web.contextSettings.state.value?.effective.compaction.triggerPercent === 50);
		expect(unix.contextSettings.state.value).toEqual(web.contextSettings.state.value);
		expect(web.contextSettings.state.value!.sources.compaction.triggerPercent).toBe("saved");
		expect(web.contextSettings.state.value!.revision).toBeGreaterThan(initial.revision);
		expect((await gateway.runtime.contextSettings()).effective.pruning.enabled).toBe(true);

		await web.contextSettings.set({ compaction: { triggerPercent: null } });
		await waitFor(() => unix.contextSettings.state.value?.sources.compaction.triggerPercent === "default");
		expect(unix.contextSettings.state.value!.effective.pruning.enabled).toBe(true);

		await unix.contextSettings.reset({});
		await waitFor(() => web.contextSettings.state.value?.sources.pruning.enabled === "default");
		expect(web.contextSettings.state.value!.effective.pruning.enabled).toBe(false);
	} finally {
		await unix.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("rejects invalid patches and does not publish when persistence fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-context-gateway-"));
	const gateway = await start(dir);
	const client = await connectTestClient(gateway);
	try {
		await waitFor(() => !!client.contextSettings.state.value);
		const revision = client.contextSettings.state.value!.revision;
		await expect(client.contextSettings.set({ compaction: { triggerPercent: 100 } })).rejects.toThrow();

		const runtime = gateway.runtime as { setContextSettings: (patch: unknown) => Promise<unknown> };
		const original = runtime.setContextSettings;
		runtime.setContextSettings = async () => {
			throw new Error("storage unavailable");
		};
		try {
			await expect(client.contextSettings.set({ pruning: { enabled: true } })).rejects.toThrow();
		} finally {
			runtime.setContextSettings = original;
		}
		await Bun.sleep(50);
		expect(client.contextSettings.state.value!.revision).toBe(revision);
		expect(client.contextSettings.state.value!.effective.pruning.enabled).toBe(false);
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("restores the saved state after a reconnect", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-context-gateway-"));
	const gateway = await start(dir);
	const first = await connectTestClient(gateway);
	try {
		await waitFor(() => !!first.contextSettings.state.value);
		await first.contextSettings.set({ pruning: { keepRecent: 3 } });
		await first.close();
		const second = await connectTestClient(gateway);
		try {
			await waitFor(() => second.contextSettings.state.value?.effective.pruning.keepRecent === 3);
		} finally {
			await second.close();
		}
	} finally {
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
