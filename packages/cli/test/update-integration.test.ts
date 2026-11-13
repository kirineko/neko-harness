import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { UpdateChecker } from "../../core/src/application-updates.ts";
import { updateAction } from "../../core/src/application-version.ts";
import { connectNekoGateway } from "../../gateway/src/client.ts";
import { startGateway } from "../../gateway/src/gateway.ts";
import { waitFor } from "../../gateway/test/helpers.ts";
import { startWebServer } from "../../web/src/server.ts";
import { updateCommand } from "../src/update.ts";

const posixIt = it.skipIf(process.platform === "win32");

posixIt("upgrades an isolated installation, detects old live services, then a stale page", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-update-flow-")),
		globalRoot = join(dir, "lib/node_modules"),
		root = join(globalRoot, "neko-harness"),
		manifest = join(root, "package.json"),
		entry = join(root, "dist/neko.js"),
		storagePath = join(dir, "session.sqlite");
	await mkdir(join(root, "dist"), { recursive: true });
	const install = async (version: string) => {
		await writeFile(manifest, JSON.stringify({ name: "neko-harness", version }));
		await writeFile(entry, `console.log(${JSON.stringify(version)})`);
	};
	await install("0.2.5");
	await writeFile(join(dir, "index.html"), "<div id='root'></div>");
	const faux = fauxProvider(),
		fetchLatest = async () => Response.json({ name: "neko-harness", version: "0.2.6" });
	const start = (runningVersion: string) =>
		startGateway({
			storage: "memory",
			storagePath,
			port: 0,
			providers: [faux.provider],
			model: { provider: "faux", modelId: "faux-1" },
			updateIntervalMs: 20,
			updates: { runningVersion, manifest, cachePath: join(dir, "cache.json"), fetch: fetchLatest },
		});
	let gateway = await start("0.2.5");
	let web = await startWebServer({
		port: 0,
		staticDir: dir,
		versionOptions: { runningVersion: "0.2.5", manifest },
		gateway: { storagePath, serverId: gateway.serverId, socketPath: gateway.socketPath, port: gateway.port! },
	});
	let client = await connectNekoGateway({ transport: "ws", url: gateway.wsUrl!, serverId: gateway.serverId });
	try {
		await waitFor(() => client.application.info.value?.checkState === "ok", "latest available");
		expect(updateAction({ gateway: client.application.info.value!, frontend: "0.2.5", installed: "0.2.5" })).toBe(
			"install",
		);
		const result = await updateCommand({
			runningVersion: "0.2.5",
			entry,
			checker: new UpdateChecker({
				runningVersion: "0.2.5",
				manifest,
				cachePath: join(dir, "cli-cache"),
				fetch: fetchLatest,
			}),
			run: async (command, args) => {
				if (command === "npm" && args[0] === "root") return globalRoot;
				if (command === "npm") {
					expect(args).toEqual(["install", "-g", "neko-harness@0.2.6"]);
					await install("0.2.6");
					return "";
				}
				return (await promisify(execFile)(command, args)).stdout.trim();
			},
		});
		expect(result).toContain("已升级至 v0.2.6");
		await waitFor(() => client.application.info.value?.installedVersion === "0.2.6", "installed changes observed");
		const oldWeb = await (await fetch(`${web.url}/api/info`)).json();
		expect(oldWeb.webVersion).toBe("0.2.5");
		expect(oldWeb.installedVersion).toBe("0.2.6");
		expect(
			updateAction({
				gateway: client.application.info.value!,
				frontend: "0.2.5",
				installed: "0.2.6",
				web: { runningVersion: oldWeb.webVersion, installedVersion: oldWeb.installedVersion },
			}),
		).toBe("restart-service");
		await client.close();
		await web.close();
		await gateway.close();
		gateway = await start("0.2.6");
		web = await startWebServer({
			port: 0,
			staticDir: dir,
			versionOptions: { runningVersion: "0.2.6", manifest },
			gateway: { storagePath, serverId: gateway.serverId, socketPath: gateway.socketPath, port: gateway.port! },
		});
		client = await connectNekoGateway({ transport: "ws", url: gateway.wsUrl!, serverId: gateway.serverId });
		const input = {
			gateway: client.application.info.value!,
			frontend: "0.2.5",
			installed: "0.2.6",
			web: { runningVersion: "0.2.6", installedVersion: "0.2.6" },
		};
		expect(updateAction(input)).toBe("refresh-page");
		expect(updateAction({ ...input, frontend: "0.2.6" })).toBe("none");
		expect(faux.state.callCount).toBe(0);
	} finally {
		await client.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});
