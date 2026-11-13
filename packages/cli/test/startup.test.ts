import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectNekoGateway } from "@neko-harness/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { connectToGateway } from "../../tui/src/gateway.ts";
import { ensureNekoGateway } from "../../web/src/gateway-spawn.ts";

const IS_WINDOWS = process.platform === "win32";

let dir: string;
let originalKey: string | undefined;
let port: number;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-start-"));
	originalKey = process.env.DEEPSEEK_API_KEY;
	// Startup tests never submit a model request. Never forward a real credential.
	process.env.DEEPSEEK_API_KEY = "unused-startup-test";
	port = await freePort();
	await writeFile(join(dir, "neko.config.json"), JSON.stringify({ gateway: { port } }));
});
afterEach(async () => {
	if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
	else process.env.DEEPSEEK_API_KEY = originalKey;
	await rm(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Missing TCP address");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

describe("Source gateway startup", () => {
	for (const first of ["TUI", "Web"] as const) {
		it(`${first} first shares its gateway and session with the other frontend`, async () => {
			const options = {
				storagePath: join(dir, "session.sqlite"),
				credentialsPath: join(dir, "credentials.json"),
				configDir: dir,
				cwd: dir,
				port,
				spawnTimeoutMs: 5_000,
			};
			const tui = first === "TUI" ? await connectToGateway(options) : undefined;
			const web = await ensureNekoGateway(options).catch(async (error) => {
				await tui?.close();
				throw error;
			});
			try {
				const terminal = tui ?? (await connectToGateway(options));
				try {
					expect(web.serverId).toBe(terminal.serverId);
					expect(web.spawned === null).toBe(first === "TUI");
					expect(terminal.spawned).toBe(first === "TUI");
					const browser = await connectNekoGateway({ transport: "ws", url: web.wsUrl, serverId: web.serverId });
					try {
						const created = (await terminal.client.management.create({ cwd: dir })).id;
						const terminalChat = await terminal.client.attach(created);
						const browserChat = await browser.attach(created);
						expect(browser.directory.state.value?.sessions.some((session) => session.id === created)).toBe(true);
						expect(browserChat.view.value).toEqual(terminalChat.view.value);
					} finally {
						await browser.close();
					}
					if (first === "TUI") {
						await web.close();
						expect((await terminal.client.models.list(null)).length).toBeGreaterThan(0);
					} else {
						await terminal.close();
						const reconnected = await connectNekoGateway({ transport: "ws", url: web.wsUrl, serverId: web.serverId });
						await reconnected.close();
					}
				} finally {
					await terminal.close();
				}
			} finally {
				await tui?.close();
				await web.close();
			}
			if (IS_WINDOWS) expect(existsSync(join(dir, `${web.serverId}.port`))).toBe(false);
			else expect(existsSync(web.socketPath!)).toBe(false);
		}, 10_000);
	}

	it("TUI starts, reuses and closes only its own gateway", async () => {
		const options = {
			credentialsPath: join(dir, "credentials.json"),
			storagePath: join(dir, "session.sqlite"),
			configDir: dir,
			spawnTimeoutMs: 5_000,
		};
		const owner = await connectToGateway(options);
		try {
			expect(owner.spawned).toBe(true);
			if (!IS_WINDOWS) {
				const ws = await connectNekoGateway({
					transport: "ws",
					url: `ws://127.0.0.1:${port}`,
					serverId: owner.serverId,
				});
				await ws.close();
			}
			const reused = await connectToGateway(options);
			expect(reused.spawned).toBe(false);
			await reused.close();
			expect((await owner.client.models.list(null)).length).toBeGreaterThan(0);
		} finally {
			await owner.close();
		}
		// Unix socket 文件随网关退出删除；Windows（ws-only）本就没有 socket 路径，
		// 且强杀后由拉起方补删端口文件。
		if (IS_WINDOWS) {
			expect(owner.socketPath).toBeUndefined();
			expect(existsSync(join(dir, `${owner.serverId}.port`))).toBe(false);
		} else expect(existsSync(owner.socketPath!)).toBe(false);
	}, 10_000);

	it("Web uses the current runtime, forwards options, supports WS reconnect and releases its child", async () => {
		const options = {
			credentialsPath: join(dir, "credentials.json"),
			storagePath: join(dir, "session.sqlite"),
			port: await freePort(),
			cwd: dir,
			model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
			spawnTimeoutMs: 5_000,
		};
		const owner = await ensureNekoGateway(options);
		try {
			expect(owner.spawned?.spawnfile).toBe(process.execPath);
			expect(owner.spawned?.spawnargs).toContain("--conditions=neko-source");
			expect(owner.spawned?.spawnargs).toContain(dir);
			const reused = await ensureNekoGateway(options);
			expect(reused.spawned).toBeNull();
			await reused.close();
			const address = { transport: "ws" as const, url: owner.wsUrl, serverId: owner.serverId };
			const client = await connectNekoGateway(address);
			let created: string;
			try {
				const chat = await client.attach("1");
				expect(chat.view.value?.model).toBe("deepseek/deepseek-v4-pro");
				created = (await client.management.create({})).id;
			} finally {
				await client.close();
			}
			const reconnected = await connectNekoGateway(address);
			try {
				expect(reconnected.directory.state.value?.sessions.some((session) => session.id === created)).toBe(true);
			} finally {
				await reconnected.close();
			}
		} finally {
			await owner.close();
		}
		// Unix socket 文件随网关退出删除；Windows（ws-only）本就没有 socket 路径，
		// 且强杀后由拉起方补删端口文件。
		if (IS_WINDOWS) {
			expect(owner.socketPath).toBeUndefined();
			expect(existsSync(join(dir, `${owner.serverId}.port`))).toBe(false);
		} else expect(existsSync(owner.socketPath!)).toBe(false);
		// POSIX 子进程响应 SIGTERM 优雅退出（code 0）；Windows 以 TerminateProcess 结束，
		// 无优雅退出码，只能确认进程已退出（exitCode 或 signalCode 其一非空）。
		if (IS_WINDOWS) expect(owner.spawned?.exitCode !== null || owner.spawned?.signalCode !== null).toBe(true);
		else expect(owner.spawned?.exitCode).toBe(0);
		await owner.close();
	}, 10_000);

	it("startup timeout cleans up the child before returning", async () => {
		const socketPath = join(dir, "timeout.sock");
		await expect(
			ensureNekoGateway({
				credentialsPath: join(dir, "credentials.json"),
				storagePath: join(dir, "session.sqlite"),
				// Unix socket 路径仅 POSIX 有意义；Windows（ws-only）忽略。
				...(IS_WINDOWS ? {} : { socketPath }),
				port: await freePort(),
				spawnTimeoutMs: 0,
			}),
		).rejects.toThrow("超时");
		if (!IS_WINDOWS) expect(existsSync(socketPath)).toBe(false);
	});

	it("starts a gateway without credentials for frontend configuration", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		const socketPath = join(dir, "unconfigured.sock");
		const connected = await connectToGateway({
			credentialsPath: join(dir, "credentials.json"),
			storagePath: join(dir, "session.sqlite"),
			// Unix socket 路径仅 POSIX 有意义；Windows（ws-only）忽略。
			...(IS_WINDOWS ? {} : { socketPath }),
			configDir: dir,
			spawnTimeoutMs: 3_000,
		});
		if (!IS_WINDOWS) expect(existsSync(socketPath)).toBe(true);
		await connected.close();
	});
});
