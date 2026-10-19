import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { rm } from "../../../../test/temp-dir.ts";
import { connectNekoGateway, type NekoGateway, startGateway } from "../../src/index.ts";
import { testAddress, testSocketPath, waitFor } from "../helpers.ts";
import { connectMobileWs, type MobileWsClient } from "./ws-client.ts";

function credential(): string {
	return randomBytes(32).toString("base64url");
}

function parsePairingText(pairingText: string): { readonly sid: string; readonly code: string } {
	return JSON.parse(Buffer.from(pairingText.slice("nekopair:1:".length), "base64url").toString("utf8")) as never;
}

async function freePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no address assigned");
	const { port } = address;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

function mobileRequest(
	port: number,
	path: string,
	body: Buffer,
): Promise<{ readonly status: number; readonly body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				rejectUnauthorized: false,
				headers: { "content-type": "application/json", "content-length": body.byteLength },
			},
			(response) => {
				let text = "";
				response.on("data", (chunk: Buffer) => {
					text += chunk.toString("utf8");
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
			},
		);
		request.on("error", reject);
		request.end(body);
	});
}

type RunningGateway = {
	readonly gateway: NekoGateway;
	readonly port: number;
	readonly dir: string;
};

async function startEnabledGateway(dir: string): Promise<RunningGateway> {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		socketPath: testSocketPath(dir),
		port: 0,
		mobileServerName: "TestPC",
		mobileNetwork: { wsl: null },
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	const port = await freePort();
	await gateway.mobile.enable({ address: "127.0.0.1", port });
	return { gateway, port, dir };
}

async function pairDevice(gateway: NekoGateway, port: number): Promise<{ deviceId: string; credential: string }> {
	const payload = parsePairingText(gateway.mobile.createPairing().pairingText);
	const deviceId = randomUUID();
	const secret = credential();
	const response = await mobileRequest(
		port,
		"/mobile/v1/pair",
		Buffer.from(
			JSON.stringify({
				v: 1,
				sid: payload.sid,
				code: payload.code,
				pairRequestId: randomUUID(),
				deviceId,
				deviceName: "Pixel 9",
				credential: secret,
			}),
			"utf8",
		),
	);
	expect(response.status).toBe(200);
	return { deviceId, credential: secret };
}

async function connectMobileHello(
	port: number,
	device: { deviceId: string; credential: string },
): Promise<MobileWsClient> {
	const client = await connectMobileWs(port, { Authorization: `Neko-Device ${device.deviceId}.${device.credential}` });
	client.send({
		jsonrpc: "2.0",
		id: 1,
		method: "server.hello",
		params: { apiVersions: [1], app: { version: "1.0.0", platform: "android", build: "test" } },
	});
	const hello = (await client.nextMessage()) as { result: { apiVersion: number; capabilities: string[] } };
	expect(hello.result.apiVersion).toBe(1);
	return client;
}

let rpcId = 0;
async function rpc<T>(client: MobileWsClient, method: string, params: unknown): Promise<T> {
	const id = ++rpcId;
	client.send({ jsonrpc: "2.0", id, method, params });
	for (;;) {
		const message = (await client.nextMessage()) as {
			id?: number;
			method?: string;
			result?: T;
			error?: { message?: string; data?: { code: string } };
		};
		if (message.method !== undefined) continue; // 跳过通知
		if (message.id !== id) continue;
		if (message.error !== undefined)
			throw new Error(`${message.error.data?.code ?? "error"}: ${message.error.message ?? ""}`);
		return message.result as T;
	}
}

async function nextNotification(client: MobileWsClient, method: string): Promise<Record<string, unknown>> {
	for (;;) {
		const message = (await client.nextMessage()) as { method?: string; params?: Record<string, unknown> };
		if (message.method === method) return message.params ?? {};
	}
}

let dir: string;
let workspaceA: string;
let workspaceB: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "neko-mobile-api-"));
	await mkdir(join(dir, "ws-alpha"), { recursive: true });
	await mkdir(join(dir, "ws-beta"), { recursive: true });
	// macOS 临时目录经 /var 符号链接；runtime 登记的是 realpath 形式，测试需对齐。
	dir = await realpath(dir);
	workspaceA = join(dir, "ws-alpha");
	workspaceB = join(dir, "ws-beta");
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("mobile api v1 workspaces and sessions", () => {
	it("lists registered workspaces with root and display name", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const desktop = await connectNekoGateway(testAddress(gateway));
			await desktop.workspaces.add({ path: workspaceA });
			await desktop.workspaces.add({ path: workspaceB });
			const device = await pairDevice(gateway, port);
			const client = await connectMobileHello(port, device);
			const result = await rpc<{ workspaces: Array<{ root: string; name: string }> }>(client, "workspaces.list", null);
			const roots = result.workspaces.map((workspace) => workspace.root);
			expect(roots).toContain(workspaceA);
			expect(roots).toContain(workspaceB);
			const alpha = result.workspaces.find((workspace) => workspace.root === workspaceA);
			expect(alpha?.name).toBe("ws-alpha");
			client.close(1000, "done");
			await client.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("rejects unknown workspaces for list and create without falling back", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const desktop = await connectNekoGateway(testAddress(gateway));
			await desktop.workspaces.add({ path: workspaceA });
			const before = desktop.directory.state.value?.sessions.length ?? 0;
			const device = await pairDevice(gateway, port);
			const client = await connectMobileHello(port, device);
			await expect(rpc(client, "sessions.list", { workspace: "/nonexistent" })).rejects.toThrow("invalid_params");
			await expect(rpc(client, "sessions.create", { workspace: "/nonexistent" })).rejects.toThrow("invalid_params");
			expect(desktop.directory.state.value?.sessions.length ?? 0).toBe(before);
			client.close(1000, "done");
			await client.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("creates sessions in workspace B that are visible in the desktop directory", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const desktop = await connectNekoGateway(testAddress(gateway));
			await desktop.workspaces.add({ path: workspaceA });
			await desktop.workspaces.add({ path: workspaceB });
			const device = await pairDevice(gateway, port);
			const client = await connectMobileHello(port, device);
			const created = await rpc<{ id: string; workspace: string }>(client, "sessions.create", {
				workspace: workspaceB,
			});
			expect(created.workspace).toBe(workspaceB);
			const start = Date.now();
			for (;;) {
				const visible = (desktop.directory.state.value?.sessions ?? []).some((session) => session.id === created.id);
				if (visible) break;
				if (Date.now() - start > 5_000) throw new Error("desktop directory did not show the mobile-created session");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const listed = await rpc<{ sessions: Array<{ id: string; workspace: string }> }>(client, "sessions.list", {
				workspace: workspaceB,
			});
			expect(listed.sessions.some((session) => session.id === created.id)).toBe(true);
			client.close(1000, "done");
			await client.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("filters, searches, and paginates sessions per workspace", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const desktop = await connectNekoGateway(testAddress(gateway));
			await desktop.workspaces.add({ path: workspaceA });
			await desktop.workspaces.add({ path: workspaceB });
			const device = await pairDevice(gateway, port);
			const client = await connectMobileHello(port, device);
			let markedId = "";
			for (let index = 0; index < 55; index += 1) {
				const created = await rpc<{ id: string }>(client, "sessions.create", { workspace: workspaceA });
				if (index === 0) markedId = created.id;
			}
			await rpc(client, "sessions.create", { workspace: workspaceB });

			const marked = await desktop.attach(markedId);
			await marked.submit({ content: "zz-marker 登录页修复说明" });
			await waitFor(() => (marked.view.value?.items.length ?? 0) > 0, "marked session preview");
			await desktop.detach();

			const first = await rpc<{ sessions: Array<{ id: string; lastMessageAt: number }>; nextCursor?: string }>(
				client,
				"sessions.list",
				{ workspace: workspaceA },
			);
			expect(first.sessions).toHaveLength(50);
			expect(first.nextCursor).toBeDefined();
			expect(first.sessions[0]?.id).toBe(markedId);
			for (let index = 1; index < first.sessions.length; index += 1) {
				expect(first.sessions[index - 1]?.lastMessageAt).toBeGreaterThanOrEqual(
					first.sessions[index]?.lastMessageAt ?? 0,
				);
			}
			const second = await rpc<{ sessions: Array<{ id: string }>; nextCursor?: string }>(client, "sessions.list", {
				workspace: workspaceA,
				cursor: first.nextCursor,
			});
			expect(second.sessions.length).toBe(5);
			expect(second.nextCursor).toBeUndefined();
			const ids = new Set([...first.sessions, ...second.sessions].map((session) => session.id));
			expect(ids.size).toBe(55);

			const byPreview = await rpc<{ sessions: Array<{ id: string; title: string; preview: string }> }>(
				client,
				"sessions.list",
				{ workspace: workspaceA, query: "zz-marker" },
			);
			expect(byPreview.sessions.map((session) => session.id)).toEqual([markedId]);
			expect(byPreview.sessions[0]?.preview).toContain("zz-marker");
			const noMatch = await rpc<{ sessions: Array<unknown> }>(client, "sessions.list", {
				workspace: workspaceA,
				query: "no-such-string-zzzz",
			});
			expect(noMatch.sessions).toEqual([]);
			client.close(1000, "done");
			await client.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	}, 20_000);

	it("orders sessions by last message time, not by opening them", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const desktop = await connectNekoGateway(testAddress(gateway));
			await desktop.workspaces.add({ path: workspaceA });
			const device = await pairDevice(gateway, port);
			const client = await connectMobileHello(port, device);
			const ids: string[] = [];
			for (let index = 0; index < 3; index += 1) {
				ids.push((await rpc<{ id: string }>(client, "sessions.create", { workspace: workspaceA })).id);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const list = async () =>
				(
					await rpc<{ sessions: Array<{ id: string }> }>(client, "sessions.list", { workspace: workspaceA })
				).sessions.map((session) => session.id);
			const newestFirst = [...ids].reverse();
			expect(await list()).toEqual(newestFirst);

			const opened = await desktop.attach(ids[0] ?? "");
			await desktop.detach();
			expect(opened).toBeDefined();
			expect(await list()).toEqual(newestFirst);

			const oldest = await desktop.attach(ids[0] ?? "");
			await oldest.submit({ content: "bump" });
			await waitFor(() => (oldest.view.value?.items.length ?? 0) > 0, "message recorded");
			await desktop.detach();
			expect(await list()).toEqual([ids[0] ?? "", ...newestFirst.slice(0, 2)]);

			client.close(1000, "done");
			await client.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	}, 20_000);

	it("broadcasts sessions.changed and workspaces.changed to every connected phone", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const desktop = await connectNekoGateway(testAddress(gateway));
			await desktop.workspaces.add({ path: workspaceA });
			const first = await pairDevice(gateway, port);
			const second = await pairDevice(gateway, port);
			const firstClient = await connectMobileHello(port, first);
			const secondClient = await connectMobileHello(port, second);

			await desktop.management.create({});
			const firstNotice = await nextNotification(firstClient, "sessions.changed");
			const secondNotice = await nextNotification(secondClient, "sessions.changed");
			expect(typeof firstNotice.revision).toBe("number");
			expect(secondNotice.revision).toBe(firstNotice.revision);

			await desktop.workspaces.add({ path: workspaceB });
			const workspaceNotice = await nextNotification(firstClient, "workspaces.changed");
			expect(typeof workspaceNotice.revision).toBe("number");
			await nextNotification(secondClient, "workspaces.changed");

			firstClient.close(1000, "done");
			secondClient.close(1000, "done");
			await firstClient.waitForClose();
			await secondClient.waitForClose();
			await desktop.close();
		} finally {
			await gateway.close();
		}
	});

	it("still reports hello capabilities with the implemented surfaces", async () => {
		const { gateway, port } = await startEnabledGateway(dir);
		try {
			const device = await pairDevice(gateway, port);
			const client = await connectMobileWs(port, {
				Authorization: `Neko-Device ${device.deviceId}.${device.credential}`,
			});
			client.send({
				jsonrpc: "2.0",
				id: 1,
				method: "server.hello",
				params: { apiVersions: [1], app: { version: "1.0.0", platform: "android", build: "test" } },
			});
			const hello = (await client.nextMessage()) as {
				result: { capabilities: string[]; limits: Record<string, number> };
			};
			expect(hello.result.capabilities).toEqual([
				"workspaces",
				"sessions",
				"chat",
				"subagents",
				"approvals",
				"media",
				"todos",
				"questions",
			]);
			expect(hello.result.limits.maxFrameBytes).toBe(262144);
			client.close(1000, "done");
			await client.waitForClose();
		} finally {
			await gateway.close();
		}
	});
});
