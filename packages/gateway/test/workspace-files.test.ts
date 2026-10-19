import { expect, it } from "bun:test";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadImage } from "@neko-harness/core/image-transfer";
import sharp from "sharp";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, IS_WINDOWS, testSocketPath } from "./helpers.ts";

it("queries a registered workspace and imports images with attachment ownership", async () => {
	const temp = await mkdtemp(join(tmpdir(), "neko-file-gateway-"));
	const root = await realpath(temp);
	const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
	const gateway = await startGateway({
		storage: "memory",
		storagePath: join(root, "neko.sqlite"),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "vision" },
		socketPath: testSocketPath(root),
		port: 0,
	});
	const a = await connectTestClient(gateway);
	const b = await connectTestWsClient(gateway);
	try {
		await writeFile(join(root, "my file.ts"), "body not in candidates");
		await a.workspaces.add({ path: root });
		for (const client of [a, b]) {
			const result = await client.workspaceFiles.search({ workspaceRoot: root, query: "file" });
			expect(result.entries.some((e) => e.path === "my file.ts")).toBe(true);
			expect(JSON.stringify(result)).not.toContain("body not");
			await expect(client.workspaceFiles.search({ workspaceRoot: "/unregistered", query: "" })).rejects.toThrow();
		}
		// Tests run with file isolation; always restore PATH before other operations.
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = "";
			for (const client of [a, b]) {
				expect((await client.workspaceFiles.search({ workspaceRoot: root, query: "" })).entries.length).toBeGreaterThan(
					0,
				);
				const unrelated = await client.workspaceFiles
					.search({ workspaceRoot: "/unregistered", query: "" })
					.catch((error: Error) => error);
				expect(unrelated).toBeInstanceOf(Error);
				expect((unrelated as Error).message).not.toContain("安装");
			}
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		expect((await b.workspaceFiles.search({ workspaceRoot: root, query: "file" })).entries).toContainEqual({
			name: "my file.ts",
			path: "my file.ts",
			kind: "file",
		});
		const abort = new AbortController();
		abort.abort();
		await expect(
			a.host.root((ctx) => a.workspaceFiles.search({ workspaceRoot: root, query: "" }, ctx), { signal: abort.signal }),
		).rejects.toThrow();
		const session = await a.management.create({ cwd: root });
		const chat = await a.attach(session.id);
		const other = await b.attach(session.id);
		const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: "blue" } })
			.png()
			.toBuffer();
		await writeFile(join(root, "my image.png"), bytes);
		await writeFile(join(root, "invalid.png"), "not an image");
		await expect(chat.importImage("invalid.png")).rejects.toThrow();
		const { open } = await import("node:fs/promises");
		const huge = await open(join(root, "huge.png"), "w");
		await huge.truncate(21 * 1024 * 1024);
		await huge.close();
		await expect(chat.importImage("huge.png")).rejects.toThrow();
		await expect(chat.importImage("missing.png")).rejects.toThrow();
		const image = await chat.importImage("my image.png");
		expect(image.name).toBe("my image.png");
		const read = await downloadImage((offset) => chat.draftImage({ id: image.id, offset }));
		expect(read.bytes).toEqual(new Uint8Array(bytes));
		await expect(other.draftImage({ id: image.id, offset: 0 })).rejects.toThrow();
		await chat.releaseImage(image.id);
		await expect(chat.draftImage({ id: image.id, offset: 0 })).rejects.toThrow();
		// 经 symlink 逃逸工作区的拒绝为 POSIX 语义：Windows 创建 symlink 需要额外特权。
		if (!IS_WINDOWS) {
			await symlink("/tmp", join(root, "outside"));
			await expect(chat.importImage("outside/no.png")).rejects.toThrow();
		}
		await expect(chat.importImage("../no.png")).rejects.toThrow();
	} finally {
		await a.close();
		await b.close();
		await gateway.close();
		await rm(root, { recursive: true, force: true });
	}
});
