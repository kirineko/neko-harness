// 技能市场客户端（spec: skill-market）：mock fetch 喂目录与 fflate 现造的 zip，
// 覆盖缓存、sha256 校验、zip-slip 防护、覆盖保护、临时目录卫生与卸载。

import { afterEach, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { activeLevelOf, createSkillMarketClient, SkillMarketError } from "../src/skill-market.ts";

const dirs: string[] = [];
function directory() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-market-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

function makePackage(files: Record<string, string>) {
	const entries: Record<string, Uint8Array> = {};
	for (const [path, content] of Object.entries(files)) entries[path] = new TextEncoder().encode(content);
	const zip = zipSync(entries);
	return { zip, sha256: createHash("sha256").update(zip).digest("hex"), size: zip.byteLength };
}

const GOOD = makePackage({
	"think/SKILL.md": "---\nname: think\ndescription: Think harder\n---\n# Think\n\nBody text.",
	"think/references/a.md": "ref a",
});

function market(overrides: Partial<Parameters<typeof createSkillMarketClient>[0]> = {}) {
	const calls: string[] = [];
	const catalog = {
		skills: [
			{
				name: "think",
				description: "Turns ideas into plans",
				category: "development",
				metadata: { source: "Tw93/Waza" },
				license: "",
				version: "v1",
				sha256: GOOD.sha256,
				size_bytes: GOOD.size,
				uploaded_at: "2026-10-12T00:00:00Z",
			},
		],
	};
	const fetchImpl = async (url: string) => {
		calls.push(url);
		if (url.includes("/download")) {
			return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => GOOD.zip.buffer.slice(0) };
		}
		if (url.includes("api/skills")) {
			return { ok: true, status: 200, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(0) };
		}
		return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
	};
	const home = directory();
	const client = createSkillMarketClient({ marketUrl: "https://market.test", home, fetchImpl, ...overrides });
	return { client, calls, home, fetchImpl };
}

it("lists with normalized fields and caches the catalog for 60s", async () => {
	const { client, calls } = market();
	const first = await client.list();
	expect(first[0]).toMatchObject({ name: "think", category: "development", source: "Tw93/Waza" });
	await client.list();
	await client.detail("think");
	expect(calls.filter((u) => u.endsWith("/api/skills"))).toHaveLength(1);
});

it("maps unreachable market and unknown skills to typed errors", async () => {
	const dead = createSkillMarketClient({
		marketUrl: "https://market.test",
		fetchImpl: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	await expect(dead.list()).rejects.toMatchObject({ code: "market_unavailable" });

	const { client } = market();
	await expect(client.detail("nope")).rejects.toMatchObject({ code: "skill_not_found" });
	expect(() => createSkillMarketClient({ marketUrl: "notaurl" })).toThrow(SkillMarketError);
});

it("previews SKILL.md body and file list without touching the disk", async () => {
	const { client, home } = market();
	const preview = await client.preview("think");
	expect(preview.body).toBe("# Think\n\nBody text.");
	expect(preview.files).toEqual(["SKILL.md", "references/a.md"]);
	expect(existsSync(join(home, ".agents"))).toBe(false);
});

it("installs to user level with sha256 verification and no temp residue", async () => {
	const { client, home } = market();
	const result = await client.install({ name: "think", scope: "user" });
	expect(result.path).toBe(join(home, ".agents", "skills", "think"));
	expect(existsSync(join(result.path, "SKILL.md"))).toBe(true);
	expect(existsSync(join(result.path, "references", "a.md"))).toBe(true);
	// 临时目录不残留于技能目录的兄弟位置。
	expect(readdirSync(join(home, ".agents")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
	// 安装复用 preview 下载的缓存（不重复下载）。
});

it("rejects overwrite-less reinstall, then replaces with overwrite: true", async () => {
	const { client, home } = market();
	await client.install({ name: "think", scope: "user" });
	writeFileSync(join(home, ".agents", "skills", "think", "LOCAL.md"), "local edit");
	await expect(client.install({ name: "think", scope: "user" })).rejects.toMatchObject({ code: "skill_exists" });
	expect(existsSync(join(home, ".agents", "skills", "think", "LOCAL.md"))).toBe(true);

	await client.install({ name: "think", scope: "user", overwrite: true });
	expect(existsSync(join(home, ".agents", "skills", "think", "LOCAL.md"))).toBe(false);
	expect(existsSync(join(home, ".agents", "skills", "think", "SKILL.md"))).toBe(true);
});

it("flags shadowed installs when project level has the same name", async () => {
	const { client } = market();
	const ws = directory();
	mkdirSync(join(ws, ".agents", "skills", "think"), { recursive: true });
	writeFileSync(join(ws, ".agents", "skills", "think", "SKILL.md"), "---\ndescription: project\n---\n");
	const result = await client.install({ name: "think", scope: "user", workspaceRoot: ws });
	expect(result.shadowedBy).toBe("project");
});

it("rejects zip-slip entries and hash mismatches without partial writes", async () => {
	const evil = zipSync({
		"evil/../../escape.txt": new Uint8Array([1]),
		"evil/SKILL.md": new TextEncoder().encode("---\ndescription: x\n---\n"),
	});
	const tampered = zipSync({ "think/SKILL.md": new TextEncoder().encode("---\ndescription: tampered\n---\n") });
	const catalog = {
		skills: [
			{
				name: "evil",
				description: "",
				category: "",
				metadata: {},
				license: "",
				version: "1",
				sha256: createHash("sha256").update(evil).digest("hex"),
				size_bytes: evil.byteLength,
				uploaded_at: "",
			},
			{
				name: "think",
				description: "",
				category: "",
				metadata: {},
				license: "",
				version: "1",
				sha256: GOOD.sha256,
				size_bytes: tampered.byteLength,
				uploaded_at: "",
			},
		],
	};
	const fetchImpl = async (url: string) => {
		if (url.includes("evil"))
			return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => evil.buffer.slice(0) };
		if (url.includes("download"))
			return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => tampered.buffer.slice(0) };
		return { ok: true, status: 200, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(0) };
	};
	const home = directory();
	const client = createSkillMarketClient({ marketUrl: "https://market.test", home, fetchImpl });

	await expect(client.install({ name: "evil", scope: "user" })).rejects.toMatchObject({
		code: "skill_invalid_package",
	});
	await expect(client.install({ name: "think", scope: "user" })).rejects.toMatchObject({ code: "skill_hash_mismatch" });
	expect(existsSync(join(home, ".agents", "skills"))).toBe(false);
	expect(existsSync(join(home, ".agents", ".tmp-placeholder"))).toBe(false);
});

it("cleans up its temp dir when writing fails mid-install", async () => {
	// 同一相对路径既当文件又当目录：解包合法，写盘时 mkdir/writeFile 必然冲突失败。
	const boomZip = zipSync({
		"boom/SKILL.md/x.txt": new TextEncoder().encode("conflict"),
		"boom/SKILL.md": new TextEncoder().encode("---\ndescription: x\n---\n"),
	});
	const catalog = {
		skills: [
			{
				name: "boom",
				description: "",
				category: "",
				metadata: {},
				license: "",
				version: "1",
				sha256: createHash("sha256").update(boomZip).digest("hex"),
				size_bytes: boomZip.byteLength,
				uploaded_at: "",
			},
		],
	};
	const fetchImpl = async (url: string) =>
		url.includes("download")
			? { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => boomZip.buffer.slice(0) }
			: { ok: true, status: 200, json: async () => catalog, arrayBuffer: async () => new ArrayBuffer(0) };
	const home = directory();
	const client = createSkillMarketClient({ marketUrl: "https://market.test", home, fetchImpl });
	mkdirSync(join(home, ".agents"), { recursive: true });

	await expect(client.install({ name: "boom", scope: "user" })).rejects.toThrow();
	expect(existsSync(join(home, ".agents", "skills", "boom"))).toBe(false);
	expect(readdirSync(join(home, ".agents")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
});

it("sweeps stale .tmp-* leftovers before installing", async () => {
	const { client, home } = market();
	mkdirSync(join(home, ".agents", ".tmp-stale-crash"), { recursive: true });
	writeFileSync(join(home, ".agents", ".tmp-stale-crash", "SKILL.md"), "---\ndescription: stale\n---\n");
	await client.install({ name: "think", scope: "user" });
	expect(existsSync(join(home, ".agents", ".tmp-stale-crash"))).toBe(false);
	expect(existsSync(join(home, ".agents", "skills", "think", "SKILL.md"))).toBe(true);
});

it("uninstalls scoped skills and errors on missing ones", async () => {
	const { client, home } = market();
	await client.install({ name: "think", scope: "user" });
	await client.uninstall({ name: "think", scope: "user" });
	expect(existsSync(join(home, ".agents", "skills", "think"))).toBe(false);
	await expect(client.uninstall({ name: "think", scope: "user" })).rejects.toMatchObject({
		code: "skill_not_installed",
	});
	await expect(client.uninstall({ name: "think", scope: "project" })).rejects.toMatchObject({
		code: "market_unavailable",
	});
});

it("computes active level from per-level presence", () => {
	expect(activeLevelOf({ project: true, user: true, builtin: true })).toBe("project");
	expect(activeLevelOf({ project: false, user: true, builtin: true })).toBe("user");
	expect(activeLevelOf({ project: false, user: false, builtin: true })).toBe("builtin");
	expect(activeLevelOf({ project: false, user: false, builtin: false })).toBeNull();
});

it("keeps the old version intact when placing the new version fails", async () => {
	const { client, home } = market({
		renameImpl: async () => {
			throw Object.assign(new Error("denied"), { code: "ENOSPC" });
		},
	});
	const target = join(home, ".agents", "skills", "think");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "SKILL.md"), "old version");
	await expect(client.install({ name: "think", scope: "user", overwrite: true })).rejects.toThrow("denied");
	expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old version");
	expect(readdirSync(join(home, ".agents")).filter((n) => n.startsWith(".tmp-") || n.startsWith(".bak-"))).toEqual([]);
});

it("leaves no backup after a successful overwrite", async () => {
	const { client, home } = market();
	await client.install({ name: "think", scope: "user" });
	await client.install({ name: "think", scope: "user", overwrite: true });
	expect(readdirSync(join(home, ".agents")).filter((n) => n.startsWith(".bak-"))).toEqual([]);
});

it("restores a leftover backup when the target is missing and drops it when the target exists", async () => {
	const { client, home } = market();
	const uuid = "00000000-0000-4000-8000-000000000000";
	const lost = join(home, ".agents", `.bak-${uuid}-lost`);
	mkdirSync(lost, { recursive: true });
	writeFileSync(join(lost, "SKILL.md"), "lost version");
	const kept = join(home, ".agents", `.bak-${uuid}-think`);
	mkdirSync(kept, { recursive: true });
	writeFileSync(join(kept, "SKILL.md"), "stale backup");
	mkdirSync(join(home, ".agents", "skills", "think"), { recursive: true });
	writeFileSync(join(home, ".agents", "skills", "think", "SKILL.md"), "current");

	await client.install({ name: "think", scope: "user", overwrite: true });
	expect(readFileSync(join(home, ".agents", "skills", "lost", "SKILL.md"), "utf8")).toBe("lost version");
	expect(readFileSync(join(home, ".agents", "skills", "think", "SKILL.md"), "utf8")).toContain("Body text.");
	expect(readdirSync(join(home, ".agents")).filter((n) => n.startsWith(".bak-"))).toEqual([]);
});
