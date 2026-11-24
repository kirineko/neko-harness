import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	expandEnvTemplate,
	expandRecordTemplates,
	McpConfigStore,
	parseMcpConfigText,
	resolveMcpCwd,
} from "../src/mcp-config.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "neko-mcp-cfg-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (dirs.length > 0) {
		const dir = dirs.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

describe("parseMcpConfigText", () => {
	it("parses valid stdio and http servers with exposure and skips invalid entries", () => {
		const { parsed } = parseMcpConfigText(
			JSON.stringify({
				mcpServers: {
					fs: { command: "npx", args: ["-y", "server-fs"], exposure: "direct", timeout: 45 },
					docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
					legacy: { type: "sse", url: "https://example.com/sse" },
					badExp: { command: "echo", exposure: "hidden" },
					cimdSrv: { url: "https://example.com/mcp", oauth: { clientRegistration: "cimd" } },
				},
			}),
		);
		expect(parsed.servers.map((s) => s.name)).toEqual(["fs", "docs"]);
		expect(parsed.servers[0]?.exposure).toBe("direct");
		expect(parsed.servers[1]?.exposure).toBe("auto");
		expect(parsed.entryErrors).toHaveLength(3);
		expect(parsed.entryErrors[0]).toContain("SSE");
		expect(parsed.entryErrors[1]).toContain("exposure");
		expect(parsed.entryErrors[2]).toContain("cimd");
	});

	it("rejects colliding server namespaces differing only in - and _", () => {
		const { parsed } = parseMcpConfigText(
			JSON.stringify({
				mcpServers: {
					"my-docs": { url: "https://a.example/mcp" },
					my_docs: { url: "https://b.example/mcp" },
				},
			}),
		);
		expect(parsed.servers.map((s) => s.name)).toEqual(["my-docs"]);
		expect(parsed.entryErrors).toHaveLength(1);
		expect(parsed.entryErrors[0]).toContain("namespace conflicts");
	});
});

describe("env templates and cwd resolution", () => {
	it("expands ${NAME} and throws on missing variables", () => {
		expect(expandEnvTemplate("Bearer ${TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
		expect(expandRecordTemplates({ A: "${X}", B: "plain" }, { X: "1" })).toEqual({ A: "1", B: "plain" });
		expect(() => expandEnvTemplate("Bearer ${MISSING}", {})).toThrow("MISSING");
	});

	it("resolves ~ and relative cwd paths", () => {
		expect(resolveMcpCwd("~/proj", "/work", "/home/alice")).toBe("/home/alice/proj");
		expect(resolveMcpCwd("sub", "/work", "/home/alice")).toBe("/work/sub");
		expect(resolveMcpCwd(undefined, "/work", "/home/alice")).toBe("/work");
	});
});

describe("McpConfigStore", () => {
	it("treats missing mcp.json as empty without creating it, and preserves ${VAR} templates on edits", async () => {
		const dir = await tempDir();
		const file = join(dir, "mcp.json");
		const store = new McpConfigStore(file, { debounceMs: 30 });
		try {
			const initial = await store.reload();
			expect(initial.servers).toEqual([]);
			expect(initial.configError).toBeNull();
			await expect(readFile(file, "utf8")).rejects.toThrow();

			await store.upsertServer("docs", {
				transport: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
				description: "Initial",
			});
			await store.setEnabled("docs", false);
			const disk = await readFile(file, "utf8");
			expect(disk).toContain("${DOCS_TOKEN}");
			expect(store.state.servers[0]?.enabled).toBe(false);

			await store.upsertServer("docs", {
				transport: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer ${DOCS_TOKEN}" },
				description: "Updated",
				enabled: true,
			});
			const diskAfter = await readFile(file, "utf8");
			expect(diskAfter).toContain("${DOCS_TOKEN}");
			expect(diskAfter).toContain("Updated");

			await store.removeServer("docs");
			expect(store.state.servers).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("handles concurrent writes safely and rejects invalid raw JSON saves", async () => {
		const dir = await tempDir();
		const file = join(dir, "mcp.json");
		const store = new McpConfigStore(file, { debounceMs: 30 });
		try {
			await Promise.all([
				store.upsertServer("s1", { transport: "stdio", command: "node", args: ["a.js"] }),
				store.upsertServer("s2", { transport: "stdio", command: "node", args: ["b.js"] }),
			]);
			expect(store.state.servers.map((s) => s.name).sort()).toEqual(["s1", "s2"]);

			await expect(store.saveRawJson("{ invalid")).rejects.toThrow(/Invalid mcp\.json syntax/);
			await expect(
				store.saveRawJson(JSON.stringify({ mcpServers: { bad: { type: "sse", url: "https://x.test/sse" } } })),
			).rejects.toThrow(/SSE/);
			// Original file remains untouched after rejected saves.
			const onDisk = JSON.parse(await readFile(file, "utf8")) as { mcpServers: Record<string, unknown> };
			expect(Object.keys(onDisk.mcpServers).sort()).toEqual(["s1", "s2"]);
		} finally {
			store.close();
		}
	});

	it("watches external edits, suppresses self-writes, and keeps last-valid servers on syntax error", async () => {
		const dir = await tempDir();
		const file = join(dir, "mcp.json");
		await writeFile(file, JSON.stringify({ mcpServers: { a: { command: "node", args: ["a.js"] } } }), "utf8");

		const store = new McpConfigStore(file, { debounceMs: 40 });
		const events: number[] = [];
		store.subscribe((s) => events.push(s.servers.length));
		try {
			await store.reload();
			store.startWatching();
			const beforeSelf = events.length;

			// Self-write emits once directly, and watcher should suppress redundant reload.
			await store.upsertServer("b", { transport: "http", url: "https://b.example/mcp" });
			await new Promise((r) => setTimeout(r, 150));
			expect(events.length).toBe(beforeSelf + 1);
			expect(store.state.servers.map((s) => s.name)).toEqual(["a", "b"]);

			// External syntax error keeps last valid servers and exposes configError.
			await writeFile(file, "{ broken json", "utf8");
			await waitUntil(() => store.state.configError !== null, 2000);
			expect(store.state.servers.map((s) => s.name)).toEqual(["a", "b"]);
			expect(store.state.configError).toContain("Invalid mcp.json syntax");

			// Fixing the file clears configError and loads the new server set.
			await writeFile(file, JSON.stringify({ mcpServers: { c: { url: "https://c.example/mcp" } } }), "utf8");
			await waitUntil(() => store.state.configError === null && store.state.servers[0]?.name === "c", 2000);
			expect(store.state.servers.map((s) => s.name)).toEqual(["c"]);
		} finally {
			store.close();
		}
	});

	it("validates the ~/.neko/mcp.json examples in README.md and docs/README.zh-CN.md", async () => {
		const root = join(import.meta.dirname, "../../..");
		for (const rel of ["README.md", "docs/README.zh-CN.md"]) {
			const md = await readFile(join(root, rel), "utf8");
			const match = /```json\s*(\{\s*"mcpServers":[\s\S]*?\})\s*```/.exec(md);
			expect(match?.[1], `Expected mcpServers json example in ${rel}`).toBeTruthy();
			const { parsed } = parseMcpConfigText(match![1]!);
			expect(parsed.entryErrors).toEqual([]);
			expect(parsed.servers.map((s) => s.name)).toEqual(["filesystem", "remote-docs"]);
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
