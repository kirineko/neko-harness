import { expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { downloadImage, uploadImage } from "@neko-harness/core/image-transfer";
import sharp from "sharp";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { DEFAULT_IMAGE_PROMPT } from "../../core/src/image-prompt.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor } from "./helpers.ts";

async function transfersImages() {
	const dir = await mkdtemp(join(tmpdir(), "neko-image-gateway-"));
	const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	faux.setResponses([fauxAssistantMessage([fauxText("A blue image")])]);
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
		socketPath: testSocketPath(dir),
		port: 0,
	});
	const a = await connectTestClient(gateway);
	const b = await connectTestWsClient(gateway);
	try {
		const id = String(gateway.runtime.root.id);
		const ac = await a.attach(id);
		const bc = await b.attach(id);
		const bytes = await sharp(randomBytes(800 * 600 * 3), { raw: { width: 800, height: 600, channels: 3 } })
			.png()
			.toBuffer();
		const upload = await uploadImage(
			{ name: "blue.png", mimeType: "image/png", bytes },
			{
				begin: (i) => ac.beginImage(i),
				append: (i) => ac.appendImage(i),
				finish: (i) => ac.finishImage(i),
				release: (i) => ac.releaseImage(i),
			},
		);
		await expect(bc.finishImage(upload)).rejects.toThrow();
		await ac.submit({ content: "", images: [upload], requestId: "one-image" });
		await waitFor(() => !!bc.view.value?.items.some((i) => i.type === "user" && i.images?.length), "image view");
		const item = bc.view.value!.items.find((i) => i.type === "user")!;
		if (item.type !== "user") throw new Error("missing user");
		expect(item.images![0]!.name).toBe("blue.png");
		expect(item.defaultImagePrompt).toEqual(DEFAULT_IMAGE_PROMPT);
		expect(item.text).toBe("");
		expect(ac.view.value?.items.find((i) => i.type === "user")).toEqual(item);
		const reconnected = await connectTestWsClient(gateway);
		try {
			const restored = await reconnected.attach(id);
			expect(restored.view.value?.items.find((i) => i.type === "user")?.defaultImagePrompt).toEqual(
				DEFAULT_IMAGE_PROMPT,
			);
		} finally {
			await reconnected.close();
		}
		expect(JSON.stringify(bc.view.value)).not.toContain(bytes.toString("base64"));
		const image = item.images![0]!;
		const downloaded = await downloadImage((offset) =>
			bc.getImage({ entryId: image.entryId, contentIndex: image.contentIndex, offset }),
		);
		expect((await sharp(downloaded.bytes).metadata()).width).toBe(800);
		await ac.submit({ content: "", images: [upload], requestId: "one-image" });
		expect(bc.view.value!.items.filter((i) => i.type === "user")).toHaveLength(1);
		await Promise.all([ac.compact({}), bc.compact({})]);
		await waitFor(() => bc.view.value?.compaction?.latest?.phase === "nothing", "no-op compaction");
		await expect(bc.getImage({ entryId: 999999, contentIndex: 0, offset: 0 })).rejects.toThrow();
		const fork = await gateway.runtime.forkConversation(gateway.runtime.root.id);
		const forkChat = await b.attach(String(fork.id));
		expect(forkChat.view.value?.items.find((i) => i.type === "user")?.defaultImagePrompt).toEqual(DEFAULT_IMAGE_PROMPT);
		expect(
			(
				await downloadImage((offset) =>
					forkChat.getImage({ entryId: image.entryId, contentIndex: image.contentIndex, offset }),
				)
			).bytes,
		).toEqual(downloaded.bytes);
		await expect(bc.beginImage({ name: "late.png", mimeType: "image/png", size: 1 })).rejects.toThrow();
		const empty = await gateway.runtime.createConversation();
		const emptyChat = await b.attach(String(empty.id));
		await expect(
			emptyChat.getImage({ entryId: image.entryId, contentIndex: image.contentIndex, offset: 0 }),
		).rejects.toThrow("not part");
	} finally {
		await a.close();
		await b.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
}

// Bun's in-process WS client occasionally corrupts the stream while a socket closes (1002 "unsupported control frame")
// under CPU load. The failure is in teardown, not in image transfer, so a retry is enough.
it("transfers images across Unix/WS without embedding bytes in replicated views", transfersImages, {
	timeout: 15000,
	retry: 2,
});
