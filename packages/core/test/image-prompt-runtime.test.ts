import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { InboxDoc } from "@earendil-works/pi-durable";
import sharp from "sharp";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { DEFAULT_IMAGE_PROMPT } from "../src/image-prompt.ts";
import { createNekoRuntime, projectChatView } from "../src/index.ts";
import { NekoInput } from "../src/input.ts";
import { SessionMetadataDoc } from "../src/session-metadata.ts";

const makeImage = async () => ({
	type: "image" as const,
	mimeType: "image/png",
	data: (
		await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
			.png()
			.toBuffer()
	).toString("base64"),
});

it("sends the default prompt as user content without changing system rules or adding requests", async () => {
	const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	const systems: unknown[] = [];
	const users: unknown[] = [];
	faux.setResponses(
		Array.from({ length: 3 }, () => (ctx) => {
			systems.push(getCurrentSystemMessage(ctx.messages)?.content);
			users.push(ctx.messages.filter((message) => message.role === "user").at(-1)?.content);
			return fauxAssistantMessage([fauxText("ok")]);
		}),
	);
	const runtime = await createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	});
	try {
		const image = await makeImage();
		await runtime.waitAnswer(await runtime.submit("Next image: inspect the error."));
		await runtime.waitAnswer(await runtime.submit([{ type: "text", text: " \n" }, image, image]));
		await runtime.waitAnswer(await runtime.submit([{ type: "text", text: "explicit task" }, image]));
		expect(systems[1]).toEqual(systems[0]);
		expect(systems[2]).toEqual(systems[0]);
		expect(users[1]).toEqual([
			{ type: "text", text: DEFAULT_IMAGE_PROMPT.text },
			{ type: "text", text: " \n" },
			image,
			image,
		]);
		expect(users[2]).toEqual([{ type: "text", text: "explicit task" }, image]);
		expect(faux.state.callCount).toBe(3);
	} finally {
		await runtime.close();
	}
});

it("preserves saved versions, old unmarked history and manual same-text messages in projections and forks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-image-prompt-"));
	const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("ok")])));
	const options = {
		storagePath: join(dir, "history.sqlite"),
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		const image = await makeImage();
		const saved = { version: 8, text: "Saved template from another version" };
		for (const [kind, content, defaultImagePrompt] of [
			[NekoInput.kind, [{ type: "text", text: saved.text }, image], saved],
			[NekoInput.kind, [image], undefined],
			[NekoInput.kind, [{ type: "text", text: DEFAULT_IMAGE_PROMPT.text }, image], undefined],
			[NekoInput.kind, [{ type: "text", text: "keep mismatch" }, image], saved],
			["untrusted.input", [{ type: "text", text: saved.text }, image], saved],
		] as const) {
			await runtime.waitAnswer(
				await runtime.root.conversation.submit(
					{
						type: "input",
						content: [...content],
						entry: {
							kind,
							data: {
								at: Date.now(),
								prompt: "[Image message: 1]",
								images: [],
								...(defaultImagePrompt ? { defaultImagePrompt } : {}),
							},
						},
					},
					runtime.context,
				),
			);
		}
		const fork = await runtime.forkConversation(runtime.root.id);
		await runtime.close();
		runtime = await createNekoRuntime(options);
		for (const id of [runtime.root.id, fork.id]) {
			const session = (await runtime.getConversation(id))!;
			const reader = await session.follow();
			const users = projectChatView(reader.value, "test").items.filter((item) => item.type === "user");
			reader.dispose();
			expect(users[0]?.defaultImagePrompt).toEqual(saved);
			expect(users[0]?.text).toBe("");
			expect(users.slice(1).map((item) => item.defaultImagePrompt)).toEqual([
				undefined,
				undefined,
				undefined,
				undefined,
			]);
			expect(users.slice(1).map((item) => item.text)).toEqual([
				"",
				DEFAULT_IMAGE_PROMPT.text,
				"keep mismatch",
				saved.text,
			]);
		}
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("queues content and provenance atomically, rejects invalid/busy inputs, and preserves request identity", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-image-queue-"));
	const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	let started!: () => void;
	const active = new Promise<void>((resolve) => {
		started = resolve;
	});
	faux.setResponses([
		async (_ctx, opts) => {
			started();
			await new Promise<void>((resolve) => {
				opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
				if (opts?.signal?.aborted) resolve();
			});
			return fauxAssistantMessage([fauxText("stopped")]);
		},
	]);
	const options = {
		storagePath: join(dir, "history.sqlite"),
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		const image = await makeImage();
		await runtime.submit("busy");
		await active;
		const queued = await runtime.submit([image], { requestId: "queued-image", whenBusy: "followUp" });
		expect((await queued.status(runtime.context)).status).toBe("queued");
		const inbox = await runtime.harness.snapshot(InboxDoc, runtime.root.id, runtime.context);
		expect(JSON.stringify(inbox)).toContain(DEFAULT_IMAGE_PROMPT.text);
		expect(JSON.stringify(inbox)).toContain("defaultImagePrompt");
		const before = await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context);
		await expect(runtime.submit([image], { requestId: "rejected", whenBusy: "reject" })).rejects.toThrow();
		await expect(runtime.submit([{ ...image, data: "invalid" }])).rejects.toThrow();
		expect(
			(await runtime.harness.snapshot(SessionMetadataDoc, runtime.root.id, runtime.context))?.lastMessageAt,
		).toEqual(before?.lastMessageAt);
		await runtime.close();
		faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("recovered")])));
		runtime = await createNekoRuntime(options);
		const retry = await runtime.submit([image], { requestId: "queued-image", whenBusy: "followUp" });
		await runtime.waitAnswer(retry);
		const entries = await runtime.root.conversation.entries({ order: "ascending" }, 100, undefined, runtime.context);
		const marked = entries.items.filter(
			(entry) => (entry.data as { defaultImagePrompt?: unknown } | undefined)?.defaultImagePrompt,
		);
		expect(marked).toHaveLength(1);
		expect(marked[0]?.model?.[0]?.content).toEqual([{ type: "text", text: DEFAULT_IMAGE_PROMPT.text }, image]);
		expect((marked[0]?.data as { defaultImagePrompt: unknown }).defaultImagePrompt).toEqual(DEFAULT_IMAGE_PROMPT);
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 10_000);
