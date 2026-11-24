import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
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
		await waitFor(() => !!web.contextSettings.snapshot.value && !!unix.contextSettings.snapshot.value);
		const initial = web.contextSettings.snapshot.value!;
		expect(initial.effective.compaction.triggerPercent).toBeNull();
		expect(initial.effective.pruning.enabled).toBe(false);
		expect(initial.sources.pruning.enabled).toBe("default");

		await unix.contextSettings.set({ compaction: { triggerPercent: 50 }, pruning: { enabled: true } });
		await waitFor(() => web.contextSettings.snapshot.value?.effective.compaction.triggerPercent === 50);
		expect(unix.contextSettings.snapshot.value).toEqual(web.contextSettings.snapshot.value);
		expect(web.contextSettings.snapshot.value!.sources.compaction.triggerPercent).toBe("saved");
		expect(web.contextSettings.snapshot.value!.revision).toBeGreaterThan(initial.revision);
		expect((await gateway.runtime.contextSettings()).effective.pruning.enabled).toBe(true);

		await web.contextSettings.set({ compaction: { triggerPercent: null } });
		await waitFor(() => unix.contextSettings.snapshot.value?.sources.compaction.triggerPercent === "default");
		expect(unix.contextSettings.snapshot.value!.effective.pruning.enabled).toBe(true);

		await unix.contextSettings.reset({});
		await waitFor(() => web.contextSettings.snapshot.value?.sources.pruning.enabled === "default");
		expect(web.contextSettings.snapshot.value!.effective.pruning.enabled).toBe(false);
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
		await waitFor(() => !!client.contextSettings.snapshot.value);
		const revision = client.contextSettings.snapshot.value!.revision;
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
		await sleep(50);
		expect(client.contextSettings.snapshot.value!.revision).toBe(revision);
		expect(client.contextSettings.snapshot.value!.effective.pruning.enabled).toBe(false);
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
		await waitFor(() => !!first.contextSettings.snapshot.value);
		await first.contextSettings.set({ pruning: { keepRecent: 3 } });
		await first.close();
		const second = await connectTestClient(gateway);
		try {
			await waitFor(() => second.contextSettings.snapshot.value?.effective.pruning.keepRecent === 3);
		} finally {
			await second.close();
		}
	} finally {
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
