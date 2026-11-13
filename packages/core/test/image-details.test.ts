import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HookApi, ToolHooks } from "@earendil-works/pi-durable";
import sharp from "sharp";
import { expect, it } from "vitest";
import { ImageDetails } from "../src/image-metadata.ts";

it("adds actual output metadata while preserving all upstream result channels", async () => {
	const data = (
		await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } })
			.png()
			.toBuffer()
	).toString("base64");
	const output = [{ type: "image" as const, data, mimeType: "image/png" }];
	const details = { truncation: { truncated: false }, custom: "upstream" };
	const diagnostics = [{ severity: "info" as const, code: "fixture", message: "original diagnostic" }];
	const structuredOutput = { answer: "for programs" };
	const result = await (ImageDetails.hooks![0]!.handlers as Pick<ToolHooks, "afterTool">).afterTool(
		{ type: "toolCall", id: "call", name: "read", arguments: { path: "original.bmp" } },
		{ output, details, diagnostics, structuredOutput },
		{} as HookApi,
		BACKGROUND_CONTEXT,
	);
	if (!result) throw new Error("Hook did not enrich read output");
	expect(result?.output).toBe(output);
	expect(result?.diagnostics).toBe(diagnostics);
	expect(result?.structuredOutput).toBe(structuredOutput);
	expect(result?.details).toMatchObject({
		...details,
		neko: {
			images: [
				{
					contentIndex: 0,
					name: "original.bmp",
					mimeType: "image/png",
					width: 4,
					height: 3,
					bytes: Buffer.from(data, "base64").length,
				},
			],
		},
	});
});
