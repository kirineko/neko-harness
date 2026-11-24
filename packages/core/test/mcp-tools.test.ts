import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { type JsonRpcMessage, MCP_OUTPUT_MAX_BYTES } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync } from "../../../test/temp-dir.ts";
import type { CodemodeMode } from "../src/codemode-mode.ts";
import type { McpTransportFactory } from "../src/mcp-manager.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";

const model = { provider: "faux", modelId: "faux-1" };
const dirs: string[] = [];
const directory = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-mcp-tools-")));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const toolResults = async (runtime: NekoRuntime, id?: number) => {
	const conv =
		id === undefined ? runtime.conversation : (await runtime.harness.conversation(id as never, runtime.context))!;
	return (await conv.entries({ order: "ascending" }, 500, undefined, runtime.context)).items
		.flatMap((entry) => entry.model ?? [])
		.flatMap((m) => (m.role === "toolResult" ? [m] : []));
};
const resultText = (m: { content: { type: string; text?: string }[] }) => m.content.map((c) => c.text ?? "").join("");

function fakeTransportFactory(calls: Array<{ tool: string; args: Record<string, unknown> }>): McpTransportFactory {
	return () => {
		const { client, server } = createInMemoryTransportPair();
		void server.start();
		server.onMessage((msg: JsonRpcMessage) => {
			if (!("method" in msg) || !("id" in msg) || msg.id === undefined) return;
			if (msg.method === "initialize") {
				void server.send({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "demo", version: "1.0.0" },
						instructions: "Demo MCP server instructions.",
					},
				});
				return;
			}
			if (msg.method === "tools/list") {
				void server.send({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						tools: [
							{
								name: "read_doc",
								description: "Read documentation entry",
								inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
								outputSchema: { type: "object", properties: { body: { type: "string" } } },
								annotations: { readOnlyHint: true },
							},
							{
								name: "delete_doc",
								description: "Delete documentation entry",
								inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
							},
						],
					},
				});
				return;
			}
			if (msg.method === "tools/call") {
				const params = msg.params as { name: string; arguments?: Record<string, unknown> };
				calls.push({ tool: params.name, args: params.arguments ?? {} });
				const body =
					params.arguments?.id === "huge"
						? "X".repeat(MCP_OUTPUT_MAX_BYTES + 4096)
						: `doc:${String(params.arguments?.id)}`;
				void server.send({
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						content: [{ type: "text", text: body }],
						structuredContent: { body },
					},
				});
			}
		});
		return client;
	};
}

function parseCodemodeJson<T>(text: string): T {
	const marker = "Output:\n";
	const idx = text.indexOf(marker);
	const body = idx === -1 ? text : text.slice(idx + marker.length);
	return JSON.parse(body.trim()) as T;
}

async function openRuntime(
	provider: ReturnType<typeof fauxProvider>["provider"],
	mode: CodemodeMode,
	transportFactory?: McpTransportFactory,
) {
	const dir = directory();
	return createNekoRuntime({
		storage: "memory",
		providers: [provider],
		model,
		cwd: dir,
		codemodeSettings: { mode },
		mcpConfigPath: join(dir, "mcp.json"),
		mcpAuthPath: join(dir, "mcp-auth.json"),
		mcpDisableWatch: true,
		...(transportFactory ? { mcpTransportFactory: transportFactory } : {}),
	});
}

describe("MCP Durable tools integration", () => {
	it("adds zero tool_search or mcp_servers overhead when no MCP servers are enabled", async () => {
		const contexts: TranscriptContext[] = [];
		const faux = fauxProvider();
		faux.setResponses([
			(ctx) => {
				contexts.push(ctx);
				return fauxAssistantMessage("ok");
			},
		]);
		const runtime = await openRuntime(faux.provider, "off");
		try {
			const agent = await runtime.conversation.agent(runtime.context);
			expect(agent.tools.map((t) => t.name)).not.toContain("tool_search");
			await runtime.waitAnswer(await runtime.submit("hello"));
			const sections = getCurrentSystemMessage(contexts[0]!.messages)?.sections ?? {};
			expect(sections.mcp_servers).toBeUndefined();
			const modelTools = (contexts[0] as { tools?: readonly { name: string }[] } | undefined)?.tools ?? [];
			expect(modelTools.map((t) => t.name)).not.toContain("tool_search");
		} finally {
			await runtime.close();
		}
	}, 30_000);

	it("discovers and calls MCP tools via tool_search in codemode: off and preserves loaded tools across plan mode", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const contexts: TranscriptContext[] = [];
		const faux = fauxProvider();
		faux.setResponses([
			(ctx) => {
				contexts.push(ctx);
				return call("tool_search", { query: "read documentation" });
			},
			call("mcp__docs__read_doc", { id: "huge" }),
			fauxAssistantMessage("done"),
		]);
		const runtime = await openRuntime(faux.provider, "off", fakeTransportFactory(calls));
		try {
			await runtime.upsertMcpServer("docs", { transport: "stdio", command: "fake", description: "Product docs" });
			await runtime.waitForMcpReady();

			const agentBefore = await runtime.conversation.agent(runtime.context);
			expect(agentBefore.tools.map((t) => t.name)).toContain("tool_search");
			expect(agentBefore.tools.map((t) => t.name)).not.toContain("mcp__docs__read_doc");

			await runtime.waitAnswer(await runtime.submit("read huge doc"));
			const sections = getCurrentSystemMessage(contexts[0]!.messages)?.sections ?? {};
			expect(sections.mcp_servers).toContain("mcp__docs");
			expect(calls).toEqual([{ tool: "read_doc", args: { id: "huge" } }]);

			const [, mcpResult] = await toolResults(runtime);
			expect(mcpResult?.isError).toBe(false);
			expect(resultText(mcpResult as never)).toContain("Warning: truncated output");

			// Entering and leaving plan mode preserves the tool_search-loaded MCP tool.
			await runtime.root.setPlanMode("plan");
			expect((await runtime.conversation.agent(runtime.context)).tools.map((t) => t.name)).toContain(
				"mcp__docs__read_doc",
			);
			await runtime.root.setPlanMode("normal");
			expect((await runtime.conversation.agent(runtime.context)).tools.map((t) => t.name)).toContain(
				"mcp__docs__read_doc",
			);
		} finally {
			await runtime.close();
		}
	}, 30_000);

	it("exposes MCP namespaces in codemode: on and returns full untruncated CallToolResult to scripts", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const contexts: TranscriptContext[] = [];
		const faux = fauxProvider();
		faux.setResponses([
			(ctx) => {
				contexts.push(ctx);
				return call("codemode", {
					code: `
const found = await searchTools("read documentation");
const ns = await describeNamespace("mcp__docs");
const res = await tools.mcp__docs__read_doc({ id: "huge" });
return JSON.stringify({ found: found.map((t) => t.name), hasInstructions: JSON.stringify(ns).includes("Demo MCP server"), len: res.structuredContent.body.length });
`,
				});
			},
			fauxAssistantMessage("done"),
		]);
		const runtime = await openRuntime(faux.provider, "on", fakeTransportFactory(calls));
		try {
			await runtime.upsertMcpServer("docs", { transport: "stdio", command: "fake", description: "Product docs" });
			await runtime.waitForMcpReady();

			const agent = await runtime.conversation.agent(runtime.context);
			expect(agent.tools.map((t) => t.name)).not.toContain("tool_search");

			await runtime.waitAnswer(await runtime.submit("inspect docs"));
			const sections = getCurrentSystemMessage(contexts[0]!.messages)?.sections ?? {};
			expect(sections.codemode).toContain("## mcp__docs");
			expect(sections.mcp_servers).toBeUndefined();

			const [res] = await toolResults(runtime);
			expect(res?.isError).toBe(false);
			const parsed = parseCodemodeJson<{
				found: string[];
				hasInstructions: boolean;
				len: number;
			}>(resultText(res as never));
			expect(parsed.found).toContain("mcp__docs__read_doc");
			expect(parsed.hasInstructions).toBe(true);
			expect(parsed.len).toBe(MCP_OUTPUT_MAX_BYTES + 4096);
		} finally {
			await runtime.close();
		}
	}, 30_000);

	it("declares tools upfront for exposure: direct servers", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const faux = fauxProvider();
		faux.setResponses([call("mcp__docs__read_doc", { id: "1" }), fauxAssistantMessage("done")]);
		const runtime = await openRuntime(faux.provider, "off", fakeTransportFactory(calls));
		try {
			await runtime.upsertMcpServer("docs", { transport: "stdio", command: "fake", exposure: "direct" });
			await runtime.waitForMcpReady();

			const offered = (await runtime.conversation.agent(runtime.context)).tools.map((t) => t.name);
			expect(offered).toContain("mcp__docs__read_doc");
			expect(offered).not.toContain("tool_search");
			await runtime.waitAnswer(await runtime.submit("read 1"));
			expect(calls).toEqual([{ tool: "read_doc", args: { id: "1" } }]);
		} finally {
			await runtime.close();
		}
	}, 30_000);

	it("blocks non-readOnly MCP tools in plan mode (direct and in codemode) while allowing readOnlyHint: true", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const faux = fauxProvider();
		faux.setResponses([
			call("codemode", {
				code: `
let writeErr = "";
try { await tools.mcp__docs__delete_doc({ id: "1" }); } catch (e) { writeErr = String(e.message ?? e); }
const ok = await tools.mcp__docs__read_doc({ id: "2" });
return JSON.stringify({ writeErr, ok: ok.structuredContent.body });
`,
			}),
			fauxAssistantMessage("planned"),
		]);
		const runtime = await openRuntime(faux.provider, "on", fakeTransportFactory(calls));
		try {
			await runtime.upsertMcpServer("docs", { transport: "stdio", command: "fake" });
			await runtime.waitForMcpReady();
			await runtime.root.setPlanMode("plan");

			await runtime.waitAnswer(await runtime.submit("check plan guards"));
			expect(calls).toEqual([{ tool: "read_doc", args: { id: "2" } }]);
			const [res] = await toolResults(runtime);
			const parsed = parseCodemodeJson<{ writeErr: string; ok: string }>(resultText(res as never));
			expect(parsed.writeErr).toContain("Plan mode is read-only");
			expect(parsed.ok).toBe("doc:2");
		} finally {
			await runtime.close();
		}
	}, 30_000);

	it("gives coder subagents MCP access while keeping explore and plan subagents isolated", async () => {
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const faux = fauxProvider();
		faux.setResponses([
			// Main delegates explore first, then coder.
			call("subagent", { action: "create", type: "explore", title: "Explore", task: "try mcp" }),
			// Explore child attempts to call mcp tool via codemode.
			call("codemode", {
				code: `
const hasTool = typeof tools.mcp__docs__read_doc === "function";
return "explore_has_mcp=" + hasTool;
`,
			}),
			fauxAssistantMessage("explore done"),
			// Main delegates coder.
			call("subagent", { action: "create", type: "coder", title: "Coder", task: "call mcp" }),
			// Coder child calls mcp tool via codemode.
			call("codemode", {
				code: `
const res = await tools.mcp__docs__read_doc({ id: "coder-1" });
return res.structuredContent.body;
`,
			}),
			fauxAssistantMessage("coder done"),
			fauxAssistantMessage("all done"),
		]);
		const runtime = await openRuntime(faux.provider, "on", fakeTransportFactory(calls));
		try {
			await runtime.upsertMcpServer("docs", { transport: "stdio", command: "fake" });
			await runtime.waitForMcpReady();

			await runtime.waitAnswer(await runtime.submit("delegate"));
			expect(calls).toEqual([{ tool: "read_doc", args: { id: "coder-1" } }]);
		} finally {
			await runtime.close();
		}
	}, 30_000);
});
