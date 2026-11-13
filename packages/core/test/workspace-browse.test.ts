import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rm, trySymlink } from "../../../test/temp-dir.ts";
import { BROWSE_LIMITS, FILE_CACHE_LIMITS, isProtectedPath, WorkspaceFiles } from "../src/workspace-files.ts";

const signal = () => new AbortController().signal;
const workspace = async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neko-browse-")));
	const outside = await realpath(await mkdtemp(join(tmpdir(), "neko-browse-outside-")));
	return {
		root,
		outside,
		done: () =>
			Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]),
	};
};

it("lists direct children dirs first, honors gitignore, hides .git and marks links and protected files", async () => {
	const { root, outside, done } = await workspace();
	const files = new WorkspaceFiles();
	try {
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git/HEAD"), "x");
		await writeFile(join(root, ".gitignore"), "ignored/\n");
		await mkdir(join(root, "ignored"));
		await writeFile(join(root, "ignored/a.ts"), "x");
		await mkdir(join(root, "src/deep"), { recursive: true });
		await writeFile(join(root, "src/b.ts"), "b");
		await writeFile(join(root, "src/a.ts"), "a");
		await writeFile(join(root, "src/deep/c.ts"), "c");
		await writeFile(join(root, "z.txt"), "z");
		await writeFile(join(root, ".env"), "SECRET=1");
		const linked = trySymlink(outside, join(root, "link"));
		const top = await files.children(root, "", signal());
		expect(top.entries.map((e) => [e.name, e.kind])).toEqual([
			["src", "directory"],
			[".env", "file"],
			[".gitignore", "file"],
			...(linked ? [["link", "symlink"]] : []),
			["z.txt", "file"],
		]);
		expect(top.entries.find((e) => e.name === ".env")?.protected).toBe(true);
		expect(top.incomplete).toBe(false);
		const src = await files.children(root, "src", signal());
		expect(src.entries.map((e) => e.path)).toEqual(["src/deep", "src/a.ts", "src/b.ts"]);
		expect((await files.children(root, "src/", signal())).entries).toEqual(src.entries);
	} finally {
		await files.close();
		await done();
	}
});

it("limits children and reports a truncated enumeration as incomplete", async () => {
	const { root, done } = await workspace();
	const files = new WorkspaceFiles({ ...FILE_CACHE_LIMITS, maxEntries: 3 });
	try {
		for (const name of ["a", "b", "c", "d", "e"]) await writeFile(join(root, name), name);
		const result = await files.children(root, "", signal());
		expect(result.incomplete).toBe(true);
		expect(result.entries.length).toBeLessThanOrEqual(BROWSE_LIMITS.children);
	} finally {
		await files.close();
		await done();
	}
});

it("rejects escaping, absolute, backslash, control-character and symlink-escaping paths for dirs and files", async () => {
	const { root, outside, done } = await workspace();
	const files = new WorkspaceFiles();
	try {
		await writeFile(join(outside, "secret.txt"), "secret");
		await mkdir(join(outside, "dir"));
		const linkedDir = trySymlink(outside, join(root, "link"));
		const linkedFile = trySymlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
		for (const bad of ["../x", "a/../../x", outside, "~/x", "a\\b", "a\0b", ".git/config"]) {
			await expect(files.read(root, bad, signal())).rejects.toThrow();
			await expect(files.children(root, bad, signal())).rejects.toThrow();
		}
		if (linkedFile)
			await expect(files.read(root, "secret-link.txt", signal())).rejects.toThrow("outside the workspace");
		if (linkedDir) await expect(files.children(root, "link", signal())).rejects.toThrow("outside the workspace");
		await expect(files.read(root, "missing.txt", signal())).rejects.toThrow("File not found");
		await expect(files.read(root, "", signal())).rejects.toThrow();
	} finally {
		await files.close();
		await done();
	}
});

it("reads text with size and truncation, reports binary and undecodable files, protects credentials", async () => {
	const { root, done } = await workspace();
	const files = new WorkspaceFiles();
	try {
		await writeFile(join(root, "a.ts"), "const 值 = 1;\n");
		const text = await files.read(root, "a.ts", signal());
		expect(text).toMatchObject({ path: "a.ts", kind: "text", content: "const 值 = 1;\n", truncated: false });
		expect(text.size).toBe(Buffer.byteLength("const 值 = 1;\n"));
		await writeFile(join(root, "empty.txt"), "");
		expect(await files.read(root, "empty.txt", signal())).toMatchObject({ kind: "text", content: "", size: 0 });

		// A cut inside a multi-byte character must not produce a replacement char or fail.
		const cut = `${"a".repeat(BROWSE_LIMITS.readBytes - 1)}值tail`;
		await writeFile(join(root, "big.txt"), cut);
		const big = await files.read(root, "big.txt", signal());
		expect(big.truncated).toBe(true);
		expect(big.size).toBe(Buffer.byteLength(cut));
		expect(big.content).toBe("a".repeat(BROWSE_LIMITS.readBytes - 1));

		await writeFile(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
		expect(await files.read(root, "bin.dat", signal())).toMatchObject({ kind: "binary" });
		await writeFile(join(root, "latin.txt"), Buffer.from([0xff, 0xfe, 0x41]));
		expect(await files.read(root, "latin.txt", signal())).toMatchObject({ kind: "binary" });

		await writeFile(join(root, ".env"), "SECRET=1");
		await writeFile(join(root, ".env.example"), "KEY=");
		await writeFile(join(root, "id_ed25519"), "private");
		await writeFile(join(root, "id_ed25519.pub"), "public");
		const linked = trySymlink(join(root, ".env"), join(root, "innocent.txt"));
		const secret = await files.read(root, ".env", signal());
		expect(secret.kind).toBe("protected");
		expect(JSON.stringify(secret)).not.toContain("SECRET");
		if (linked) expect((await files.read(root, "innocent.txt", signal())).kind).toBe("protected");
		expect((await files.read(root, "id_ed25519", signal())).kind).toBe("protected");
		expect(await files.read(root, ".env.example", signal())).toMatchObject({ kind: "text", content: "KEY=" });
		expect((await files.read(root, "id_ed25519.pub", signal())).kind).toBe("text");
		await expect(files.read(root, ".", signal())).rejects.toThrow();
		await mkdir(join(root, "dir"));
		await expect(files.read(root, "dir", signal())).rejects.toThrow("Not a file");
	} finally {
		await files.close();
		await done();
	}
});

it("matches credential names conservatively", () => {
	for (const name of [".env", ".env.local", ".env.production", "key.pem", "a/b/server.key", "id_rsa", "id_ecdsa.bak"])
		expect(isProtectedPath(name)).toBe(true);
	for (const name of [".env.example", ".env.sample", ".env.template", "id_rsa.pub", "environment.ts", "keyboard.ts"])
		expect(isProtectedPath(name)).toBe(false);
});

it("answers browse calls from one shared listing and honors an aborted signal", async () => {
	const { root, done } = await workspace();
	const files = new WorkspaceFiles();
	try {
		await mkdir(join(root, "a"));
		await mkdir(join(root, "b"));
		await writeFile(join(root, "a/x.ts"), "x");
		await writeFile(join(root, "b/y.ts"), "y");
		await files.children(root, "", signal());
		const keys = files.stats.keys;
		await files.children(root, "a", signal());
		await files.children(root, "b", signal());
		expect(files.stats.keys).toBe(keys);
		const aborted = new AbortController();
		aborted.abort();
		await expect(files.children(root, "a", aborted.signal)).rejects.toThrow();
		await expect(files.read(root, "a/x.ts", aborted.signal)).rejects.toThrow();
		expect(files.stats.active).toBe(0);
	} finally {
		await files.close();
		await done();
	}
});
