import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput } from "@earendil-works/pi-durable";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { createNekoPrompt } from "../src/prompt/prompt.ts";
import { createResourceLoader } from "../src/prompt/resources.ts";

const dirs: string[] = [];
function directory() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-prompt-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

const input = (cwd: string, tools: string[]): PromptInput =>
	({
		agent: { cwd, tools: tools.map((name) => ({ name })) },
		read: { snapshot: async () => ({ role: null, parentId: null }) },
	}) as unknown as PromptInput;

const renderAll = async (home: string, cwd: string, tools: string[]) => {
	const load = createResourceLoader(home, undefined, { builtinDir: null });
	const extension = createNekoPrompt((_id, workspace) => load(workspace));
	const out: Record<string, string | undefined> = {};
	const shared = input(cwd, tools);
	for (const s of extension.sections ?? []) out[s.key] = await s.render(shared, BACKGROUND_CONTEXT);
	return { keys: (extension.sections ?? []).map((s) => s.key), out };
};

it("renders five ordered sections, untagged preamble, tagged rest", async () => {
	const home = directory();
	const workspace = directory();
	const { keys, out } = await renderAll(home, workspace, ["read", "bash"]);
	expect(keys).toEqual(["preamble", "rules", "project_context", "skills", "cwd"]);
	expect(out.preamble).not.toContain("<preamble>");
	expect(out.rules).toMatch(/^<rules>\n/);
	expect(out.project_context).toBeUndefined();
	expect(out.skills).toBeUndefined();
	expect(out.cwd).toBe(`<cwd>\n${workspace.replaceAll("\\", "/")}\n</cwd>`);
});

it("renders project_context and skills when resources exist", async () => {
	const home = directory();
	const workspace = directory();
	mkdirSync(join(home, ".agents"), { recursive: true });
	writeFileSync(join(home, ".agents", "AGENTS.md"), "user rules");
	writeFileSync(join(workspace, "AGENTS.md"), "project rules");
	const skillDir = join(workspace, ".agents", "skills", "pdf");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: Read PDFs\n---\nbody");

	const { out } = await renderAll(home, workspace, ["read"]);
	expect(out.project_context).toContain(`<project_instructions path="${join(home, ".agents", "AGENTS.md")}">`);
	expect(out.project_context).toContain("user rules");
	expect(out.project_context).toContain("project rules");
	expect(out.skills).toContain("<available_skills>");
	expect(out.skills).toContain("<name>pdf</name>");
});

it("escapes instruction paths embedded in XML attributes", async () => {
	const extension = createNekoPrompt(async () => ({
		contextFiles: [{ path: '/project/"quoted"/AGENTS.md', content: "rules" }],
		skills: [],
	}));
	const shared = input("/project", ["read"]);
	const output = await Promise.all((extension.sections ?? []).map((s) => s.render(shared, BACKGROUND_CONTEXT)));
	expect(output.join("\n")).toContain('path="/project/&quot;quoted&quot;/AGENTS.md"');
});

it("adds todo and ask_user rules only for the tools that are enabled, keeping the five sections", async () => {
	const home = directory();
	const workspace = directory();
	const both = await renderAll(home, workspace, ["read", "todo", "ask_user"]);
	expect(both.keys).toEqual(["preamble", "rules", "project_context", "skills", "cwd"]);
	expect(both.out.rules).toContain('{action:"list"}');
	expect(both.out.rules).toContain('{action:"replace", items:[{id, text, status}]}');
	expect(both.out.rules).toContain("Do not create a list for simple questions");
	expect(both.out.rules).toContain("after the context was compacted");
	expect(both.out.rules).toContain(
		"ask_user {question, options?: [{id, label, description?, recommended?}], multiple?}",
	);
	expect(both.out.rules).toContain("A skip is not consent");
	expect(both.out.rules).toContain("do not poll");
	expect(both.out.rules).toContain("do not ask about things you can find out");
	expect(both.out.rules).toContain("Never ask for passwords, API keys or other secrets");
	expect(both.out.rules).toContain("never widens tool permissions");
	// The tool contract has no batch or form fields, so the rules must not invent them.
	expect(both.out.rules).not.toMatch(/\bquestions\s*:|JSON schema|\bbatch|\bform\b/i);
	const todoOnly = await renderAll(home, workspace, ["read", "todo"]);
	expect(todoOnly.out.rules).toContain("Use todo for multi-step work");
	expect(todoOnly.out.rules).not.toContain("ask_user");
	const none = await renderAll(home, workspace, ["read", "bash"]);
	expect(none.out.rules).not.toContain("todo");
	expect(none.out.rules).not.toContain("ask_user");
	expect(none.keys).toEqual(both.keys);
});

it("keeps the todo list body out of the system prompt", async () => {
	const home = directory();
	const workspace = directory();
	const { out } = await renderAll(home, workspace, ["read", "todo"]);
	expect(Object.values(out).join("\n")).not.toContain("revision");
});

it("adds the Git Bash rule on win32 only when bash or job is enabled, deterministically", async () => {
	const render = async (platform: NodeJS.Platform, tools: string[]) => {
		const extension = createNekoPrompt(async () => ({ contextFiles: [], skills: [] }), platform);
		const rules = (extension.sections ?? []).find((s) => s.key === "rules")!;
		return rules.render(input("/project", tools), BACKGROUND_CONTEXT);
	};
	const rule = "On Windows, commands run in Git Bash (not PowerShell, cmd or WSL)";
	const win = await render("win32", ["read", "bash", "job"]);
	expect(win).toContain(rule);
	expect(win?.split(rule).length).toBe(2);
	expect(await render("win32", ["read", "job"])).toContain(rule);
	expect(await render("darwin", ["read", "bash", "job"])).not.toContain(rule);
	expect(await render("linux", ["read", "bash", "job"])).not.toContain(rule);
	expect(await render("win32", ["read", "edit"])).not.toContain(rule);
	expect(await render("win32", ["read", "bash"])).toBe(await render("win32", ["read", "bash"]));
});
