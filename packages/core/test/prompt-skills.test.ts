import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { formatSkillsForPrompt, mergeSkills, parseSkillFile, scanSkillsDir } from "../src/prompt/skills.ts";

const dirs: string[] = [];
function directory() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-skills-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

function skill(dir: string, name: string, content: string) {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), content);
}

it("parses frontmatter with name/description and disable-model-invocation", () => {
	const parsed = parseSkillFile(
		"---\nname: pdf\ndescription: Read PDFs\ndisable-model-invocation: true\n---\nbody",
		"/x/pdf/SKILL.md",
	);
	expect(parsed).toEqual({
		name: "pdf",
		description: "Read PDFs",
		filePath: "/x/pdf/SKILL.md",
		disableModelInvocation: true,
	});
});

it("falls back to the directory name and skips missing or empty descriptions", () => {
	expect(parseSkillFile("---\ndescription: Works\n---\nbody", "/x/backup/SKILL.md")?.name).toBe("backup");
	expect(parseSkillFile("no frontmatter at all", "/x/a/SKILL.md")).toBeNull();
	expect(parseSkillFile('---\ndescription: ""\n---\nbody', "/x/b/SKILL.md")).toBeNull();
	expect(parseSkillFile(`---\ndescription: ${"x".repeat(1025)}\n---\nbody`, "/x/c/SKILL.md")).toBeNull();
	expect(parseSkillFile("---\n: bad yaml: [\n---\nbody", "/x/d/SKILL.md")).toBeNull();
});

it("scans first-level subdirectories and captures only successfully parsed skills", async () => {
	const dir = directory();
	skill(dir, "good", "---\ndescription: Good skill\n---\nbody");
	skill(dir, "broken", "no frontmatter");
	writeFileSync(join(dir, "loose.md"), "---\ndescription: Not in a directory\n---\n");
	mkdirSync(join(dir, "empty"));
	const captured: { name: string; content: string }[] = [];
	const skills = await scanSkillsDir(dir, undefined, (skill, content) => captured.push({ name: skill.name, content }));
	expect(skills.map((s) => s.name)).toEqual(["good"]);
	expect(skills[0]!.filePath).toBe(join(dir, "good", "SKILL.md"));
	expect(captured).toEqual([{ name: "good", content: "---\ndescription: Good skill\n---\nbody" }]);
	expect(await scanSkillsDir(join(dir, "missing"))).toEqual([]);
});

it("sorts each directory by UTF-16 and preserves the user position of project overrides", async () => {
	const userDir = directory();
	const projectDir = directory();
	for (const name of ["Ω-user", "a-user", "Z-user"]) {
		skill(userDir, name, `---\ndescription: user ${name}\n---\nbody`);
	}
	skill(projectDir, "я-project", "---\ndescription: project only\n---\nbody");
	skill(projectDir, "b-project", "---\nname: a-user\ndescription: project override\n---\nbody");
	skill(projectDir, "A-project", "---\ndescription: project first\n---\nbody");

	const user = await scanSkillsDir(userDir);
	const project = await scanSkillsDir(projectDir);
	expect(user.map((s) => s.name)).toEqual(["Z-user", "a-user", "Ω-user"]);
	expect(project.map((s) => s.name)).toEqual(["A-project", "a-user", "я-project"]);
	const merged = mergeSkills([user, project]);
	expect(merged.map((s) => s.name)).toEqual(["Z-user", "a-user", "Ω-user", "A-project", "я-project"]);
	expect(merged[1]?.description).toBe("project override");
	expect(merged[1]?.filePath).toBe(join(projectDir, "b-project", "SKILL.md"));
});

it("formats metadata only, escapes XML, and hides disabled skills", () => {
	const text = formatSkillsForPrompt([
		{ name: "pdf", description: "Read <PDFs> & more", filePath: "/skills/pdf/SKILL.md", disableModelInvocation: false },
		{ name: "hidden", description: "nope", filePath: "/skills/hidden/SKILL.md", disableModelInvocation: true },
	]);
	expect(text).toContain("<available_skills>");
	expect(text).toContain("<name>pdf</name>");
	expect(text).toContain("<description>Read &lt;PDFs&gt; &amp; more</description>");
	expect(text).toContain("<location>/skills/pdf/SKILL.md</location>");
	expect(text).not.toContain("hidden");
	expect(formatSkillsForPrompt([])).toBe("");
});

it("rejects uncallable names with diagnostics but preserves namespaced skills", () => {
	const messages: string[] = [];
	for (const name of ["my skill", "my\tskill", "my\nskill", "my\u0000skill"]) {
		const skill = parseSkillFile(
			`---\nname: ${JSON.stringify(name)}\ndescription: demo\n---\nbody`,
			"/x/SKILL.md",
			(d) => messages.push(d.message),
		);
		expect(skill).toBeNull();
	}
	expect(messages).toHaveLength(4);
	expect(parseSkillFile("---\nname: plugin:task\ndescription: demo\n---\nbody", "/x/SKILL.md")?.name).toBe(
		"plugin:task",
	);
});
