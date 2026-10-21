import type { NekoSkillInfo } from "@neko-harness/core";

export const isCommandQuery = (text: string): boolean => /^\/[^\s]*$/.test(text);

/** `plan`: the gateway supports plan mode; without it `/plan` is not offered. */
export function commandSuggestions(text: string, skills: readonly NekoSkillInfo[], options: { plan?: boolean } = {}) {
	const query = isCommandQuery(text) ? text : "/";
	return [
		{ key: "compact", label: "/compact", description: "压缩上下文（可附加要求）" },
		...(options.plan === true
			? [{ key: "plan", label: "/plan", description: "切换规划模式（只读调研并提交计划，批准后执行）" }]
			: []),
		...skills.map((skill) => ({
			key: `skill:${skill.name}`,
			label: `/skill:${skill.name}`,
			description: skill.description,
			...(skill.level === "builtin" ? { badge: "内置" } : {}),
		})),
	].filter((item) => item.label.startsWith(query));
}
