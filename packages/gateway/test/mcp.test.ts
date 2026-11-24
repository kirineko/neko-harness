import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { McpTransportFactory } from "@neko-harness/core";
import { APPLICATION_PROTOCOL } from "@neko-harness/core/application-version";
import { afterEach, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor as wait } from "./helpers.ts";

const waitFor = (predicate: () => boolean, desc = "mcp synchronization") => wait(predicate, desc);

const httpServers: Server[] = [];

afterEach(async () => {
	while (httpServers.length > 0) {
		const srv = httpServers.pop()!;
		await new Promise<void>((resolve) => srv.close(() => resolve()));
	}
});

function createFakeTransportFactory(
	toolsByServer: Record<string, Array<{ name: string; description: string }>>,
): McpTransportFactory {
	return (server) => {
		const name = server.name;
		const tools = toolsByServer[name] ?? [];
		const messageHandlers: Array<(message: unknown) => void> = [];
		const closeHandlers: Array<() => void> = [];
		const transport = {
			async start() {},
			onMessage(handler: (message: unknown) => void) {
				messageHandlers.push(handler);
				return () => {
					const idx = messageHandlers.indexOf(handler);
					if (idx >= 0) messageHandlers.splice(idx, 1);
				};
			},
			onError(_handler: (error: Error) => void) {
				return () => {};
			},
			onClose(handler: () => void) {
				closeHandlers.push(handler);
				return () => {
					const idx = closeHandlers.indexOf(handler);
					if (idx >= 0) closeHandlers.splice(idx, 1);
				};
			},
			async send(message: unknown) {
				const req = message as { id?: number; method?: string };
				if (req.id === undefined) return;
				if (req.method === "initialize") {
					const reply = {
						jsonrpc: "2.0",
						id: req.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name, version: "1.0.0" },
						},
					};
					queueMicrotask(() => {
						for (const h of messageHandlers) h(reply);
					});
					return;
				}
				if (req.method === "tools/list") {
					const reply = {
						jsonrpc: "2.0",
						id: req.id,
						result: {
							tools: tools.map((t) => ({
								name: t.name,
								description: t.description,
								inputSchema: { type: "object", properties: {} },
							})),
						},
					};
					queueMicrotask(() => {
						for (const h of messageHandlers) h(reply);
					});
				}
			},
			async close() {
				for (const h of closeHandlers) h();
			},
		};
		return transport as unknown as ReturnType<McpTransportFactory>;
	};
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

async function startMockOAuthMcpServer(): Promise<{
	mcpUrl: string;
	issueRedirectForAuthorizeUrl: (authUrl: string) => Promise<string>;
}> {
	const validTokens = new Set<string>();
	const authCodes = new Map<string, { codeChallenge: string }>();
	let seq = 1;
	let baseUrl = "";

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", baseUrl);
		if (
			url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
			url.pathname === "/.well-known/oauth-protected-resource"
		) {
			json(res, 200, { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl] });
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			json(res, 200, {
				issuer: baseUrl,
				authorization_endpoint: `${baseUrl}/authorize`,
				token_endpoint: `${baseUrl}/token`,
				registration_endpoint: `${baseUrl}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
			});
			return;
		}
		if (url.pathname === "/register" && req.method === "POST") {
			const payload = JSON.parse(await readBody(req)) as Record<string, unknown>;
			json(res, 201, {
				client_id: "gw-dcr-client",
				redirect_uris: payload.redirect_uris,
				client_name: payload.client_name,
			});
			return;
		}
		if (url.pathname === "/authorize") {
			const redirectUri = url.searchParams.get("redirect_uri") ?? "";
			const state = url.searchParams.get("state") ?? "";
			const codeChallenge = url.searchParams.get("code_challenge") ?? "";
			const code = `gw-code-${seq++}`;
			authCodes.set(code, { codeChallenge });
			const target = new URL(redirectUri);
			target.searchParams.set("code", code);
			target.searchParams.set("state", state);
			res.writeHead(302, { location: target.href });
			res.end();
			return;
		}
		if (url.pathname === "/token" && req.method === "POST") {
			const form = new URLSearchParams(await readBody(req));
			const code = form.get("code") ?? "";
			const verifier = form.get("code_verifier") ?? "";
			const entry = authCodes.get(code);
			if (!entry || createHash("sha256").update(verifier).digest("base64url") !== entry.codeChallenge) {
				json(res, 400, { error: "invalid_grant" });
				return;
			}
			authCodes.delete(code);
			const access = `secret-access-token-${seq++}`;
			const refresh = `secret-refresh-token-${seq++}`;
			validTokens.add(access);
			json(res, 200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
			return;
		}
		if (url.pathname === "/mcp") {
			const auth = req.headers.authorization;
			const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
			if (!validTokens.has(token)) {
				res.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/mcp"`,
				});
				res.end("Unauthorized");
				return;
			}
			if (req.method === "GET") {
				res.writeHead(405);
				res.end();
				return;
			}
			const msg = JSON.parse(await readBody(req)) as { id?: number; method: string };
			if (msg.id === undefined) {
				res.writeHead(202);
				res.end();
				return;
			}
			if (msg.method === "initialize") {
				json(res, 200, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "mock-oauth", version: "1.0.0" },
					},
				});
				return;
			}
			if (msg.method === "tools/list") {
				json(res, 200, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						tools: [
							{
								name: "whoami",
								description: "Return identity",
								inputSchema: { type: "object", properties: {} },
							},
						],
					},
				});
				return;
			}
		}
		res.writeHead(404);
		res.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	httpServers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP address");
	baseUrl = `http://127.0.0.1:${address.port}`;

	return {
		mcpUrl: `${baseUrl}/mcp`,
		async issueRedirectForAuthorizeUrl(authUrl) {
			const response = await fetch(authUrl, { redirect: "manual" });
			const location = response.headers.get("location");
			if (!location) throw new Error(`Expected 302 redirect, got ${response.status}`);
			return location;
		},
	};
}

async function start(dir: string, extra: Record<string, unknown> = {}) {
	return startGateway({
		configDir: dir,
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		mcpConfigPath: join(dir, "mcp.json"),
		mcpAuthPath: join(dir, "mcp-auth.json"),
		mcpDisableWatch: true,
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
		...extra,
	});
}

it("synchronizes MCP servers across clients and rejects invalid writes without modifying mcp.json", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-mcp-gateway-"));
	const gateway = await start(dir, {
		mcpTransportFactory: createFakeTransportFactory({
			docs: [{ name: "search", description: "Search docs" }],
		}),
	});
	const unix = await connectTestClient(gateway);
	const web = await connectTestWsClient(gateway);
	try {
		await waitFor(() => !!web.mcp.snapshot.value && !!unix.mcp.snapshot.value);
		expect(web.application.info.value?.protocolVersion).toBe(APPLICATION_PROTOCOL);
		expect(APPLICATION_PROTOCOL).toBe(12);
		expect(web.mcp.snapshot.value!.servers).toEqual([]);

		await unix.mcp.upsertServer({
			name: "docs",
			config: { transport: "stdio", command: "node", args: ["-v"] },
		});
		await waitFor(
			() => web.mcp.snapshot.value?.servers.some((s) => s.name === "docs" && s.status === "connected") ?? false,
			"docs connected on web",
		);
		expect(web.mcp.snapshot.value!.servers[0]?.tools.map((t) => t.name)).toEqual(["search"]);

		const beforeRaw = await readFile(join(dir, "mcp.json"), "utf8");
		const revBeforeInvalid = web.mcp.snapshot.value!.revision;

		await expect(web.mcp.saveRawConfig({ rawJson: "{ not valid json" })).rejects.toThrow();
		await expect(
			web.mcp.upsertServer({
				name: "bad",
				config: { transport: "http", url: "not-a-url" },
			}),
		).rejects.toThrow();
		await sleep(50);
		expect(await readFile(join(dir, "mcp.json"), "utf8")).toBe(beforeRaw);
		expect(web.mcp.snapshot.value!.revision).toBe(revBeforeInvalid);

		await web.mcp.setEnabled({ name: "docs", enabled: false });
		await waitFor(() => unix.mcp.snapshot.value?.servers[0]?.status === "disabled", "docs disabled");

		await unix.mcp.setEnabled({ name: "docs", enabled: true });
		await waitFor(() => web.mcp.snapshot.value?.servers[0]?.status === "connected", "docs re-enabled");

		await web.mcp.reconnect({ name: "docs" });
		await waitFor(() => unix.mcp.snapshot.value?.servers[0]?.status === "connected", "docs reconnected");

		await unix.mcp.removeServer({ name: "docs" });
		await waitFor(() => web.mcp.snapshot.value?.servers.length === 0, "docs removed");
	} finally {
		await unix.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("completes OAuth sign-in via gateway without leaking tokens in snapshots or results", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-mcp-gateway-oauth-"));
	const remote = await startMockOAuthMcpServer();
	await writeFile(
		join(dir, "mcp.json"),
		JSON.stringify({ mcpServers: { cloud: { transport: "http", url: remote.mcpUrl } } }, null, 2),
	);
	const gateway = await start(dir);
	const client = await connectTestClient(gateway);
	try {
		await waitFor(
			() => client.mcp.snapshot.value?.servers.some((s) => s.name === "cloud" && s.status === "auth_required") ?? false,
			"cloud auth_required",
		);

		const begun = await client.mcp.beginSignIn({ server: "cloud" });
		expect(begun.status).toBe("redirect");
		if (begun.status !== "redirect") throw new Error("Expected redirect");
		expect(JSON.stringify(begun)).not.toContain("secret-access-token");
		expect(JSON.stringify(begun)).not.toContain("secret-refresh-token");

		const redirectUrl = await remote.issueRedirectForAuthorizeUrl(begun.authorizationUrl);
		const afterPaste = await client.mcp.pasteSignIn({ id: begun.id, redirectUrl });
		expect(JSON.stringify(afterPaste)).not.toContain("secret-access-token");
		expect(JSON.stringify(afterPaste)).not.toContain("secret-refresh-token");

		await waitFor(
			() => client.mcp.snapshot.value?.servers.some((s) => s.name === "cloud" && s.status === "connected") ?? false,
			"cloud connected after oauth",
		);
		const snapshotJson = JSON.stringify(client.mcp.snapshot.value);
		expect(snapshotJson).not.toContain("secret-access-token");
		expect(snapshotJson).not.toContain("secret-refresh-token");
		expect(client.mcp.snapshot.value!.servers[0]?.oauth).toEqual({ supported: true, signedIn: true });
		expect(client.mcp.snapshot.value!.servers[0]?.tools.map((t) => t.name)).toEqual(["whoami"]);

		await client.mcp.signOut({ server: "cloud" });
		await waitFor(
			() => client.mcp.snapshot.value?.servers.some((s) => s.name === "cloud" && !s.oauth.signedIn) ?? false,
			"cloud signed out",
		);
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 20_000);
