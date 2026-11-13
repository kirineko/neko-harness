import type { ChatImage, ChatItem } from "@neko-harness/core";
import { describe, expect, it } from "vitest";
import { buildSessionExport, ExportCancelledError, exportNotice } from "../src/client/lib/session-export.ts";

const image: ChatImage = {
	entryId: 1,
	contentIndex: 0,
	name: "a.png",
	mimeType: "image/png",
	width: 1,
	height: 1,
	bytes: 3,
};
const items: ChatItem[] = [
	{ type: "user", key: "u1", id: 1, text: "hello", images: [image] },
	{ type: "assistant", key: "a1", text: "hi there", thinking: "secret plan", note: null, order: 1 } as ChatItem,
];
const snapshot = { sessionId: "s1", title: "My: chat", model: "m", cwd: "/w", items };
const now = new Date(2026, 9, 14, 18, 30, 5);

describe("buildSessionExport", () => {
	it("names the file from the snapshot title and export time", async () => {
		const result = await buildSessionExport({
			format: "markdown",
			includeThinking: false,
			snapshot,
			currentSessionId: () => "s1",
			readImage: async () => ({ name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) }),
			now,
		});
		expect(result.fileName).toBe("My- chat-20261014-183005.md");
		expect(result.content).toContain("hi there");
		expect(result.content).not.toContain("secret plan");
	});

	it("includes thinking only when asked", async () => {
		const result = await buildSessionExport({
			format: "json",
			includeThinking: true,
			snapshot,
			currentSessionId: () => "s1",
			readImage: async () => {
				throw new Error("unused");
			},
			now,
		});
		expect(result.content).toContain("secret plan");
	});

	it("embeds images read for the snapshot session", async () => {
		const seen: string[] = [];
		const result = await buildSessionExport({
			format: "html",
			includeThinking: false,
			snapshot,
			currentSessionId: () => "s1",
			readImage: async (_image, sessionId) => {
				seen.push(sessionId);
				return { name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
			},
			now,
		});
		expect(seen).toEqual(["s1"]);
		expect(result.content).toContain("data:image/png;base64,AQID");
		expect(result.skippedImages).toBe(0);
	});

	it("cancels instead of exporting placeholders when the session changes mid-export", async () => {
		let reads = 0;
		await expect(
			buildSessionExport({
				format: "html",
				includeThinking: false,
				snapshot,
				currentSessionId: () => "s2",
				readImage: async () => {
					reads++;
					return { name: "a.png", mimeType: "image/png", bytes: new Uint8Array([1]) };
				},
				now,
			}),
		).rejects.toBeInstanceOf(ExportCancelledError);
		expect(reads).toBe(0);
	});

	it("rejects an empty transcript", async () => {
		await expect(
			buildSessionExport({
				format: "markdown",
				includeThinking: false,
				snapshot: { ...snapshot, items: [] },
				currentSessionId: () => "s1",
				readImage: async () => {
					throw new Error("unused");
				},
			}),
		).rejects.toThrow();
	});
});

describe("exportNotice", () => {
	it("reports the file name and skipped images", () => {
		expect(exportNotice({ fileName: "a.html", skippedImages: 0 })).toBe("已导出 a.html");
		expect(exportNotice({ fileName: "a.html", skippedImages: 2 })).toBe("已导出 a.html，2 张图片未能内嵌");
	});
});
