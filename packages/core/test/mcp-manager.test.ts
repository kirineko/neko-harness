import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp-manager.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "neko-mcp-mgr-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (dirs.length > 0) {
		await rm(dirs.pop()!, { recursive: true, force: true });
	}
});

type FakeServerController = {
	tools: Array<{
		name: string;
		description?: string;
		inputSchema: Record<string, unknown>;
		annotations?: { readOnlyHint?: boolean };
	}>;
	notifyToolsChanged(): Promise<void>;
	dropConnection(): Promise<void>;
};

function createFakeServerTransport(initialTools: FakeServerController["tools"]): {
	clientTransport: ReturnType<typeof createInMemoryTransportPair>["client"];
	controller: FakeServerController;
} {
	const { client: clientTransport, server: serverTransport } = createInMemoryTransportPair();
	void serverTransport.start();
	const controller: FakeServerController = {
		tools: [...initialTools],
		notifyToolsChanged: async () => {
			await serverTransport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		},
		dropConnection: async () => {
			await serverTransport.close();
		},
	};
	serverTransport.onMessage((message: JsonRpcMessage) => {
		if (!("method" in message) || !("id" in message) || message.id === undefined) return;
		if (message.method === "initialize") {
			void serverTransport.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: { listChanged: true } },
					serverInfo: { name: "fake", version: "1.0.0" },
					instructions: "Use fake tools wisely.\nSecond line.",
				},
			});
			return;
		}
		if (message.method === "tools/list") {
			void serverTransport.send({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: controller.tools },
			});
			return;
		}
		if (message.method === "tools/call") {
			const params = message.params as { name: string; arguments?: Record<string, unknown> };
			void serverTransport.send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					content: [{ type: "text", text: `called:${params.name}:${JSON.stringify(params.arguments ?? {})}` }],
					structuredContent: { ok: true, tool: params.name },
				},
			});
		}
	});
	return { clientTransport, controller };
}

describe("McpManager", () => {
	it("connects, refreshes on tools/list_changed, reconnects on drop, and stops on disable/remove", async () => {
		const dir = await tempDir();
		const controllers: FakeServerController[] = [];
		const manager = new McpManager({
			configPath: join(dir, "mcp.json"),
			authPath: join(dir, "mcp-auth.json"),
			disableWatch: true,
			reconnectBaseMs: 40,
			reconnectMaxMs: 120,
			transportFactory: () => {
				const fake = createFakeServerTransport([
					{
						name: "search",
						description: "Search docs",
						inputSchema: { type: "object", properties: { q: { type: "string" } } },
						annotations: { readOnlyHint: true },
					},
				]);
				controllers.push(fake.controller);
				return fake.clientTransport;
			},
		});

		try {
			await manager.start();
			expect(manager.hasEnabledServers()).toBe(false);

			await manager.upsertServer("docs", { transport: "stdio", command: "fake" });
			await manager.waitForReady();

			const snap1 = manager.snapshot();
			expect(snap1.servers[0]?.status).toBe("connected");
			expect(snap1.servers[0]?.tools.map((t) => t.registeredName)).toEqual(["mcp__docs__search"]);
			expect(manager.isToolReadOnly("mcp__docs__search")).toBe(true);

			const res = await manager.callTool("docs", "search", { q: "pi" });
			expect(res.content[0]).toEqual({ type: "text", text: 'called:search:{"q":"pi"}' });

			// Server sends tools/list_changed notification.
			controllers[0]!.tools.push({
				name: "write_note",
				description: "Write a note",
				inputSchema: { type: "object", properties: {} },
			});
			await controllers[0]!.notifyToolsChanged();
			await waitUntil(() => manager.snapshot().servers[0]?.tools.length === 2, 2000);
			expect(manager.isToolReadOnly("mcp__docs__write_note")).toBe(false);

			// Unexpected disconnect triggers backoff reconnect and recovers tools.
			await controllers[0]!.dropConnection();
			await waitUntil(() => controllers.length >= 2 && manager.snapshot().servers[0]?.status === "connected", 2000);

			// Disabling disconnects and clears tools.
			await manager.setEnabled("docs", false);
			expect(manager.snapshot().servers[0]?.status).toBe("disabled");
			expect(manager.hasEnabledServers()).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("launches and cleanly terminates a real stdio MCP server subprocess on close", async () => {
		const dir = await tempDir();
		const script = join(dir, "stdio-mcp.mjs");
		await writeFile(
			script,
			`
import readline from "node:readline";
process.stderr.write("booting stdio fixture\\n");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{ name: "ping", description: "Ping pong", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
      },
    }) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "pong:" + (process.env.FIXTURE_TAG ?? "") }] },
    }) + "\\n");
  }
});
`,
			"utf8",
		);

		const manager = new McpManager({
			configPath: join(dir, "mcp.json"),
			authPath: join(dir, "mcp-auth.json"),
			disableWatch: true,
			env: { ...process.env, MY_TAG: "neko-ok" },
		});
		try {
			await manager.start();
			await manager.upsertServer("local", {
				transport: "stdio",
				command: process.execPath,
				args: [script],
				env: { FIXTURE_TAG: "${MY_TAG}" },
			});
			await manager.waitForReady();
			const snap = manager.snapshot();
			expect(snap.servers[0]?.status).toBe("connected");
			expect(snap.servers[0]?.stderrTail).toContain("booting stdio fixture");
			const result = await manager.callTool("local", "ping", {});
			expect(result.content[0]).toEqual({ type: "text", text: "pong:neko-ok" });
		} finally {
			await manager.close();
		}
	});

	it("marks server as error when an env template variable is missing", async () => {
		const dir = await tempDir();
		const manager = new McpManager({
			configPath: join(dir, "mcp.json"),
			authPath: join(dir, "mcp-auth.json"),
			disableWatch: true,
			env: {},
		});
		try {
			await manager.start();
			await manager.upsertServer("broken", {
				transport: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer ${MISSING_SECRET}" },
			});
			await manager.waitForReady();
			expect(manager.snapshot().servers[0]?.status).toBe("error");
			expect(manager.snapshot().servers[0]?.error).toContain("MISSING_SECRET");
		} finally {
			await manager.close();
		}
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("Timed out waiting for condition");
}
