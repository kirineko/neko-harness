import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { createResourceLoader } from "../src/prompt/resources.ts";

const dirs: string[] = [];
function directory() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-resources-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

const writeAgents = (dir: string, content: string) => writeFileSync(join(dir, "AGENTS.md"), content);
const writeSkill = (dir: string, name: string, description: string) => {
	const skillDir = join(dir, ".agents", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\ndescription: ${description}\n---\nbody`);
};

it("loads user-level then workspace-level AGENTS.md and merges skills with project winning", async () => {
	const home = directory();
	const workspace = directory();
	mkdirSync(join(home, ".agents"), { recursive: true });
	writeAgents(join(home, ".agents"), "user rules");
	writeAgents(workspace, "project rules");
	writeSkill(join(home), "shared", "user shared");
	writeSkill(join(home), "only-user", "user only");
	writeSkill(workspace, "shared", "project shared");

	const load = createResourceLoader(home, undefined, { builtinDir: null });
	const resources = await load(workspace);
	expect(resources.contextFiles.map((f) => f.content)).toEqual(["user rules", "project rules"]);
	expect(resources.contextFiles[0]!.path).toBe(join(home, ".agents", "AGENTS.md"));
	expect(resources.contextFiles[1]!.path).toBe(join(workspace, "AGENTS.md"));
	const byName = new Map(resources.skills.map((s) => [s.name, s.description]));
	expect(byName.get("shared")).toBe("project shared");
	expect(byName.get("only-user")).toBe("user only");
});

it("omits missing files and survives unreadable ones", async () => {
	const home = directory();
	const workspace = directory();
	writeAgents(workspace, "project rules");
	const unreadable = join(home, ".agents");
	mkdirSync(unreadable, { recursive: true });
	writeAgents(unreadable, "user rules");
	// chmod does not revoke read access on Windows, so the user file stays visible there.
	if (process.platform === "win32") {
		const resources = await createResourceLoader(home, undefined, { builtinDir: null })(workspace);
		expect(resources.contextFiles.map((f) => f.content)).toEqual(["user rules", "project rules"]);
	} else {
		chmodSync(join(unreadable, "AGENTS.md"), 0o000);
		try {
			const resources = await createResourceLoader(home, undefined, { builtinDir: null })(workspace);
			expect(resources.contextFiles.map((f) => f.content)).toEqual(["project rules"]);
		} finally {
			chmodSync(join(unreadable, "AGENTS.md"), 0o644);
		}
	}
	const empty = await createResourceLoader(directory(), undefined, { builtinDir: null })(directory());
	expect(empty.contextFiles).toEqual([]);
	expect(empty.skills).toEqual([]);
});

it("reloads each workspace on AGENTS.md edits and new skills", async () => {
	const home = directory();
	const workspace = directory();
	writeAgents(workspace, "v1");
	const load = createResourceLoader(home, undefined, { builtinDir: null });

	expect((await load(workspace)).contextFiles[0]!.content).toBe("v1");
	// Loading another workspace must not affect later reads of this one.
	expect((await load(directory())).contextFiles).toEqual([]);

	writeAgents(workspace, "v2");
	expect((await load(workspace)).contextFiles[0]!.content).toBe("v2");

	writeSkill(workspace, "fresh", "added later");
	expect((await load(workspace)).skills.map((s) => s.name)).toEqual(["fresh"]);

	writeFileSync(join(workspace, ".agents", "skills", "fresh", "SKILL.md"), "---\ndescription: edited\n---\nbody");
	expect((await load(workspace)).skills[0]!.description).toBe("edited");
});

it("refreshes permissions without mtime changes and reports failures without instruction contents", async () => {
	const home = directory();
	const workspace = directory();
	const file = join(workspace, "AGENTS.md");
	writeAgents(workspace, "private instruction body");
	const diagnostics: { path: string; message: string }[] = [];
	const load = createResourceLoader(home, (d) => diagnostics.push(d), { builtinDir: null });
	expect((await load(workspace)).contextFiles).toHaveLength(1);
	if (process.platform !== "win32") {
		chmodSync(file, 0o000);
		try {
			expect((await load(workspace)).contextFiles).toHaveLength(0);
			expect(diagnostics).toHaveLength(1);
			expect((await load(workspace)).contextFiles).toHaveLength(0);
			expect(diagnostics).toHaveLength(1);
			expect(JSON.stringify(diagnostics)).not.toContain("private instruction body");
		} finally {
			chmodSync(file, 0o600);
		}
	}
	expect((await load(workspace)).contextFiles).toHaveLength(1);
	rmSync(file);
	expect((await load(workspace)).contextFiles).toHaveLength(0);
});

it("diagnoses large instructions without truncating them", async () => {
	const home = directory();
	const workspace = directory();
	const content = "x".repeat(65537);
	writeAgents(workspace, content);
	const diagnostics: { path: string; message: string }[] = [];
	const resources = await createResourceLoader(home, (d) => diagnostics.push(d), { builtinDir: null })(workspace);
	expect(resources.contextFiles[0]?.content).toBe(content);
	expect(diagnostics).toHaveLength(1);
	expect(diagnostics[0]?.path).toBe(join(workspace, "AGENTS.md"));
	expect(diagnostics[0]?.message).not.toBe("");
	expect(diagnostics[0]?.message).not.toContain(content);
});

it("captures the project winner for explicit invocation even when hidden from model discovery", async () => {
	const home = directory();
	const workspace = directory();
	writeSkill(home, "shared", "user shared");
	writeSkill(workspace, "shared", "project shared");
	writeSkill(workspace, "other", "not requested");
	const filePath = join(workspace, ".agents", "skills", "shared", "SKILL.md");
	const content = "---\ndescription: project shared\ndisable-model-invocation: true\n---\nproject body";
	writeFileSync(filePath, content);

	const load = createResourceLoader(home, undefined, { builtinDir: null });
	const resources = await load(workspace, "shared");
	expect(resources.skills.find((skill) => skill.name === "shared")).toEqual({
		name: "shared",
		description: "project shared",
		filePath,
		disableModelInvocation: true,
		level: "project",
	});
	expect(resources.invocation).toEqual({ filePath, content });
	expect((await load(workspace, "other")).invocation).toEqual({
		filePath: join(workspace, ".agents", "skills", "other", "SKILL.md"),
		content: "---\ndescription: not requested\n---\nbody",
	});
	expect(await load(workspace)).not.toHaveProperty("invocation");
	expect(await load(workspace, "unknown")).not.toHaveProperty("invocation");
});

const writeBuiltinSkill = (dir: string, name: string, description: string) => {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\ndescription: ${description}\n---\nbody`);
};

it("merges three levels with project > user > builtin and tags each skill's level", async () => {
	const home = directory();
	const workspace = directory();
	const builtin = directory();
	writeBuiltinSkill(builtin, "shared", "builtin shared");
	writeBuiltinSkill(builtin, "only-builtin", "builtin only");
	writeSkill(home, "shared", "user shared");
	writeSkill(home, "only-user", "user only");
	writeSkill(workspace, "shared", "project shared");

	const resources = await createResourceLoader(home, undefined, { builtinDir: builtin })(workspace);
	const byName = new Map(resources.skills.map((s) => [s.name, s]));
	expect(byName.get("shared")?.description).toBe("project shared");
	expect(byName.get("shared")?.level).toBe("project");
	expect(byName.get("only-user")?.level).toBe("user");
	expect(byName.get("only-builtin")?.level).toBe("builtin");

	writeSkill(home, "only-builtin", "user override");
	const overridden = await createResourceLoader(home, undefined, { builtinDir: builtin })(workspace);
	expect(overridden.skills.find((s) => s.name === "only-builtin")?.level).toBe("user");
});

it("treats a missing builtin directory as empty without diagnostics", async () => {
	const home = directory();
	const workspace = directory();
	writeSkill(workspace, "proj", "project only");
	const diagnostics: { path: string; message: string }[] = [];
	const missing = join(directory(), "no-such-builtin-dir");
	const resources = await createResourceLoader(home, (d) => diagnostics.push(d), { builtinDir: missing })(workspace);
	expect(resources.skills.map((s) => s.name)).toEqual(["proj"]);
	expect(diagnostics).toEqual([]);
});

it("expands an explicitly invoked builtin skill from the builtin level", async () => {
	const home = directory();
	const workspace = directory();
	const builtin = directory();
	writeBuiltinSkill(builtin, "ship", "builtin ship");
	const resources = await createResourceLoader(home, undefined, { builtinDir: builtin })(workspace, "ship");
	expect(resources.invocation).toEqual({
		filePath: join(builtin, "ship", "SKILL.md"),
		content: "---\ndescription: builtin ship\n---\nbody",
	});
	expect(resources.skills.find((s) => s.name === "ship")?.level).toBe("builtin");
});

it("scanSkillsByLevel returns unmerged duplicates tagged per level", async () => {
	const home = directory();
	const workspace = directory();
	const builtin = directory();
	writeBuiltinSkill(builtin, "dup", "builtin dup");
	writeSkill(home, "dup", "user dup");
	writeSkill(workspace, "dup", "project dup");
	writeSkill(workspace, "solo", "project solo");

	const { scanSkillsByLevel } = await import("../src/prompt/resources.ts");
	const skills = await scanSkillsByLevel(workspace, home, builtin);
	const dups = skills.filter((s) => s.name === "dup");
	expect(dups.map((s) => [s.level, s.description])).toEqual([
		["project", "project dup"],
		["user", "user dup"],
		["builtin", "builtin dup"],
	]);
	expect(skills.find((s) => s.name === "solo")?.level).toBe("project");
});

it("strips a leading UTF-8 BOM from AGENTS.md and SKILL.md", async () => {
	const home = directory();
	const bomWorkspace = directory();
	const plainWorkspace = directory();
	writeFileSync(join(bomWorkspace, "AGENTS.md"), "\uFEFFproject rules");
	for (const [dir, bom] of [
		[bomWorkspace, "\uFEFF"],
		[plainWorkspace, ""],
	] as const) {
		const skillDir = join(dir, ".agents", "skills", "pdf");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), `${bom}---\ndescription: Read PDFs\n---\nbody`);
	}
	const load = createResourceLoader(home, undefined, { builtinDir: null });
	const withBom = await load(bomWorkspace);
	const plain = await load(plainWorkspace);
	expect(withBom.contextFiles.map((f) => f.content)).toEqual(["project rules"]);
	expect(withBom.contextFiles[0]!.content.includes("\uFEFF")).toBe(false);
	expect(withBom.skills.map((s) => [s.name, s.description])).toEqual(plain.skills.map((s) => [s.name, s.description]));
	expect(withBom.skills[0]!.description).toBe("Read PDFs");
});
