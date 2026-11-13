import type { UserMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { addDefaultImagePrompt, DEFAULT_IMAGE_PROMPT, savedDefaultImagePrompt } from "../src/image-prompt.ts";

const image = { type: "image" as const, data: "", mimeType: "image/png" };
it("adds one prompt only to image inputs without meaningful user text, without mutating input", () => {
	for (const content of [
		[image],
		[image, image],
		[{ type: "text" as const, text: " \t\n" }, image, { type: "text" as const, text: "" }],
	]) {
		const before = structuredClone(content);
		const result = addDefaultImagePrompt(content);
		expect(result.content).toEqual([{ type: "text", text: DEFAULT_IMAGE_PROMPT.text }, ...before]);
		expect(result.defaultImagePrompt).toEqual(DEFAULT_IMAGE_PROMPT);
		expect(content).toEqual(before);
		expect(addDefaultImagePrompt(result.content).defaultImagePrompt).toBeUndefined();
	}
	for (const content of [
		"",
		"hello",
		[],
		[{ type: "text", text: " " }],
		[image, { type: "text", text: "explain" }],
		[{ type: "text", text: DEFAULT_IMAGE_PROMPT.text }, image],
	] satisfies UserMessage["content"][]) {
		expect(addDefaultImagePrompt(content)).toEqual({ content });
	}
});

it("validates persisted provenance independently of the current template", () => {
	const saved = { version: 2, text: "An older saved prompt" };
	const content: UserMessage["content"] = [{ type: "text", text: saved.text }, image];
	expect(savedDefaultImagePrompt(content, saved)).toEqual(saved);
	for (const invalid of [
		undefined,
		{},
		{ ...saved, version: 0 },
		{ ...saved, version: 1.5 },
		{ ...saved, text: "mismatch" },
	])
		expect(savedDefaultImagePrompt(content, invalid)).toBeUndefined();
	expect(savedDefaultImagePrompt([{ type: "text", text: saved.text }], saved)).toBeUndefined();
	expect(savedDefaultImagePrompt([...content, { type: "text", text: "user text" }], saved)).toBeUndefined();
});
