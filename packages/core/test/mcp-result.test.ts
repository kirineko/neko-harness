import type { CallToolResult } from "@earendil-works/pi-mcp";
import { MCP_OUTPUT_MAX_BYTES } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";
import { createMcpResultSchema, formatMcpCallResult, toMcpModelContent } from "../src/mcp-result.ts";
import {
	containsEnvTemplate,
	isMcpExposure,
	isMcpServerName,
	isPureEnvTemplate,
	isSensitiveFieldKey,
	maskSecretValue,
	parseMcpToolName,
} from "../src/mcp-types.ts";

describe("mcp-types helpers", () => {
	it("validates names, exposures and parses mcp tool names", () => {
		expect(isMcpExposure("auto")).toBe(true);
		expect(isMcpExposure("direct")).toBe(true);
		expect(isMcpExposure("hidden")).toBe(false);
		expect(isMcpServerName("github_1-dev")).toBe(true);
		expect(isMcpServerName("bad name")).toBe(false);
		expect(parseMcpToolName("mcp__github__list_issues")).toEqual({ server: "github", tool: "list_issues" });
		expect(parseMcpToolName("mcp__my_srv__a__b")).toEqual({ server: "my_srv", tool: "a__b" });
		expect(parseMcpToolName("read")).toBeNull();
	});

	it("handles env templates and secret masking", () => {
		expect(containsEnvTemplate("Bearer ${API_TOKEN}")).toBe(true);
		expect(isPureEnvTemplate("Bearer ${API_TOKEN}")).toBe(true);
		expect(isPureEnvTemplate("${TOKEN}")).toBe(true);
		expect(isPureEnvTemplate("sk-live-123")).toBe(false);
		expect(maskSecretValue("${TOKEN}")).toBe("${TOKEN}");
		expect(maskSecretValue("Bearer ${TOKEN}")).toBe("Bearer ${TOKEN}");
		expect(maskSecretValue("sk-live-123")).toBe("••••••••");
		expect(isSensitiveFieldKey("Authorization")).toBe(true);
		expect(isSensitiveFieldKey("DEBUG")).toBe(false);
	});
});

describe("createMcpResultSchema", () => {
	it("wraps CallToolResult and relocates local $refs under structuredContent", () => {
		const schema = createMcpResultSchema({
			type: "object",
			$defs: {
				Item: { type: "object", properties: { id: { type: "string" } } },
			},
			properties: {
				items: { type: "array", items: { $ref: "#/$defs/Item" } },
				self: { $ref: "#" },
				example: { examples: [{ $ref: "#/ignored" }] },
			},
		});
		const props = schema.properties as Record<string, unknown>;
		const structured = props.structuredContent as Record<string, unknown>;
		const nestedProps = structured.properties as Record<string, Record<string, unknown>>;
		expect((nestedProps.items?.items as Record<string, unknown>)?.$ref).toBe(
			"#/properties/structuredContent/$defs/Item",
		);
		expect(nestedProps.self?.$ref).toBe("#/properties/structuredContent");
		expect(nestedProps.example?.examples).toEqual([{ $ref: "#/ignored" }]);
	});

	it("defaults structuredContent to open object when tool has no outputSchema", () => {
		const schema = createMcpResultSchema(undefined);
		expect((schema.properties as Record<string, unknown>).structuredContent).toEqual({});
	});
});

describe("toMcpModelContent and formatMcpCallResult", () => {
	it("converts text, images, text blobs, binary blobs and resource links", async () => {
		const saved: Array<{ data: string | Uint8Array; ext: string }> = [];
		const saveOutput = async (data: string | Uint8Array, ext: string) => {
			saved.push({ data, ext });
			return `/tmp/saved-${saved.length}${ext}`;
		};

		const content = await toMcpModelContent(
			"docs",
			{
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: "YWJj", mimeType: "image/png" },
					{
						type: "resource",
						resource: {
							uri: "file:///a.json",
							mimeType: "application/json",
							blob: Buffer.from('{"ok":true}').toString("base64"),
						},
					},
					{
						type: "resource",
						resource: {
							uri: "https://example.com/report.pdf",
							mimeType: "application/pdf",
							blob: Buffer.from([1, 2, 3, 4]).toString("base64"),
						},
					},
					{
						type: "resource_link",
						uri: "docs://guide",
						name: "guide",
						title: "User Guide",
						mimeType: "text/markdown",
						size: 2048,
						description: "Overview",
					},
				],
			},
			{ saveOutput },
		);

		expect(content[0]).toEqual({ type: "text", text: "hello" });
		expect(content[1]).toEqual({ type: "image", data: "YWJj", mimeType: "image/png" });
		expect(content[2]).toEqual({ type: "text", text: '{"ok":true}' });
		expect(content[3]).toEqual({
			type: "text",
			text: "[Binary resource https://example.com/report.pdf (application/pdf, 4B) saved to /tmp/saved-1.pdf]",
		});
		expect(content[4]).toEqual({
			type: "text",
			text: '[Resource docs://guide "User Guide" (text/markdown, 2.0KB): Overview]',
		});
		expect(saved).toHaveLength(1);
		expect(saved[0]?.ext).toBe(".pdf");
	});

	it("truncates large text for the model while keeping full structuredOutput without _meta", async () => {
		const huge = "A".repeat(MCP_OUTPUT_MAX_BYTES + 10_000);
		let spilledText = "";
		const raw: CallToolResult = {
			content: [{ type: "text", text: huge }],
			structuredContent: { count: 42 },
			isError: false,
			_meta: { traceId: "hidden" },
		};

		const formatted = await formatMcpCallResult("srv", "big", raw, async (data, ext) => {
			spilledText = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
			return `/tmp/full${ext}`;
		});

		expect(formatted.fullOutputPath).toBe("/tmp/full.txt");
		expect(spilledText).toBe(huge);
		expect(formatted.output[0]?.type).toBe("text");
		const text = formatted.output[0]?.type === "text" ? formatted.output[0].text : "";
		expect(text).toContain("Warning: truncated output");
		expect(text).toContain("/tmp/full.txt");
		expect(formatted.structuredOutput).toEqual({
			content: [{ type: "text", text: huge }],
			structuredContent: { count: 42 },
			isError: false,
		});
		expect("_meta" in formatted.structuredOutput).toBe(false);
	});

	it("adds fallback error text when isError is true and text content is empty", async () => {
		const formatted = await formatMcpCallResult("srv", "fail", { content: [], isError: true });
		expect(formatted.isError).toBe(true);
		expect(formatted.output).toEqual([{ type: "text", text: "MCP tool srv/fail returned an error" }]);
	});
});
