import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { APPLICATION_PROTOCOL } from "../../core/src/application-version.ts";
import { startGateway } from "../../gateway/src/gateway.ts";
import { waitFor } from "../../gateway/test/helpers.ts";
import { GatewayConnection } from "../src/client/lib/gateway.ts";
import { startWebServer } from "../src/server.ts";

it("reports immutable web version and changing installed version with no-store", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-web-version-")),
		manifest = join(dir, "package.json"),
		faux = fauxProvider(),
		storagePath = join(dir, "db.sqlite");
	await writeFile(manifest, JSON.stringify({ name: "neko-harness", version: "1.0.0" }));
	await writeFile(join(dir, "index.html"), "<div id='root'></div>");
	let gateway = await startGateway({
		storage: "memory",
		storagePath,
		port: 0,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const web = await startWebServer({
		port: 0,
		staticDir: dir,
		versionOptions: { runningVersion: "1.0.0", manifest },
		gateway: { storagePath, serverId: gateway.serverId, socketPath: gateway.socketPath, port: gateway.port! },
	});
	try {
		const first = await fetch(`${web.url}/api/info`);
		expect(first.headers.get("cache-control")).toBe("no-store");
		expect((await first.json()).webVersion).toBe("1.0.0");
		await writeFile(manifest, JSON.stringify({ name: "neko-harness", version: "1.1.0" }));
		const second = await (await fetch(`${web.url}/api/info`)).json();
		expect(second.webVersion).toBe("1.0.0");
		expect(second.installedVersion).toBe("1.1.0");
		expect((await fetch(web.url)).headers.get("cache-control")).toBe("no-store");
		const port = gateway.port!,
			serverId = gateway.serverId,
			socketPath = gateway.socketPath;
		await gateway.close();
		gateway = await startGateway({
			storage: "memory",
			storagePath,
			port,
			serverId,
			socketPath,
			providers: [faux.provider],
			model: { provider: "faux", modelId: "faux-1" },
			updates: { protocolVersion: APPLICATION_PROTOCOL + 1 },
		});
		const incompatible = await (await fetch(`${web.url}/api/info`)).json();
		expect(incompatible.protocolCompatible).toBe(false);
	} finally {
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
it("rediscovers a changed gateway address and drops incompatible retries", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-web-reconnect-")),
		faux = fauxProvider(),
		storagePath = join(dir, "db.sqlite");
	let gateway = await startGateway({
		storage: "memory",
		storagePath,
		port: 0,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	const serverId = gateway.serverId;
	let phase = "",
		discoveries = 0;
	const client = new GatewayConnection({
		url: gateway.wsUrl!,
		serverId,
		workspaceRoot: dir,
		retryBaseMs: 5,
		discover: async () => {
			discoveries++;
			return { gatewayWs: gateway.wsUrl!, serverId };
		},
		events: {
			onPhase: (value) => {
				phase = value;
			},
			onError: () => {},
			onDirectory: () => {},
			onWorkspaces: () => {},
			onWorkspace: () => {},
			onOperation: () => {},
			onModels: () => {},
			onSessionChange: () => {},
			onView: () => {},
		},
	});
	try {
		await client.start();
		expect(phase).toBe("ready");
		const old = gateway.wsUrl;
		await gateway.close();
		gateway = await startGateway({
			storage: "memory",
			storagePath,
			serverId,
			port: 0,
			providers: [faux.provider],
			model: { provider: "faux", modelId: "faux-1" },
		});
		await waitFor(() => phase === "ready" && discoveries > 1, "new address connected");
		expect(gateway.wsUrl).not.toBe(old);
		await gateway.close();
		gateway = await startGateway({
			storage: "memory",
			storagePath,
			serverId,
			port: 0,
			providers: [faux.provider],
			model: { provider: "faux", modelId: "faux-1" },
			updates: { protocolVersion: APPLICATION_PROTOCOL + 1 },
		});
		await waitFor(() => phase === "error", "incompatible phase");
		const count = discoveries;
		await sleep(80);
		expect(discoveries).toBe(count);
	} finally {
		await client.dispose();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
