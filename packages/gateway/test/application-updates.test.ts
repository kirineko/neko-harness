import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { APPLICATION_PROTOCOL, ApplicationProtocolError } from "../../core/src/application-version.ts";
import { connectToGateway } from "../../tui/src/gateway.ts";
import { ensureNekoGateway } from "../../web/src/gateway-spawn.ts";
import { startGateway } from "../src/gateway.ts";
import { connectTestClient, connectTestWsClient, waitFor } from "./helpers.ts";

it("publishes install changes consistently without attaching or waiting for registry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-version-gateway-"));
	const manifest = join(dir, "package.json"),
		storagePath = join(dir, "data.sqlite");
	await writeFile(manifest, JSON.stringify({ name: "neko-harness", version: "1.0.0" }));
	const faux = fauxProvider();
	const gateway = await startGateway({
		storage: "memory",
		storagePath,
		port: 0,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		updateIntervalMs: 20,
		updates: {
			runningVersion: "1.0.0",
			manifest,
			cachePath: join(dir, "cache.json"),
			fetch: async () => new Response("offline", { status: 503 }),
		},
	});
	const ws = await connectTestWsClient(gateway);
	const unix = await connectTestClient(gateway);
	try {
		expect(ws.attachment).toBeUndefined();
		expect(ws.application.info.value?.runningVersion).toBe("1.0.0");
		await writeFile(manifest, JSON.stringify({ name: "neko-harness", version: "1.1.0" }));
		await waitFor(
			() =>
				ws.application.info.value?.installedVersion === "1.1.0" &&
				unix.application.info.value?.installedVersion === "1.1.0",
			"both clients observe updated install",
		);
		expect(ws.application.info.value).toEqual(unix.application.info.value);
		let events = 0;
		const stop = ws.application.info.subscribe(() => events++);
		await Bun.sleep(65);
		expect(events).toBe(1);
		stop();
		expect((await ws.application.check(null)).checkState).toBe("failed");
		expect(faux.state.callCount).toBe(0);
	} finally {
		await ws.close();
		await unix.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
it("rejects incompatible live gateway without spawning a competing instance", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-version-protocol-")),
		faux = fauxProvider();
	const storagePath = join(dir, "data.sqlite");
	const gateway = await startGateway({
		storage: "memory",
		storagePath,
		port: 0,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		updates: { protocolVersion: APPLICATION_PROTOCOL + 1 },
	});
	try {
		await expect(connectTestWsClient(gateway)).rejects.toBeInstanceOf(ApplicationProtocolError);
		await expect(
			ensureNekoGateway({
				storagePath,
				serverId: gateway.serverId,
				port: gateway.port!,
				socketPath: gateway.socketPath,
			}),
		).rejects.toBeInstanceOf(ApplicationProtocolError);
		await expect(connectToGateway({ storagePath, socketPath: gateway.socketPath })).rejects.toBeInstanceOf(
			ApplicationProtocolError,
		);
		expect(faux.state.callCount).toBe(0);
		expect(gateway.runtime.closed).toBeInstanceOf(Promise);
	} finally {
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
