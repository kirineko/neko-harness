import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpAuthStore, mcpAuthKey } from "../src/mcp-auth.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "neko-mcp-auth-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (dirs.length > 0) {
		const dir = dirs.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

describe("McpAuthStore", () => {
	it("isolates state by server name and URL, enforces 0600 permissions, and removes credentials", async () => {
		const dir = await tempDir();
		const file = join(dir, "mcp-auth.json");
		const store = new McpAuthStore(file);
		try {
			expect(mcpAuthKey("my-srv", "https://example.com/mcp")).toBe("mcp__my_srv|https://example.com/mcp");
			const a = store.forServer("acct-a", "https://example.com/mcp");
			const b = store.forServer("acct-b", "https://example.com/mcp");

			await a.save({ serverUrl: "https://example.com/mcp", tokens: { access_token: "tok-a", token_type: "Bearer" } });
			await b.save({ serverUrl: "https://example.com/mcp", tokens: { access_token: "tok-b", token_type: "Bearer" } });

			expect((await a.load())?.tokens?.access_token).toBe("tok-a");
			expect((await b.load())?.tokens?.access_token).toBe("tok-b");
			expect(await store.hasTokens("acct-a", "https://example.com/mcp")).toBe(true);

			if (process.platform !== "win32") {
				const mode = (await stat(file)).mode & 0o777;
				expect(mode).toBe(0o600);
			}

			await store.remove("acct-a", "https://example.com/mcp");
			expect(await store.hasTokens("acct-a", "https://example.com/mcp")).toBe(false);
			expect(await store.hasTokens("acct-b", "https://example.com/mcp")).toBe(true);
		} finally {
			await store.close();
		}
	});

	it("serializes concurrent refresh lock holders per server key", async () => {
		const dir = await tempDir();
		const store = new McpAuthStore(join(dir, "mcp-auth.json"));
		const srv = store.forServer("docs", "https://docs.example/mcp");
		const order: string[] = [];

		try {
			await Promise.all([
				srv.withRefreshLock(async () => {
					order.push("start-1");
					await new Promise((r) => setTimeout(r, 40));
					order.push("end-1");
				}),
				srv.withRefreshLock(async () => {
					order.push("start-2");
					order.push("end-2");
				}),
			]);
			expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
		} finally {
			await store.close();
		}
	});
});
