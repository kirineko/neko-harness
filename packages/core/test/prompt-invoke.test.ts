import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { expandSkillCommand } from "../src/prompt/invoke.ts";
import { createResourceLoader } from "../src/prompt/resources.ts";
import { formatSkillsForPrompt, type Skill } from "../src/prompt/skills.ts";
import type { SkillInvocation } from "../src/skill-invocation.ts";

const dirs: string[] = [];
function directory() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-invoke-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

const read = (path: string) => readFile(path, "utf8");

it("expands a known skill into a skill block with args appended", async () => {
	const dir = directory();
	const filePath = join(dir, "pdf", "SKILL.md");
	mkdirSync(join(dir, "pdf"), { recursive: true });
	writeFileSync(filePath, "---\ndescription: Read PDFs\n---\nDo the PDF thing.\n");
	const skills: Skill[] = [{ name: "pdf", description: "Read PDFs", filePath, disableModelInvocation: false }];

	const expanded = await expandSkillCommand("/skill:pdf summarize this", skills, read);
	expect(expanded).toContain(`<skill name="pdf" location="${filePath}">`);
	expect(expanded).toContain(join(dir, "pdf"));
	expect(expanded).toContain("Do the PDF thing.");
	expect(expanded).not.toContain("description: Read PDFs");
	expect(expanded.endsWith("</skill>\n\nsummarize this")).toBe(true);
	const bare = await expandSkillCommand("/skill:pdf", skills, read);
	expect(bare).toContain("Do the PDF thing.");
	expect(bare.endsWith("</skill>")).toBe(true);
});

it("passes through non-commands, unknown skills, and unreadable files", async () => {
	const skills: Skill[] = [
		{ name: "pdf", description: "Read PDFs", filePath: "/missing/SKILL.md", disableModelInvocation: false },
		{ name: "hidden", description: "h", filePath: "/missing/SKILL.md", disableModelInvocation: true },
	];
	expect(await expandSkillCommand("hello", skills, read)).toBe("hello");
	expect(await expandSkillCommand("/skill:nope hi", skills, read)).toBe("/skill:nope hi");
	expect(await expandSkillCommand("/compact", skills, read)).toBe("/compact");
	// Unreadable file passes through unchanged.
	expect(await expandSkillCommand("/skill:pdf", skills, read)).toBe("/skill:pdf");
	// disable-model-invocation only hides the skill from the prompt, not from explicit invocation;
	// with a readable file it expands like any other skill.
	const dir = directory();
	const filePath = join(dir, "hidden", "SKILL.md");
	mkdirSync(join(dir, "hidden"), { recursive: true });
	writeFileSync(filePath, "---\ndescription: h\n---\nsecret body");
	const expanded = await expandSkillCommand("/skill:hidden", [{ ...skills[1]!, filePath }], read);
	expect(expanded).toContain("secret body");
});

it("escapes skill metadata in XML attributes", async () => {
	const skills: Skill[] = [
		{ name: 'a"b', description: "test", filePath: '/a&b/"test"/SKILL.md', disableModelInvocation: false },
	];
	const output = await expandSkillCommand('/skill:a"b args', skills, async () => "body");
	expect(output).toContain('name="a&quot;b" location="/a&amp;b/&quot;test&quot;/SKILL.md"');
	expect(output.endsWith("</skill>\n\nargs")).toBe(true);
});

it("reports unreadable known skills but passes unknown commands through silently", async () => {
	const reports: string[] = [];
	const skills: Skill[] = [
		{ name: "known", description: "demo", filePath: "/x/SKILL.md", disableModelInvocation: false },
	];
	const read = async (): Promise<string> => {
		throw new Error("private file contents");
	};
	const report = (d: { message: string }) => reports.push(d.message);
	expect(await expandSkillCommand("/skill:known args", skills, read, report)).toBe("/skill:known args");
	expect(reports).toHaveLength(1);
	expect(reports[0]).not.toContain("private file contents");
	await expandSkillCommand("/skill:unknown", skills, read, report);
	expect(reports).toHaveLength(1);
});

it("keeps scanned metadata and invocation body together when the file changes before expansion", async () => {
	const home = directory();
	const workspace = directory();
	const skillDir = join(workspace, ".agents", "skills", "pdf-directory");
	mkdirSync(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	const oldContent = "---\nname: pdf\ndescription: Original description\n---\nOriginal instructions.";
	const newContent = "---\nname: pdf\ndescription: Revised description\n---\nRevised instructions.";
	writeFileSync(filePath, oldContent);
	const load = createResourceLoader(home, undefined, { builtinDir: null });
	const scanned = await load(workspace, "pdf");

	// Deterministic boundary: the scan has returned before this mutation and any expansion.
	writeFileSync(filePath, newContent);
	const expanded = await expandSkillCommand(
		"/skill:pdf summarize",
		scanned.skills,
		async () => scanned.invocation!.content,
	);
	const metadata = formatSkillsForPrompt(scanned.skills);
	expect(metadata).toContain("<description>Original description</description>");
	expect(metadata).not.toContain("Revised description");
	expect(expanded).toContain("Original instructions.");
	expect(expanded).not.toContain("Revised instructions.");
	expect(expanded).not.toContain("description:");
	expect(expanded.endsWith("</skill>\n\nsummarize")).toBe(true);

	const refreshed = await load(workspace, "pdf");
	const nextExpanded = await expandSkillCommand(
		"/skill:pdf",
		refreshed.skills,
		async () => refreshed.invocation!.content,
	);
	const nextMetadata = formatSkillsForPrompt(refreshed.skills);
	expect(nextMetadata).toContain("<description>Revised description</description>");
	expect(nextMetadata).not.toContain("Original description");
	expect(nextExpanded).toContain("Revised instructions.");
	expect(nextExpanded).not.toContain("Original instructions.");
});

it("produces UI metadata from the same read, preserving literal XML in body and args", async () => {
	const skills: Skill[] = [
		{ name: 'a"b', description: "test", filePath: "/x/<y>/SKILL.md", disableModelInvocation: false },
	];
	let data: SkillInvocation | undefined,
		reads = 0;
	const text = await expandSkillCommand(
		'/skill:a"b args </skill>',
		skills,
		async () => {
			reads++;
			return "body </skill> inline";
		},
		undefined,
		(value) => {
			data = value;
		},
	);
	expect(reads).toBe(1);
	expect(data).toMatchObject({ name: 'a"b', location: "/x/<y>/SKILL.md", args: "args </skill>" });
	expect(data?.body).toContain("body </skill> inline");
	expect(text).toContain('name="a&quot;b"');
	data = undefined;
	await expandSkillCommand('<skill name="x" location="/x">body</skill>', skills, read, undefined, (value) => {
		data = value;
	});
	expect(data).toBeUndefined();
});
