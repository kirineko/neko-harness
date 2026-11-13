import { expect, it } from "vitest";
import { IMAGE_CHUNK_BYTES, ImageUploads } from "../src/image-uploads.ts";

it("bounds staging, rejects partial and out-of-order chunks, expires and releases ownership", () => {
	const uploads = new ImageUploads();
	const original = Date.now;
	try {
		const begin = () => uploads.begin({ name: "x.png", mimeType: "image/png", size: IMAGE_CHUNK_BYTES + 1 });
		const a = begin(),
			b = begin();
		expect(() => begin()).toThrow("Too many");
		expect(() => uploads.finish(a)).toThrow("Incomplete");
		expect(() => uploads.append({ id: a, offset: 1, data: "YQ==" })).toThrow("order");
		uploads.append({ id: a, offset: 0, data: Buffer.alloc(IMAGE_CHUNK_BYTES).toString("base64") });
		uploads.append({ id: a, offset: IMAGE_CHUNK_BYTES, data: "YQ==" });
		uploads.finish(a);
		expect(uploads.resolve([a])[0]!.content.data.length).toBeGreaterThan(IMAGE_CHUNK_BYTES);
		expect(() => uploads.resolve([a, a])).toThrow("distinct");
		uploads.release(b);
		expect(() => uploads.finish(b)).toThrow("expired");
		const now = original();
		Date.now = () => now + 16 * 60000;
		expect(() => uploads.resolve([a])).toThrow("expired");
	} finally {
		Date.now = original;
		uploads.close();
	}
});
