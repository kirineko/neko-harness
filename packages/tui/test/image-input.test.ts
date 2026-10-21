import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactInstructions } from "@neko-harness/core/image-transfer";
import { rm } from "../../../test/temp-dir.ts";
import { imagePaths, readImageFile } from "../src/image-input.ts";

it("recognizes quoted drag paths without interpreting ordinary prose or shell commands", () => {
	// 转义语义是 POSIX 的（Windows 下 \ 是路径分隔符），显式指定平台。
	expect(imagePaths('"/tmp/my image.png" /tmp/a\\ b.webp', "linux")).toEqual(["/tmp/my image.png", "/tmp/a b.webp"]);
	expect(imagePaths("please look at image.png")).toBeNull();
	expect(imagePaths('"unfinished.png')).toBeNull();
	expect(imagePaths("/tmp/readme.md")).toBeNull();
	// Windows：\ 是路径分隔符，不作转义符。
	expect(imagePaths(String.raw`D:\code\img.png`, "win32")).toEqual([String.raw`D:\code\img.png`]);
	expect(imagePaths(String.raw`"D:\my dir\img.png"`, "win32")).toEqual([String.raw`D:\my dir\img.png`]);
	// POSIX：转义行为不变。
	expect(imagePaths(String.raw`/tmp/a\ b.webp`, "linux")).toEqual(["/tmp/a b.webp"]);
	expect(compactInstructions("/compact preserve decisions")).toBe("preserve decisions");
	expect(compactInstructions("/compactly")).toBeNull();
	expect(compactInstructions("hello /compact")).toBeNull();
});
it("reads owned bytes without changing source files and reports unavailable paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-tui-image-"));
	try {
		await writeFile(join(dir, "my image.png"), "fixture");
		expect((await readImageFile("my image.png", dir)).name).toBe("my image.png");
		await expect(readImageFile("missing.png", dir)).rejects.toThrow();
		await expect(readImageFile(".", dir)).rejects.toThrow("file");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
it("clipboard adapters fall back to text and decode platform image payloads", async () => {
	const { clipboard } = await import("../src/image-input.ts");
	const text = await clipboard({
		platform: "darwin",
		command: async (tool) => {
			if (tool === "pbpaste") return "ordinary text";
			throw new Error("unavailable");
		},
	});
	expect(text).toEqual({ text: "ordinary text" });
	const png = await clipboard({ platform: "win32", command: async () => "IMAGE:AQID" });
	expect([...png.image!.bytes]).toEqual([1, 2, 3]);
	// WSL reads the Windows clipboard via PowerShell first and keeps its error if the Linux fallback is unavailable.
	expect(await clipboard({ platform: "linux", wsl: true, command: async () => "hi\r\n" })).toEqual({ text: "hi" });
	await expect(
		clipboard({
			platform: "linux",
			wsl: true,
			command: async (tool) => {
				throw new Error(tool === "powershell.exe" ? "interop disabled" : "xclip missing");
			},
		}),
	).rejects.toThrow("interop disabled");
	const calls: string[] = [];
	expect(
		await clipboard({
			platform: "linux",
			wsl: false,
			wayland: true,
			command: async (tool, args) => {
				calls.push(tool);
				if (args.includes("image/png")) throw new Error("no image");
				return "paste";
			},
		}),
	).toEqual({ text: "paste" });
	expect(calls).toEqual(["wl-paste", "wl-paste"]);
	await expect(
		clipboard({
			platform: "linux",
			wsl: false,
			command: async () => {
				throw new Error("backend missing");
			},
		}),
	).rejects.toThrow("backend missing");
});
it("renders PNG/JPEG/WebP through Pi Kitty protocol only when visible and falls back without graphics", async () => {
	const { HistoryImage } = await import("../src/components/history-image.ts");
	const { setCapabilities, getCapabilities } = await import("@earendil-works/pi-tui");
	const { terminalImage } = await import("@neko-harness/core");
	const sharp = (await import("sharp")).default;
	const original = getCapabilities();
	try {
		for (const format of ["png", "jpeg", "webp"] as const) {
			const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } })
				.toFormat(format)
				.toBuffer();
			expect((await sharp(await terminalImage(bytes)).metadata()).format).toBe("png");
			let calls = 0,
				loaded = false;
			const preview = new HistoryImage(
				{
					entryId: 1,
					contentIndex: 0,
					name: `x.${format}`,
					mimeType: `image/${format}`,
					width: 16,
					height: 8,
					bytes: bytes.length,
				},
				async () => {
					calls++;
					return { name: `x.${format}`, mimeType: `image/${format}`, bytes };
				},
				() => {
					loaded = true;
				},
			);
			setCapabilities({ ...original, images: "kitty" });
			preview.render(60);
			expect(calls).toBe(0);
			preview.setVisible(true);
			preview.render(60);
			for (let n = 0; n < 100 && !loaded; n++) await Bun.sleep(5);
			expect(preview.render(60).join("\n")).toContain("\x1b_G");
			expect(preview.render(60).length).toBeLessThanOrEqual(8);
			preview.setVisible(false);
			setCapabilities({ ...original, images: null });
			expect(preview.render(60).join("\n")).toContain(`x.${format}`);
		}
	} finally {
		setCapabilities(original);
	}
});

it("expands ~/ everywhere and ~\\ only on win32", async () => {
	const { expandHome } = await import("../src/image-input.ts");
	const { homedir } = await import("node:os");
	expect(expandHome("~/pics/a.png", "linux")).toBe(join(homedir(), "pics/a.png"));
	expect(expandHome("~/pics/a.png", "win32")).toBe(join(homedir(), "pics/a.png"));
	expect(expandHome(String.raw`~\pics\a.png`, "win32")).toBe(join(homedir(), String.raw`pics\a.png`));
	expect(expandHome(String.raw`~\pics\a.png`, "linux")).toBe(String.raw`~\pics\a.png`);
	expect(expandHome("~user/a.png", "win32")).toBe("~user/a.png");
});
