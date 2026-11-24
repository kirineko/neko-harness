import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type Agent,
	defineExtension,
	type Extension,
	section,
	type ToolExecutionApi,
	type ToolNamespace,
	type ToolRegistration,
	wrapSection,
	wrapTool,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { type McpOutputSaver, mcpNamespace, normalizeMcpInputSchema } from "@earendil-works/pi-mcp";
import { CODEMODE_NAME } from "./codemode-mode.ts";
import type { McpManager, OfferedMcpServer, OfferedMcpTool } from "./mcp-manager.ts";
import { createMcpResultSchema, formatMcpCallResult } from "./mcp-result.ts";
import { blockedMcpTool } from "./plan.ts";
import { PlanDoc } from "./plan-doc.ts";

export const MCP_EXTENSION_NAME = "neko-mcp";
export const TOOL_SEARCH_EXTENSION_NAME = "tool-search";

/**
 * Install `tool_search` only when at least one deferred MCP server is enabled.
 * When empty, the extension carries no tools so zero-MCP sessions pay zero overhead.
 */
export function createMcpToolSearchExtension(hasDeferredMcp: boolean): Extension {
	return hasDeferredMcp ? createToolSearchExtension() : defineExtension({ name: TOOL_SEARCH_EXTENSION_NAME });
}

function outputSaver(api: ToolExecutionApi, context: Context): McpOutputSaver | undefined {
	const env = api.env;
	if (!env) return undefined;
	return async (data, extension) => {
		const dir = await env.createTempDir("neko-mcp-", context);
		if (!dir.ok) throw new Error(dir.error.message);
		const filePath = `${dir.value}/output${extension}`;
		const written = await env.writeFile(filePath, data, context);
		if (!written.ok) throw new Error(written.error.message);
		return filePath;
	};
}

function namespaceOf(server: OfferedMcpServer): ToolNamespace {
	const toolsHint = `Tools of the MCP server "${server.name}" (find them with searchTools()).`;
	const signInHint = server.oauthSupported
		? " It uses OAuth: if it has no tools, ask the user to sign in from Web /settings/mcp or TUI /mcp."
		: "";
	return {
		name: mcpNamespace(server.name),
		description: server.summary ? `${server.summary}\n${toolsHint}${signInHint}` : `${toolsHint}${signInHint}`,
		...(server.instructions !== undefined ? { instructions: server.instructions } : {}),
	};
}

function withAgent(api: ToolExecutionApi, agent: ToolExecutionApi["agent"]): ToolExecutionApi {
	const descriptors = { ...Object.getOwnPropertyDescriptors(api), agent: { value: agent, enumerable: true } };
	return Object.defineProperties({}, descriptors) as ToolExecutionApi;
}

function expandMcpNamespaces(agent: Agent, offered: readonly OfferedMcpServer[]): Agent {
	return {
		...agent,
		extensions: agent.extensions.flatMap((extension) => {
			if (extension.name !== MCP_EXTENSION_NAME) return [extension];
			return offered.map((server) => {
				const toolNames = new Set(server.tools.map((t) => t.registeredName));
				return {
					name: `mcp:${server.name}`,
					namespace: namespaceOf(server),
					tools: agent.callable.filter((tool) => toolNames.has(tool.name)),
				};
			});
		}),
	};
}

function createToolRegistration(manager: McpManager, server: OfferedMcpServer, item: OfferedMcpTool): ToolRegistration {
	const title = item.tool.title ?? item.tool.annotations?.title;
	return {
		name: item.registeredName,
		description: item.tool.description?.trim() || title || `MCP tool ${item.tool.name} from server ${server.name}`,
		parameters: normalizeMcpInputSchema(item.tool.inputSchema),
		...(server.exposure === "direct" ? {} : { deferred: true as const }),
		replay: "unsafe",
		structuredOutputSchema: createMcpResultSchema(item.tool.outputSchema),
		async execute(args, api, context) {
			if ((await api.snapshot(PlanDoc, api.conversationId, context))?.mode === "plan" && !item.readOnly) {
				throw new Error(blockedMcpTool(item.registeredName));
			}
			const result = await manager.callTool(server.name, item.tool.name, args as Record<string, unknown>, {
				...(context.abortSignal ? { signal: context.abortSignal } : {}),
			});
			const formatted = await formatMcpCallResult(server.name, item.tool.name, result, outputSaver(api, context));
			return {
				output: formatted.output,
				isError: formatted.isError,
				details: {
					server: server.name,
					tool: item.tool.name,
					...(formatted.fullOutputPath ? { fullOutputPath: formatted.fullOutputPath } : {}),
				},
				structuredOutput: formatted.structuredOutput as JsonValue,
			};
		},
	};
}

/**
 * Single hot-swappable Durable extension (`neko-mcp`) exposing all enabled global MCP servers:
 * - Tools named `mcp__<server>__<tool>` (deferred by default, or direct when `exposure: "direct"`).
 * - Virtual per-server namespaces injected into `codemode` via `wrapSection` and `wrapTool`.
 * - `mcp_servers` prompt section rendered only when `codemode` is off and deferred servers exist.
 */
export function createMcpExtension(manager: McpManager): Extension {
	const offered = manager.offeredServers();
	if (offered.length === 0) return defineExtension({ name: MCP_EXTENSION_NAME });

	const tools: ToolRegistration[] = offered.flatMap((server) =>
		server.tools.map((item) => createToolRegistration(manager, server, item)),
	);

	const deferredServers = offered.filter((server) => server.exposure !== "direct");
	const serversSection = section("mcp_servers", (input) => {
		if (deferredServers.length === 0) return undefined;
		if (input.agent.extensions.some((ext) => ext.name === CODEMODE_NAME)) return undefined;
		const lines = deferredServers.map((server) => {
			const head = `- ${mcpNamespace(server.name)} (tool_search)`;
			const signIn = server.status === "auth_required" ? " [sign-in required: Web /settings/mcp or TUI /mcp]" : "";
			return server.summary ? `${head}: ${server.summary}${signIn}` : `${head}${signIn}`;
		});
		return [
			"MCP servers whose tools are not declared upfront. Use `tool_search` to load matching tools before calling them.",
			...lines,
		].join("\n");
	});

	const codemodeToolRef = { name: CODEMODE_TOOL_NAME } as ToolRegistration;

	return defineExtension({
		name: MCP_EXTENSION_NAME,
		tools,
		sections: [serversSection],
		wraps: [
			wrapSection("codemode", (base) => ({
				...base,
				render: (input, context) =>
					base.render({ ...input, agent: expandMcpNamespaces(input.agent, offered) }, context),
			})),
			wrapTool(codemodeToolRef, (base) => ({
				...base,
				execute: (args, api, context) =>
					base.execute(
						args,
						withAgent(api, async (inner) => expandMcpNamespaces(await api.agent(inner), offered)),
						context,
					),
			})),
		],
	});
}
