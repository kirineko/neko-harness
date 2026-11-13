import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { testSocketPath } from "./helpers.ts";

async function withConfig<T>(config: string, run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "neko-context-config-"));
	try {
		await writeFile(join(dir, "neko.config.json"), config);
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const options = (dir: string) => ({
	configDir: dir,
	storage: "memory" as const,
	storagePath: join(dir, "neko.sqlite"),
	credentialsPath: join(dir, "credentials.json"),
	socketPath: testSocketPath(dir),
	port: 0,
	serverId: crypto.randomUUID(),
});

it("passes the config file's context settings to the runtime", async () => {
	await withConfig('{"context": {"compaction": {"triggerPercent": 60}, "pruning": {"enabled": true}}}', async (dir) => {
		const gateway = await startGateway(options(dir));
		try {
			const state = await gateway.runtime.contextSettings();
			expect(state.effective.compaction.triggerPercent).toBe(60);
			expect(state.sources.compaction.triggerPercent).toBe("config");
			expect(state.effective.pruning.enabled).toBe(true);
		} finally {
			await gateway.close();
		}
	});
});

it("fails to start on an invalid context config and names the field", async () => {
	await withConfig('{"context": {"compaction": {"triggerPercent": 100}}}', async (dir) => {
		await expect(startGateway(options(dir))).rejects.toThrow(/context\.compaction\.triggerPercent/);
	});
});
