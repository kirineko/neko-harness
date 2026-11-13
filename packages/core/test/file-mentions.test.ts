import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rm, trySymlink } from "../../../test/temp-dir.ts";
import { mentionAt, replaceMention } from "../src/file-mentions.ts";
import { WorkspaceFiles, workspaceTarget } from "../src/workspace-files.ts";

it("replaces only the active reference and preserves quoted directory cursors", () => {
	expect(mentionAt("mail@example.com", 16)).toBeNull();
	const text = '查看 @"my fi 后文';
	const token = mentionAt(text, 10)!;
	const result = replaceMention(text, token, "my files/a.ts", false);
	expect(result.text).toBe('查看 @"my files/a.ts"  后文');
	const directory = replaceMention("@src", mentionAt("@src", 4)!, "my files", true);
	expect(directory.text).toBe('@"my files/"');
	expect(directory.cursor).toBe(directory.text.length - 1);
});
it("scopes discovery, honors ignores and never returns outside symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "neko-files-"));
	const files = new WorkspaceFiles();
	try {
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		await mkdir(join(root, "src"));
		await mkdir(join(root, "my files"));
		await writeFile(join(root, "my files/example.ts"), "example");
		await mkdir(join(root, "ignored"));
		await writeFile(join(root, ".gitignore"), "ignored/\n");
		await writeFile(join(root, ".hidden"), "h");
		await writeFile(join(root, "src/runtime.ts"), "secret body");
		await writeFile(join(root, "ignored/runtime.ts"), "no");
		const linked = trySymlink(tmpdir(), join(root, "outside"));
		const signal = new AbortController().signal;
		const result = await files.search(root, "runtime", signal);
		expect(result.entries.map((e) => e.path)).toEqual(["src/runtime.ts"]);
		const top = await files.search(root, "", signal);
		expect(top.entries).toContainEqual({ name: "src", path: "src", kind: "directory" });
		expect(top.entries).toContainEqual({ name: "my files", path: "my files", kind: "directory" });
		expect((await files.search(root, "example", signal)).entries).toEqual([
			{ name: "example.ts", path: "my files/example.ts", kind: "file" },
		]);
		expect((await files.search(root, "my files/", signal)).entries).toEqual([
			{ name: "example.ts", path: "my files/example.ts", kind: "file" },
		]);
		expect(JSON.stringify(result)).not.toContain("secret body");
		expect((await files.search(root, "", signal)).entries.some((e) => e.path === ".hidden")).toBe(true);
		if (linked) await expect(workspaceTarget(root, "outside")).rejects.toThrow("outside");
		await expect(files.search(root, "../", signal)).rejects.toThrow("relative");
		const abort = new AbortController();
		abort.abort();
		await expect(files.search(root, "", abort.signal)).rejects.toThrow();
	} finally {
		await files.close();
		await rm(root, { recursive: true, force: true });
	}
});
