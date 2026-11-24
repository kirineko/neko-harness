import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp-manager.ts";

const dirs: string[] = [];
const servers: Server[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "neko-mcp-oauth-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (servers.length > 0) {
		const srv = servers.pop()!;
		await new Promise<void>((resolve) => srv.close(() => resolve()));
	}
	while (dirs.length > 0) {
		await rm(dirs.pop()!, { recursive: true, force: true });
	}
});

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

async function startMockOAuthMcpServer(): Promise<{
	mcpUrl: string;
	validTokens: Set<string>;
	refreshCount: () => number;
	issueCodeForAuthorizeUrl: (authUrl: string) => Promise<string>;
}> {
	const validTokens = new Set<string>();
	const refreshTokens = new Map<string, string>();
	const authCodes = new Map<string, { codeChallenge: string; redirectUri: string }>();
	let refreshes = 0;
	let tokenSeq = 1;
	let baseUrl = "";

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", baseUrl);
		if (
			url.pathname === "/.well-known/oauth-protected-resource/mcp" ||
			url.pathname === "/.well-known/oauth-protected-resource"
		) {
			json(res, 200, {
				resource: `${baseUrl}/mcp`,
				authorization_servers: [baseUrl],
			});
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
				client_id: "dcr-client-1",
				redirect_uris: payload.redirect_uris,
				client_name: payload.client_name,
			});
			return;
		}
		if (url.pathname === "/authorize") {
			const redirectUri = url.searchParams.get("redirect_uri") ?? "";
			const state = url.searchParams.get("state") ?? "";
			const codeChallenge = url.searchParams.get("code_challenge") ?? "";
			const code = `code-${tokenSeq++}`;
			authCodes.set(code, { codeChallenge, redirectUri });
			const target = new URL(redirectUri);
			target.searchParams.set("code", code);
			target.searchParams.set("state", state);
			res.writeHead(302, { location: target.href });
			res.end();
			return;
		}
		if (url.pathname === "/token" && req.method === "POST") {
			const form = new URLSearchParams(await readBody(req));
			const grantType = form.get("grant_type");
			if (grantType === "authorization_code") {
				const code = form.get("code") ?? "";
				const verifier = form.get("code_verifier") ?? "";
				const entry = authCodes.get(code);
				if (!entry) {
					json(res, 400, { error: "invalid_grant" });
					return;
				}
				const challenge = createHash("sha256").update(verifier).digest("base64url");
				if (challenge !== entry.codeChallenge) {
					json(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
					return;
				}
				authCodes.delete(code);
				const access = `access-${tokenSeq++}`;
				const refresh = `refresh-${tokenSeq++}`;
				validTokens.add(access);
				refreshTokens.set(refresh, access);
				json(res, 200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
				return;
			}
			if (grantType === "refresh_token") {
				const refresh = form.get("refresh_token") ?? "";
				if (!refreshTokens.has(refresh)) {
					json(res, 400, { error: "invalid_grant" });
					return;
				}
				refreshes += 1;
				const access = `access-${tokenSeq++}`;
				validTokens.add(access);
				json(res, 200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
				return;
			}
			json(res, 400, { error: "unsupported_grant_type" });
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
			const body = await readBody(req);
			const msg = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
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
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "oauth-mcp", version: "1.0.0" },
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
								description: "Check auth",
								inputSchema: { type: "object", properties: {} },
								annotations: { readOnlyHint: true },
							},
						],
					},
				});
				return;
			}
			if (msg.method === "tools/call") {
				json(res, 200, {
					jsonrpc: "2.0",
					id: msg.id,
					result: { content: [{ type: "text", text: `authed:${token}` }] },
				});
				return;
			}
		}
		res.writeHead(404);
		res.end();
	});

	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	baseUrl = `http://127.0.0.1:${port}`;

	return {
		mcpUrl: `${baseUrl}/mcp`,
		validTokens,
		refreshCount: () => refreshes,
		issueCodeForAuthorizeUrl: async (authUrl: string) => {
			const response = await fetch(authUrl, { redirect: "manual" });
			const location = response.headers.get("location");
			if (!location) throw new Error("Expected redirect location from /authorize");
			return location;
		},
	};
}

describe("McpManager OAuth 2.1 flow", () => {
	it("transitions to auth_required on 401, completes via loopback callback, never leaks tokens, and clears on signOut", async () => {
		const dir = await tempDir();
		const mock = await startMockOAuthMcpServer();
		const manager = new McpManager({
			configPath: join(dir, "mcp.json"),
			authPath: join(dir, "mcp-auth.json"),
			disableWatch: true,
		});
		try {
			await manager.start();
			await manager.upsertServer("remote", { transport: "http", url: mock.mcpUrl });
			await manager.waitForReady();

			expect(manager.snapshot().servers[0]?.status).toBe("auth_required");
			expect(manager.snapshot().servers[0]?.oauth).toEqual({ supported: true, signedIn: false });

			// Begin sign-in -> returns redirect URL and listens on loopback.
			const started = await manager.beginSignIn("remote");
			expect(started.status).toBe("redirect");
			if (started.status !== "redirect") throw new Error("Expected redirect");

			// Simulate browser visiting authorizationUrl -> redirect to loopback callback.
			const callbackUrl = await mock.issueCodeForAuthorizeUrl(started.authorizationUrl);
			const cbRes = await fetch(callbackUrl);
			expect(cbRes.status).toBe(200);

			await waitUntil(() => manager.snapshot().servers[0]?.status === "connected", 5000);
			const snap = manager.snapshot();
			expect(snap.servers[0]?.oauth).toEqual({ supported: true, signedIn: true });
			expect(snap.signIns).toEqual([]);
			// Snapshot must never leak access or refresh tokens.
			const serialized = JSON.stringify(snap);
			expect(serialized).not.toContain("access-");
			expect(serialized).not.toContain("refresh-");

			const callRes = await manager.callTool("remote", "whoami", {});
			expect(callRes.content[0]?.type).toBe("text");
			expect(callRes.content[0]?.type === "text" ? callRes.content[0].text : "").toContain("authed:access-");

			// Sign out wipes tokens and returns server to auth_required.
			await manager.signOut("remote");
			await manager.waitForReady();
			expect(manager.snapshot().servers[0]?.status).toBe("auth_required");
			expect(manager.snapshot().servers[0]?.oauth.signedIn).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("completes via pasted redirect URL, rejects wrong state, and supports silent refresh on re-sign-in", async () => {
		const dir = await tempDir();
		const mock = await startMockOAuthMcpServer();
		const manager = new McpManager({
			configPath: join(dir, "mcp.json"),
			authPath: join(dir, "mcp-auth.json"),
			disableWatch: true,
		});
		try {
			await manager.start();
			await manager.upsertServer("remote", { transport: "http", url: mock.mcpUrl });
			await manager.waitForReady();

			const started = await manager.beginSignIn("remote");
			expect(started.status).toBe("redirect");
			if (started.status !== "redirect") throw new Error("Expected redirect");

			// Wrong state is rejected.
			const goodRedirect = await mock.issueCodeForAuthorizeUrl(started.authorizationUrl);
			const badRedirect = new URL(goodRedirect);
			badRedirect.searchParams.set("state", "wrong-state");
			await expect(manager.pasteSignIn(started.id, badRedirect.href)).rejects.toThrow(/different sign-in/);

			// Correct pasted URL completes sign-in without hitting the loopback port.
			await manager.pasteSignIn(started.id, goodRedirect);
			await waitUntil(() => manager.snapshot().servers[0]?.status === "connected", 5000);
			expect(manager.snapshot().servers[0]?.oauth.signedIn).toBe(true);

			// Revoke the access token so refresh is exercised on beginSignIn.
			mock.validTokens.clear();
			const refreshed = await manager.beginSignIn("remote");
			expect(refreshed.status).toBe("authorized");
			expect(mock.refreshCount()).toBeGreaterThanOrEqual(1);
			await waitUntil(() => manager.snapshot().servers[0]?.status === "connected", 5000);
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
