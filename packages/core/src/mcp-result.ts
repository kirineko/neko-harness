/**
 * Thin compatibility helpers matching `@earendil-works/pi-mcp`'s post-1.6.0 `createMcpResultSchema`
 * and `toMcpModelContent`, built directly on top of `@earendil-works/pi-mcp@1.6.0`'s `toLlmContent`
 * and `limitMcpContent`. Can be replaced with upstream imports when upgrading Pi beyond 1.6.0.
 */

import {
	type CallToolResult,
	type ContentBlock,
	type LlmContent,
	limitMcpContent,
	type McpOutputSaver,
	toLlmContent,
} from "@earendil-works/pi-mcp";

const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};

const SCHEMA_DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "examples"]);

const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

/**
 * Output schema of an MCP tool for programmatic callers (codemode scripts): the whole
 * `CallToolResult` (without `_meta`), with the tool's own `outputSchema` as `structuredContent`.
 */
export function createMcpResultSchema(
	structuredContentSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			structuredContent: structuredContentSchema
				? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
				: {},
			isError: { type: "boolean" },
		},
		required: ["content"],
		additionalProperties: true,
	};
}

function relocateSchema(schema: unknown, pointer: string): unknown {
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
	if (typeof schema !== "object" || schema === null) return schema;
	const relocated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
			relocated[key] = `${pointer}${value.slice(1)}`;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			relocated[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			relocated[key] = Object.fromEntries(
				Object.entries(value).map(([name, subschema]) => [name, relocateSchema(subschema, pointer)]),
			);
		} else {
			relocated[key] = relocateSchema(value, pointer);
		}
	}
	return relocated;
}

export interface McpModelContentOptions {
	saveOutput?: McpOutputSaver;
}

/**
 * Convert an MCP tool result into model-facing content: text and images pass through, text blobs
 * become text, non-image binary blobs are saved via `saveOutput` when provided, and resource links
 * become descriptive text placeholders.
 */
export async function toMcpModelContent(
	_server: string,
	result: Pick<CallToolResult, "content" | "structuredContent">,
	options: McpModelContentOptions = {},
): Promise<LlmContent[]> {
	if (result.content.length === 0) return toLlmContent(result);
	return (await Promise.all(result.content.map((block) => blockToContent(block, options)))).flat();
}

async function blockToContent(block: ContentBlock, options: McpModelContentOptions): Promise<LlmContent[]> {
	if (block.type === "resource_link") {
		const details = [block.mimeType, block.size === undefined ? undefined : formatSize(block.size)].filter(Boolean);
		const description = block.description ? `: ${block.description}` : "";
		return [
			{
				type: "text",
				text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length > 0 ? ` (${details.join(", ")})` : ""}${description}]`,
			},
		];
	}
	if (block.type === "resource" && "blob" in block.resource && !block.resource.mimeType?.startsWith("image/")) {
		const { uri, mimeType, blob } = block.resource;
		const data = Buffer.from(blob, "base64");
		if (isTextMimeType(mimeType)) return [{ type: "text", text: data.toString("utf8") }];
		if (!options.saveOutput) return toLlmContent({ content: [block] });
		const kind = `${mimeType ?? "unknown type"}, ${formatSize(data.length)}`;
		try {
			const path = await options.saveOutput(data, extensionOf(uri));
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return [{ type: "text", text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` }];
		}
	}
	return toLlmContent({ content: [block] });
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const type = (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
	return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml");
}

function extensionOf(uri: string): string {
	const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
	return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? ".bin";
}

/**
 * Produce both the bounded model-facing content (20KB middle truncation + optional full-text spill)
 * and the untruncated structured output for programmatic callers (without `_meta`).
 */
export async function formatMcpCallResult(
	server: string,
	toolName: string,
	result: CallToolResult,
	saveOutput?: McpOutputSaver,
): Promise<{
	output: LlmContent[];
	fullOutputPath?: string;
	structuredOutput: Record<string, unknown>;
	isError: boolean;
}> {
	const content = await toMcpModelContent(server, result, saveOutput ? { saveOutput } : {});
	if (result.isError && !content.some((block) => block.type === "text" && block.text.trim() !== "")) {
		content.push({ type: "text", text: `MCP tool ${server}/${toolName} returned an error` });
	}
	const limited = await limitMcpContent(content, saveOutput);
	const { _meta: _dropped, ...whole } = result;
	return {
		output: limited.content,
		...(limited.fullOutputPath ? { fullOutputPath: limited.fullOutputPath } : {}),
		structuredOutput: whole as Record<string, unknown>,
		isError: result.isError === true,
	};
}
