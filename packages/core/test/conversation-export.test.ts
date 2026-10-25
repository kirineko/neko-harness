import { expect, it } from "bun:test";
import {
	copyText,
	EXPORT_EXTENSIONS,
	exportConversation,
	exportFileName,
	exportFormatFromPath,
	lastAnswerText,
	MAX_EMBEDDED_IMAGE_BYTES,
} from "../src/conversation-export.ts";
import type { ChatImage, ChatItem } from "../src/projection.ts";

let counter = 0;
const key = () => `e${++counter}`;
const user = (text: string, extra: Partial<Extract<ChatItem, { type: "user" }>> = {}): ChatItem => ({
	type: "user",
	key: key(),
	id: counter,
	text,
	...extra,
});
const assistant = (text: string, thinking = "", note: string | null = null): ChatItem => ({
	type: "assistant",
	key: key(),
	id: counter,
	thinking,
	text,
	stopReason: "stop",
	errorMessage: null,
	note,
});
const tool = (extra: Partial<Extract<ChatItem, { type: "tool" }>> = {}): ChatItem => ({
	type: "tool",
	key: key(),
	callId: `c${counter}`,
	name: "bash",
	summary: "ls",
	detail: null,
	phase: "done",
	isError: false,
	output: null,
	result: "ok",
	durationMs: 1500,
	note: null,
	diff: null,
	diffAdded: null,
	diffRemoved: null,
	...extra,
});
const image = (entryId: number, bytes: number, extra: Partial<ChatImage> = {}): ChatImage => ({
	entryId,
	contentIndex: 0,
	name: `img${entryId}.png`,
	mimeType: "image/png",
	width: 4,
	height: 2,
	bytes,
	...extra,
});
const source = (items: ChatItem[]) => ({
	sessionId: "1",
	title: "Demo session",
	model: "deepseek/chat",
	cwd: "/work/demo",
	exportedAt: new Date("2026-10-14T08:00:00.000Z"),
	items,
});

it("copies user input and assistant bodies only, restoring skill invocations", () => {
	expect(copyText(assistant("  answer\n", "private reasoning"))).toBe("answer");
	expect(
		copyText(user("/skill:pdf", { skill: { name: "pdf", location: "x", body: "<skill>BODY</skill>", args: "" } })),
	).toBe("/skill:pdf");
	expect(
		copyText(user("<skill>BODY</skill>", { skill: { name: "pdf", location: "x", body: "BODY", args: "merge a b" } })),
	).toBe("/skill:pdf merge a b");
	expect(copyText(user("", { defaultImagePrompt: { version: 1, text: "Describe the image" } }))).toBe("");
	expect(copyText(tool())).toBe("");
});

it("finds the last answer with a body, skipping tool-only and empty assistants", () => {
	expect(lastAnswerText([user("hi"), assistant("first"), tool(), assistant("  ", "thinking only")])).toBe("first");
	expect(lastAnswerText([user("hi")])).toBeNull();
	expect(lastAnswerText([])).toBeNull();
});

it("builds safe default file names and detects formats by extension", () => {
	const at = new Date(2026, 9, 14, 8, 5, 9);
	expect(exportFileName('修复 a/b:c?"', "markdown", at)).toBe("修复 a-b-c-20261014-080509.md");
	expect(exportFileName("", "json", at)).toBe("neko-session-20261014-080509.json");
	expect(exportFileName("\u0000 ..", "html", at)).toBe("neko-session-20261014-080509.html");
	const long = exportFileName("长".repeat(200), "markdown", at);
	expect(Array.from(long).length).toBe(60 + "-20261014-080509.md".length);
	expect(exportFormatFromPath("out/Chat.MD")).toBe("markdown");
	expect(exportFormatFromPath("a.html")).toBe("html");
	expect(exportFormatFromPath("a.json")).toBe("json");
	expect(exportFormatFromPath("a.txt")).toBeNull();
	expect(exportFormatFromPath("md")).toBeNull();
	expect(EXPORT_EXTENSIONS.markdown).toBe("md");
});

it("refuses to export an empty transcript", async () => {
	await expect(exportConversation("markdown", source([]), { includeThinking: false })).rejects.toThrow(
		"Nothing to export",
	);
});

it("exports Markdown without thinking by default and with it on request", async () => {
	const items = [
		user("question"),
		assistant("the answer", "secret chain of thought", "Stopped."),
		tool({ detail: "cmd: ls", result: "file\n```js\ncode\n```\n", isError: true }),
		tool({ phase: "running", result: null, output: "partial" }),
		{ type: "system", key: key(), id: counter, text: "[context compacted]" } as ChatItem,
	];
	const plain = await exportConversation("markdown", source(items), { includeThinking: false });
	expect(plain.extension).toBe("md");
	expect(plain.content).toContain("# Demo session");
	expect(plain.content).toContain("- **Exported:** 2026-10-14T08:00:00.000Z");
	expect(plain.content).toContain("## User\n\nquestion");
	expect(plain.content).toContain("the answer");
	expect(plain.content).not.toContain("secret chain of thought");
	expect(plain.content).toContain("[error]");
	expect(plain.content).toContain("Output so far:");
	expect(plain.content).toContain("*[context compacted]*");
	// The result contains a ``` fence, so the wrapping fence must be longer.
	expect(plain.content).toContain("````\nfile\n```js\ncode\n```\n\n````");

	const withThinking = await exportConversation("markdown", source(items), { includeThinking: true });
	expect(withThinking.content).toContain("<summary>Thinking</summary>");
	expect(withThinking.content.indexOf("secret chain of thought")).toBeLessThan(
		withThinking.content.indexOf("the answer"),
	);
});

it("describes images in Markdown and JSON without embedding bytes", async () => {
	const items = [user("look", { images: [image(1, 2048)] }), tool({ images: [image(2, 10)] })];
	const markdown = await exportConversation("markdown", source(items), { includeThinking: false });
	expect(markdown.content).toContain("> [image] img1.png · image/png · 4×2");
	const json = JSON.parse((await exportConversation("json", source(items), { includeThinking: false })).content);
	expect(json.items[0].images).toEqual([{ name: "img1.png", mimeType: "image/png", width: 4, height: 2, bytes: 2048 }]);
	expect(JSON.stringify(json)).not.toContain("base64");
});

it("round-trips JSON with exact text, order and a version", async () => {
	const text = 'line1\n"quoted" </script> \u2028 `tick`';
	const items = [user(text), assistant("A", "T"), tool({ result: text })];
	const result = await exportConversation("json", source(items), { includeThinking: false });
	expect(result.mimeType).toContain("application/json");
	const doc = JSON.parse(result.content);
	expect(doc).toMatchObject({
		format: "neko-conversation",
		version: 1,
		session: { id: "1", title: "Demo session", exportedAt: "2026-10-14T08:00:00.000Z" },
	});
	expect(doc.items.map((item: { type: string }) => item.type)).toEqual(["user", "assistant", "tool"]);
	expect(doc.items[0].text).toBe(text);
	expect(doc.items[1].thinking).toBeUndefined();
	expect(doc.items[2].result).toBe(text);
	const withThinking = JSON.parse((await exportConversation("json", source(items), { includeThinking: true })).content);
	expect(withThinking.items[1].thinking).toBe("T");
});

it("never lets model or user content execute in the HTML export", async () => {
	const hostile = [
		"<script>alert(1)</script>",
		"<img src=x onerror=alert(2)>",
		"[bad](javascript:alert(3))",
		"[data](data:text/html,<b>x</b>)",
		"![pixel](http://tracker.invalid/p.png)",
		"[good](https://example.com/a?b=1&c=2)",
		"```html\n<script>alert(4)</script>\n```",
	].join("\n\n");
	const items = [
		user("<script>alert(5)</script>"),
		assistant(hostile, "<b onclick=alert(6)>thought</b>"),
		tool({ summary: "<i>x</i>", detail: "<script>alert(7)</script>", result: "<script>alert(8)</script>" }),
	];
	const { content } = await exportConversation("html", source(items), { includeThinking: true });
	expect(content).not.toContain("<script");
	expect(content).not.toContain("<img src=x");
	expect(content).not.toContain("onerror=alert(2)>");
	expect(content).not.toContain("javascript:");
	expect(content).not.toContain("data:text/html");
	expect(content).not.toContain("<b onclick");
	expect(content).not.toContain("<i>x</i>");
	expect(content).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	expect(content).toContain('href="https://example.com/a?b=1&amp;c=2"');
	expect(content).toContain("[image: pixel]");
	expect(content).not.toContain("<img");
	expect(content).toContain("Content-Security-Policy");
	expect(content).toContain("default-src 'none'");
});

it("renders Markdown answers and keeps thinking opt-in in HTML", async () => {
	const items = [assistant("**bold** and `code`", "hidden thought")];
	const plain = await exportConversation("html", source(items), { includeThinking: false });
	expect(plain.content).toContain("<strong>bold</strong>");
	expect(plain.content).toContain("<code>code</code>");
	expect(plain.content).not.toContain("hidden thought");
	const withThinking = await exportConversation("html", source(items), { includeThinking: true });
	expect(withThinking.content).toContain("hidden thought");
});

it("embeds readable images within budget and replaces the rest with placeholders", async () => {
	const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7]);
	const calls: number[] = [];
	const items = [
		user("pics", {
			images: [
				image(1, bytes.length),
				image(2, MAX_EMBEDDED_IMAGE_BYTES + 1),
				image(3, 5),
				image(4, 5, { mimeType: "image/svg+xml" }),
			],
		}),
	];
	// Descriptors share entryId/contentIndex keys only when both match, so give each a distinct content index.
	const fixed = items.map((item) =>
		item.type === "user"
			? { ...item, images: item.images?.map((img, index) => ({ ...img, contentIndex: index })) }
			: item,
	) as ChatItem[];
	const result = await exportConversation("html", source(fixed), {
		includeThinking: false,
		async loadImage(img) {
			calls.push(img.entryId);
			if (img.entryId === 3) throw new Error("gone");
			return { name: img.name, mimeType: img.mimeType, bytes };
		},
	});
	expect(calls).toEqual([1, 3, 4]);
	expect(result.skippedImages).toBe(3);
	expect(result.content).toContain(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
	expect(result.content).toContain("over the embedding size limit");
	expect(result.content).toContain("image unavailable");
	expect(result.content).toContain("unsupported image type");
	expect(result.content).not.toContain("svg+xml;base64");
});

it("stops embedding once the running total would exceed the budget", async () => {
	const half = new Uint8Array(MAX_EMBEDDED_IMAGE_BYTES / 2 + 1);
	const items = [user("a", { images: [image(1, half.length)] }), user("b", { images: [image(2, half.length)] })];
	let loads = 0;
	const result = await exportConversation("html", source(items), {
		includeThinking: false,
		async loadImage(img) {
			loads++;
			return { name: img.name, mimeType: "image/png", bytes: half };
		},
	});
	expect(loads).toBe(1);
	expect(result.skippedImages).toBe(1);
});

it("treats every image as a placeholder when no loader is provided", async () => {
	const result = await exportConversation("html", source([user("x", { images: [image(1, 5)] })]), {
		includeThinking: false,
	});
	expect(result.skippedImages).toBe(1);
	expect(result.content).toContain("[image: img1.png · image/png · 4×2 — not embedded]");
});

const script = (extra: Partial<Extract<ChatItem, { type: "tool" }>> = {}) =>
	tool({
		name: "codemode",
		summary: "const a = await tools.read()",
		detail: "const a = await tools.read({ path: 'a' });\ntext(a);",
		result: "Script completed\nOutput:\nhello",
		codemode: {
			calls: [
				{ id: 1, name: "read", args: '{"path":"a"}', status: "ok", durationMs: 12, error: null },
				{ id: 2, name: "edit", args: '{"path":"<b>"}', status: "error", durationMs: null, error: "no match" },
			],
			omitted: 3,
			fullOutputPath: "/tmp/full.txt",
		},
		...extra,
	});

it("exports a codemode call as a script block, a call list and its output", async () => {
	const markdown = (await exportConversation("markdown", source([user("go"), script()]), { includeThinking: false }))
		.content;
	expect(markdown).toContain("```javascript\nconst a = await tools.read({ path: 'a' });\ntext(a);\n```");
	expect(markdown).toContain('read {"path":"a"} · ok · 12ms');
	expect(markdown).toContain('edit {"path":"<b>"} · error · no match');
	expect(markdown).toContain("… 3 more calls not listed");
	expect(markdown).toContain("Script completed\nOutput:\nhello");
	expect(markdown).not.toContain("/tmp/full.txt");

	const html = (await exportConversation("html", source([user("go"), script()]), { includeThinking: false })).content;
	expect(html).toContain("<pre>read {&quot;path&quot;:&quot;a&quot;} · ok · 12ms");
	expect(html).toContain("&lt;b&gt;");
	expect(html).not.toContain('<b>"}');

	const json = JSON.parse(
		(await exportConversation("json", source([user("go"), script()]), { includeThinking: false })).content,
	);
	expect(json.items[1].codemode.calls).toHaveLength(2);
	expect(json.items[1].codemode.omitted).toBe(3);
});

it("keeps other tools unchanged when no codemode view is present", async () => {
	const markdown = (
		await exportConversation("markdown", source([user("go"), tool({ detail: "ls -la" })]), { includeThinking: false })
	).content;
	expect(markdown).not.toContain("javascript");
	expect(markdown).not.toContain("Calls:");
	const json = JSON.parse(
		(await exportConversation("json", source([user("go"), tool()]), { includeThinking: false })).content,
	);
	expect(json.items[1]).not.toHaveProperty("codemode");
});
