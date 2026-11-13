import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import sharp from "sharp";
import { expect, it } from "vitest";
import { imagePrompt, prepareImage } from "../src/images.ts";

const models = createModels();
models.setProvider(deepseekProvider());
const flash = models.getModel("deepseek", "deepseek-flash")!;
it("decodes, resizes, preserves alpha and enforces declared capability", async () => {
	for (const format of ["png", "jpeg", "webp"] as const) {
		const input = await sharp({
			create: { width: 2400, height: 100, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } },
		})
			.toFormat(format)
			.toBuffer();
		const result = await prepareImage(input, `image/${format}`, "test", flash);
		expect(result.info.width).toBe(2000);
		expect(result.content.data.length).toBeLessThanOrEqual(4718592);
		if (format !== "jpeg")
			expect((await sharp(Buffer.from(result.content.data, "base64")).metadata()).hasAlpha).toBe(true);
		await expect(prepareImage(input, "image/gif", "test", flash)).rejects.toThrow("format");
		await expect(
			prepareImage(input, `image/${format}`, "test", models.getModel("deepseek", "deepseek-v4-pro")!),
		).rejects.toThrow("does not support");
	}
	await expect(prepareImage(new Uint8Array([1, 2, 3]), "image/png", "x", flash)).rejects.toThrow("decode");
	expect(imagePrompt([{ type: "image", data: "", mimeType: "image/png" }])).toBe("[Image message: 1]");
});

it("rejects animation and count/pixel/byte overflow before a model request", async () => {
	const { prepareInput, IMAGE_LIMITS } = await import("../src/images.ts");
	const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
		.png()
		.toBuffer();
	const image = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
	await expect(prepareInput(Array(5).fill(image), flash)).rejects.toThrow("At most");
	await expect(prepareImage(new Uint8Array(IMAGE_LIMITS.maxBytes + 1), "image/png", "large", flash)).rejects.toThrow(
		"20 MiB",
	);
	const animated = await sharp(Buffer.from([...Array(12).fill(0), ...Array(12).fill(255)]), {
		raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
	})
		.webp({ loop: 0, delay: [100, 100] })
		.toBuffer();
	await expect(prepareImage(animated, "image/webp", "animated", flash)).rejects.toThrow("static");
	const apng = Buffer.concat([
		bytes.subarray(0, 33),
		Buffer.from([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]),
		bytes.subarray(33),
	]);
	await expect(prepareImage(apng, "image/png", "apng", flash)).rejects.toThrow();
	const huge = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: "white" } })
		.png()
		.toBuffer();
	await expect(prepareImage(huge, "image/png", "huge", flash)).rejects.toThrow("40 megapixel");
});
