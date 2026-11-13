import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { DEFAULT_IMAGE_PROMPT } from "../src/image-prompt.ts";
import { createNekoRuntime, projectChatView } from "../src/index.ts";
import { SessionMetadataDoc } from "../src/session-metadata.ts";

it("persists image-only input, preserves content order, forks and reopens without source files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-image-runtime-"));
	const faux = fauxProvider({
		models: [
			{ id: "vision", input: ["text", "image"] },
			{ id: "text", input: ["text"] },
		],
	});
	faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage([fauxText("A red square")])));
	const options = {
		storagePath: join(dir, "history.sqlite"),
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		const image = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
		const path = join(dir, "source.png");
		await writeFile(path, bytes);
		await runtime.waitAnswer(await runtime.submit([image], { requestId: "image-only", imageNames: ["source.png"] }));
		await runtime.submit([image], { requestId: "image-only" });
		const meta = await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context);
		expect(meta?.firstPromptPreview).toBe("[Image message: 1]");
		expect(JSON.stringify(meta)).not.toContain(image.data);
		await runtime.waitAnswer(
			await runtime.submit([{ type: "text", text: "before" }, image, { type: "text", text: "after" }]),
		);
		const fork = await runtime.forkConversation(runtime.root.id);
		await rm(path);
		await runtime.close();
		runtime = await createNekoRuntime(options);
		for (const id of [runtime.root.id, fork.id]) {
			const session = (await runtime.getConversation(id))!;
			const history = await session.conversation.entries({ order: "ascending" }, 100, undefined, runtime.context);
			const users = history.items.filter((e) => e.model?.[0]?.role === "user");
			expect(users).toHaveLength(2);
			expect(users[0]!.model![0]!.content).toEqual([{ type: "text", text: DEFAULT_IMAGE_PROMPT.text }, image]);
			expect((users[0]!.data as { defaultImagePrompt: unknown }).defaultImagePrompt).toEqual(DEFAULT_IMAGE_PROMPT);
			expect(users[1]!.model![0]!.content).toEqual([
				{ type: "text", text: "before" },
				image,
				{ type: "text", text: "after" },
			]);
			expect((users[0]!.data as { images: { name: string }[] }).images[0]?.name).toBe("source.png");
		}
		// Configure first: admission must reject new images while retaining history.
		const change = runtime.configureConversation(runtime.root.id, { model: { provider: "faux", modelId: "text" } });
		const submit = runtime.submit([image]);
		await change;
		await expect(submit).rejects.toThrow("does not support");
		expect((await runtime.waitAnswer(await runtime.submit("describe the previous written analysis"))).status).toBe(
			"done",
		);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);
it("native read uses each workspace and persists image details, including for text-only models", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-read-image-"));
	const other = await mkdtemp(join(tmpdir(), "neko-read-image-other-"));
	const faux = fauxProvider({
		models: [
			{ id: "vision", input: ["text", "image"] },
			{ id: "text", input: ["text"] },
		],
	});
	const runtime = await createNekoRuntime({
		storage: "memory",
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	});
	try {
		for (const [path, width] of [
			[dir, 32],
			[other, 64],
		] as const)
			await sharp({ create: { width, height: 24, channels: 3, background: "red" } })
				.png()
				.toFile(join(path, "same.png"));
		const otherSession = await runtime.createConversation({ cwd: other });
		for (const [session, path, width] of [
			[runtime.root, "same.png", 32],
			[otherSession, "same.png", 64],
			[otherSession, join(dir, "same.png"), 32],
		] as const) {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Seen")]),
			]);
			await session.waitAnswer(await session.submit("read image"));
			const state = await session.follow();
			const tool = projectChatView(state.value, "test")
				.items.filter((i) => i.type === "tool")
				.at(-1)!;
			state.dispose();
			expect(tool.type === "tool" && tool.isError).toBe(false);
			expect(tool.type === "tool" && tool.images?.[0]?.width).toBe(width);
		}
		for (const [name, path] of [
			["read", "invalid.png"],
			["read", "missing.png"],
		]) {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall(name!, { path: path! })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("error")]),
			]);
			await runtime.waitAnswer(await runtime.submit("read"));
			const state = await runtime.follow();
			const tool = projectChatView(state.value, "test")
				.items.filter((i) => i.type === "tool")
				.at(-1)!;
			state.dispose();
			expect(tool.type === "tool" && tool.isError).toBe(true);
		}
		await runtime.configureConversation(runtime.root.id, { model: { provider: "faux", modelId: "text" } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "same.png" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("error")]),
		]);
		await runtime.waitAnswer(await runtime.submit("read"));
		const state = await runtime.follow();
		expect(JSON.stringify(projectChatView(state.value, "test"))).toContain("placeholder");
		state.dispose();
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
		await rm(other, { recursive: true, force: true });
	}
}, 15000);
it("keeps distinct filenames for identical image bytes and queued messages", async () => {
	const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	});
	let release = () => {};
	try {
		const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		const image = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
		const gate = new Promise<void>((r) => {
			release = r;
		});
		faux.setResponses([
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText("one")]);
			},
			fauxAssistantMessage([fauxText("two")]),
		]);
		const one = await runtime.submit([image], { imageNames: ["first.png"] });
		const two = await runtime.submit([image], { imageNames: ["second.png"], whenBusy: "followUp" });
		release();
		await runtime.waitAnswer(one);
		await runtime.waitAnswer(two);
		const view = await runtime.follow();
		const projected = projectChatView(view.value, "test");
		view.dispose();
		expect(projected.items.filter((i) => i.type === "user").map((i) => i.images?.[0]?.name)).toEqual([
			"first.png",
			"second.png",
		]);
		for (const item of projected.items.filter((i) => i.type === "user")) {
			expect(item.defaultImagePrompt).toEqual(DEFAULT_IMAGE_PROMPT);
			expect(item.images?.[0]?.contentIndex).toBe(1);
			expect(item.text).toBe("");
		}
	} finally {
		release();
		await runtime.close();
	}
});
it("reports denied and changing files as image tool errors", async () => {
	const { vi } = await import("vitest");
	const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
	const { chmod } = await import("node:fs/promises");
	const dir = await mkdtemp(join(tmpdir(), "neko-image-read-failure-"));
	const path = join(dir, "image.png");
	const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
		.png()
		.toBuffer();
	await writeFile(path, bytes);
	const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	const runtime = await createNekoRuntime({
		storage: "memory",
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	});
	const call = async () => {
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("error reported")]),
		]);
		await runtime.waitAnswer(await runtime.submit("read image"));
		const state = await runtime.follow();
		const tool = projectChatView(state.value, "test")
			.items.filter((i) => i.type === "tool")
			.at(-1)!;
		state.dispose();
		return tool;
	};
	const original = NodeExecutionEnv.prototype.openBinaryReader;
	let spy: ReturnType<typeof vi.spyOn> | undefined;
	try {
		// chmod does not revoke read access on Windows.
		if (process.platform !== "win32") {
			await chmod(path, 0);
			expect((await call()).isError).toBe(true);
			await chmod(path, 0o600);
		}
		spy = vi.spyOn(NodeExecutionEnv.prototype, "openBinaryReader").mockImplementation(async function (
			this: InstanceType<typeof NodeExecutionEnv>,
			...args
		) {
			const result = await original.apply(this, args);
			if (!result.ok) return result;
			const reader = result.value;
			const read = reader.read.bind(reader);
			reader.read = async (...readArgs) => {
				const data = await read(...readArgs);
				await writeFile(path, Buffer.concat([bytes, Buffer.from("changed")]));
				return data;
			};
			return result;
		});
		const changed = await call();
		expect(changed.isError).toBe(true);
		expect(changed.result).toContain("changed while it was read");
	} finally {
		spy?.mockRestore();
		await chmod(path, 0o600);
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});
it("names image-only first turns using an off-mode text placeholder, never image bytes", async () => {
	const { fauxProvider: rawFaux } = await import("@earendil-works/pi-ai");
	const faux = rawFaux({ models: [{ id: "vision", input: ["text", "image"], reasoning: true }] });
	let naming = "";
	faux.setResponses([
		fauxAssistantMessage([fauxText("A red square")]),
		(ctx, opts) => {
			naming = JSON.stringify(ctx);
			expect(opts?.reasoning).toBeUndefined();
			return fauxAssistantMessage([fauxText("Red square")]);
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
		thinkingLevel: "high",
	});
	try {
		const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		await runtime.waitAnswer(
			await runtime.submit([{ type: "image", mimeType: "image/png", data: bytes.toString("base64") }], {
				imageNames: ["/temporary/private-image.png"],
			}),
		);
		for (let n = 0; n < 100 && !naming; n++) await sleep(10);
		expect(naming).toContain("[Image message: 1]");
		expect(naming).not.toContain(bytes.toString("base64"));
		expect(naming).not.toContain("private-image");
		await runtime.compact();
		await sleep(20);
		expect(faux.state.callCount).toBe(2);
	} finally {
		await runtime.close();
	}
});

it("projects actual resized read output at index zero with one diagnostic and persists it after source deletion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-read-resize-"));
	const faux = fauxProvider({
		models: [
			{
				id: "vision",
				input: ["text", "image"],
				inputLimits: { images: { resize: { maxWidth: 16, maxHeight: 16, maxBytes: 100000 } } },
			},
		],
	});
	const options = {
		storagePath: join(dir, "history.sqlite"),
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } })
			.png()
			.toFile(join(dir, "source.png"));
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "source.png" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Seen")]),
		]);
		await runtime.waitAnswer(await runtime.submit("read"));
		const history = await runtime.conversation.entries({ order: "ascending" }, 100, undefined, runtime.context);
		const result = history.items.find((entry) => entry.model?.[0]?.role === "toolResult")!;
		const message = result.model![0]!;
		if (message.role !== "toolResult") throw new Error("No result");
		const image = message.content[0]!;
		if (image.type !== "image") throw new Error("No image");
		const bytes = Buffer.from(image.data, "base64");
		expect((await sharp(bytes).metadata()).width).toBe(16);
		expect(message.details).toMatchObject({
			neko: { images: [{ contentIndex: 0, width: 16, height: 12, bytes: bytes.length }] },
		});
		await rm(join(dir, "source.png"));
		await runtime.close();
		runtime = await createNekoRuntime(options);
		const state = await runtime.follow();
		const tool = projectChatView(state.value, "test").items.find((item) => item.type === "tool")!;
		if (tool.type !== "tool") throw new Error("No tool");
		expect(tool.images?.[0]?.contentIndex).toBe(0);
		expect(tool.images?.[0]?.width).toBe(16);
		expect(tool.result?.match(/Resized/g)).toHaveLength(1);
		expect(tool.result).not.toContain("<harness>");
		state.dispose();
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("keeps native read decode and processing-limit diagnostics without a successful preview", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-read-decode-"));
	const faux = fauxProvider({
		models: [{ id: "limited", input: ["text", "image"], inputLimits: { images: { resize: { maxBytes: 1 } } } }],
	});
	const runtime = await createNekoRuntime({
		storage: "memory",
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "limited" },
	});
	try {
		const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
			.png()
			.toBuffer();
		await writeFile(join(dir, "invalid.png"), png.subarray(0, 33));
		await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
			.png()
			.toFile(join(dir, "valid.png"));
		for (const path of ["invalid.png", "valid.png"]) {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("failed")]),
			]);
			await runtime.waitAnswer(await runtime.submit("read"));
			const state = await runtime.follow();
			const item = projectChatView(state.value, "test")
				.items.filter((item) => item.type === "tool")
				.at(-1)!;
			expect(item.type === "tool" && item.isError).toBe(true);
			expect(item.type === "tool" ? (item.images?.length ?? 0) : -1).toBe(0);
			expect(item.type === "tool" && item.result?.length).toBeGreaterThan(0);
			state.dispose();
		}
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});
