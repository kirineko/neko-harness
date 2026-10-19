import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMissing, type PromptDiagnostic, type ReportPromptDiagnostic, warnPromptDiagnostic } from "./diagnostics.ts";
import { type LeveledSkill, mergeSkills, type Skill, type SkillLevel, scanSkillsDir } from "./skills.ts";

export type PromptResources = {
	/** AGENTS.md files in injection order: user level first, then workspace level. */
	readonly contextFiles: readonly { path: string; content: string }[];
	readonly skills: readonly LeveledSkill[];
	/** Same-read text of the explicitly requested winning skill; not part of a system snapshot. */
	readonly invocation?: { readonly filePath: string; readonly content: string };
};

export const userAgentsFile = (home: string): string => join(home, ".agents", "AGENTS.md");
export const userSkillsDir = (home: string): string => join(home, ".agents", "skills");
export const workspaceAgentsFile = (workspace: string): string => join(workspace, "AGENTS.md");
export const workspaceSkillsDir = (workspace: string): string => join(workspace, ".agents", "skills");

/**
 * Builtin skills shipped with the harness. Probe candidate layouts, first hit wins:
 * `./skills/` — the bundled release, where this module is inlined into `dist/neko.js` /
 * `dist/gateway.js` and build-release copies skills to `dist/skills/`; then `../../skills/` —
 * source (`src/prompt/`) and per-package build (`dist/prompt/`) layouts, landing on
 * `<core>/skills/`. The marker file guards against an empty or stray directory winning.
 * Null when no layout provides builtin skills (callers then simply scan nothing).
 */
const resolveBuiltinSkillsDir = (): string | null => {
	for (const url of [new URL("./skills/", import.meta.url), new URL("../../skills/", import.meta.url)]) {
		const path = fileURLToPath(url);
		if (existsSync(join(path, "skill-creator", "SKILL.md"))) return path;
	}
	return null;
};

export const BUILTIN_SKILLS_DIR: string | null = resolveBuiltinSkillsDir();

const readResources = async (
	workspace: string,
	home: string,
	builtinDir: string | null,
	report: ReportPromptDiagnostic,
	invocationName?: string,
): Promise<PromptResources> => {
	const contextFiles: { path: string; content: string }[] = [];
	for (const path of [userAgentsFile(home), workspaceAgentsFile(workspace)]) {
		try {
			const content = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
			if (Buffer.byteLength(content, "utf8") > 64 * 1024)
				report({
					path,
					message:
						"Project instructions exceed 64 KiB; included in full. History compaction does not reduce this input.",
				});
			contextFiles.push({ path, content });
		} catch (error) {
			if (!isMissing(error)) report({ path, message: "Cannot read project instructions; skipped." });
		}
	}
	const candidates = invocationName === undefined ? undefined : new Map<string, string>();
	const capture = candidates
		? (skill: Skill, content: string) => {
				if (skill.name === invocationName) candidates.set(skill.filePath, content);
			}
		: undefined;
	const scan = async (dir: string, level: SkillLevel): Promise<LeveledSkill[]> =>
		(await scanSkillsDir(dir, report, capture)).map((skill) => ({ ...skill, level }));
	const [builtin, user, project] = await Promise.all([
		builtinDir === null ? Promise.resolve([]) : scan(builtinDir, "builtin"),
		scan(userSkillsDir(home), "user"),
		scan(workspaceSkillsDir(workspace), "project"),
	]);
	const skills = mergeSkills([builtin, user, project]);
	const winner = invocationName === undefined ? undefined : skills.find((skill) => skill.name === invocationName);
	if (winner && candidates) {
		const content = candidates.get(winner.filePath);
		if (content !== undefined) return { contextFiles, skills, invocation: { filePath: winner.filePath, content } };
	}
	return { contextFiles, skills };
};

/** Re-read each load, retaining body text only for an explicitly requested skill from that same scan. */
export const createResourceLoader = (
	home: string = homedir(),
	report: ReportPromptDiagnostic = warnPromptDiagnostic,
	options?: { readonly builtinDir?: string | null },
) => {
	const builtinDir = options?.builtinDir === undefined ? BUILTIN_SKILLS_DIR : options.builtinDir;
	// Between loads, remember diagnostics only, never file contents or stat fingerprints.
	const previous = new Map<string, Set<string>>();
	return async (workspace: string, invocationName?: string): Promise<PromptResources> => {
		const diagnostics: PromptDiagnostic[] = [];
		const resources = await readResources(workspace, home, builtinDir, (d) => diagnostics.push(d), invocationName);
		const known = previous.get(workspace);
		const current = new Set<string>();
		for (const diagnostic of diagnostics) {
			const key = JSON.stringify(diagnostic);
			if (!known?.has(key) && !current.has(key)) report(diagnostic);
			current.add(key);
		}
		if (current.size) previous.set(workspace, current);
		else previous.delete(workspace);
		return resources;
	};
};

/**
 * Scan all three skill levels WITHOUT merging (project, then user, then builtin), each tagged
 * with its level. Market/install UIs derive per-level install state and the active winner;
 * conversation prompts use createResourceLoader's merged view instead.
 */
export const scanSkillsByLevel = async (
	workspace: string,
	home: string = homedir(),
	builtinDir: string | null = BUILTIN_SKILLS_DIR,
	report: ReportPromptDiagnostic = warnPromptDiagnostic,
): Promise<LeveledSkill[]> => {
	const scan = async (dir: string, level: SkillLevel): Promise<LeveledSkill[]> =>
		(await scanSkillsDir(dir, report)).map((skill) => ({ ...skill, level }));
	const [builtin, user, project] = await Promise.all([
		builtinDir === null ? [] : scan(builtinDir, "builtin"),
		scan(userSkillsDir(home), "user"),
		scan(workspaceSkillsDir(workspace), "project"),
	]);
	return [...project, ...user, ...builtin];
};
