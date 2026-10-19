import { type ConversationId, defineExtension, type PromptInput, section } from "@earendil-works/pi-durable";
import { ROLE_PROMPTS, SUBAGENT_DELIVERY, SubagentDoc } from "../subagents.ts";
import type { PromptResources } from "./resources.ts";
import { escapeXml, formatSkillsForPrompt } from "./skills.ts";

/** Section order; empty sections are omitted. Text carries its own tags (`tag: false`). */
const KEYS = ["preamble", "rules", "project_context", "skills", "cwd"] as const;

const PREAMBLE =
	"You are an expert coding assistant operating inside neko, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/** Rules contributed per tool, in the spirit of pi's promptGuidelines. */
const TOOL_GUIDELINES: Record<string, readonly string[]> = {
	subagent: [
		"Delegate only independent, sufficiently scoped work when isolation or parallelism helps. Handle simple tasks directly. Pass necessary context and user constraints; research-only requests must not become coding tasks. For related follow-up work, list and continue a suitable idle subagent using its stable agentId; busy means no task was accepted. Do not change its role. Verify and integrate reports. Do not modify files concurrently with a coder assigned those files.",
	],
	find_files: [
		"Use find_files to discover files; query is a literal substring. Narrow the directory when results are partial.",
	],
	search_text: [
		"Use search_text for literal text search and read for surrounding evidence. Partial results do not prove absence.",
	],
	read: ["Use read to examine files instead of cat or sed."],
	write: ["Use write only for new files or complete rewrites."],
	edit: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
	bash: ["Use bash for file operations like ls, rg, find"],
	job: [
		'Use job {action:"start", command, title?, timeout?} for long-running commands (dev servers, watchers, long builds or tests) instead of bash, which would block. Jobs have no stdin. start returns within 2 seconds, with the early result if the command already ended; a job that ends later reports back to you automatically, so do not poll. Read new output with {action:"output", jobId, since?} using the offset from the previous call, list jobs with {action:"list"}, end one with {action:"stop", jobId}. Run short commands with bash.',
	],

	web_search: ["Use web_search for current information from the internet instead of guessing."],
	web_extract: ["Use web_extract to read the full content of a web page when you have its URL."],
	todo: [
		'Use todo for multi-step work: {action:"list"} reads the saved list, {action:"replace", items:[{id, text, status}]} overwrites the whole ordered list (status pending, in_progress or completed; [] clears it). Keep a short list and update it as you go, keep an item\'s id when you update the same task, and mark it completed only after the work is actually done. If you are unsure what the list holds (for example after the context was compacted), read it with list first instead of guessing or creating a second list. Do not create a list for simple questions or one-step tasks.',
	],
	ask_user: [
		"Use ask_user {question, options?: [{id, label, description?, recommended?}], multiple?} only when you need a decision or information you cannot determine yourself from the code, the environment or a reasonable assumption; do not ask about things you can find out. Keep the question short and self-contained. Make options short, distinct and understandable on their own, mark a clear preference with recommended, and set multiple: true only when several options may apply (it needs at least 2 options). The user can always type text instead of or in addition to choosing, or skip. The call returns when the user answers or skips; do not poll. A skip is not consent or a preference: continue on your best judgment, state the assumptions you make, and do not ask the same question again unless circumstances change. Independent questions may be asked in one turn and are shown one at a time; ask dependent ones in separate turns. Never ask for passwords, API keys or other secrets. An answer is not approval to run a command and never widens tool permissions.",
	],
};

const GENERIC_RULES = ["Be concise in your responses", "Show file paths clearly when working with files"];

const WINDOWS_SHELL_RULE =
	"On Windows, commands run in Git Bash (not PowerShell, cmd or WSL); write paths with forward slashes, e.g. D:/code or /d/code.";

const toolRules = (name: string, platform: NodeJS.Platform): readonly string[] => {
	const rules = TOOL_GUIDELINES[name] ?? [];
	return platform === "win32" && (name === "bash" || name === "job") ? [...rules, WINDOWS_SHELL_RULE] : rules;
};

const buildRules = (toolNames: readonly string[], platform: NodeJS.Platform): string => {
	const rules: string[] = [];
	const seen = new Set<string>();
	for (const rule of [...toolNames.flatMap((name) => toolRules(name, platform)), ...GENERIC_RULES]) {
		if (seen.has(rule)) continue;
		seen.add(rule);
		rules.push(`- ${rule}`);
	}
	return rules.join("\n");
};

const renderProjectContext = (files: PromptResources["contextFiles"]): string | undefined =>
	files.length === 0
		? undefined
		: [
				"Project-specific instructions and guidelines:",
				...files.map(
					({ path, content }) =>
						`<project_instructions path="${escapeXml(path)}">\n${content}\n</project_instructions>`,
				),
			].join("\n\n");

/** Five ordered sections share one build per request and the conversation's placement-selected resource snapshot. */
export const createNekoPrompt = (
	loadResources: (id: ConversationId, workspace: string) => Promise<PromptResources>,
	platform: NodeJS.Platform = process.platform,
) => {
	const built = new WeakMap<PromptInput, Promise<Record<string, string | undefined>>>();
	const build = async (
		input: PromptInput,
		context: import("@earendil-works/chord").Context,
	): Promise<Record<string, string | undefined>> => {
		const cwd = input.agent.cwd;
		const role = (await input.read.snapshot(SubagentDoc, input.conversationId, context))?.role;
		const resources = cwd ? await loadResources(input.conversationId, cwd) : { contextFiles: [], skills: [] };
		const sections: Record<string, string | undefined> = {
			preamble: role ? ROLE_PROMPTS[role] + SUBAGENT_DELIVERY : PREAMBLE,
			rules: buildRules(
				input.agent.tools.map((tool) => tool.name),
				platform,
			),
			project_context: renderProjectContext(resources.contextFiles),
			skills: formatSkillsForPrompt(resources.skills) || undefined,
			cwd: cwd?.replace(/\\/g, "/"),
		};
		return sections;
	};
	return defineExtension({
		name: "neko-prompt",
		sections: KEYS.map((key) =>
			section(
				key,
				async (input, context) => {
					let pending = built.get(input);
					if (!pending) {
						pending = build(input, context);
						built.set(input, pending);
					}
					const text = (await pending)[key];
					if (text === undefined) return undefined;
					return key === "preamble" ? text : `<${key}>\n${text}\n</${key}>`;
				},
				{ tag: false },
			),
		),
	});
};
