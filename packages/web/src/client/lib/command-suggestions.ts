import type { NekoSkillInfo } from "@neko-harness/core";
import { getT } from "./i18n/index.ts";

export const isCommandQuery = (text: string): boolean => /^\/[^\s]*$/.test(text);

/** `plan`: the gateway supports plan mode; without it `/plan` is not offered. */
export function commandSuggestions(text: string, skills: readonly NekoSkillInfo[], options: { plan?: boolean } = {}) {
	const query = isCommandQuery(text) ? text : "/";
	const t = getT();
	return [
		{ key: "compact", label: "/compact", description: t("command.compact") },
		...(options.plan === true ? [{ key: "plan", label: "/plan", description: t("command.plan") }] : []),
		...skills.map((skill) => ({
			key: `skill:${skill.name}`,
			label: `/skill:${skill.name}`,
			description: skill.description,
			...(skill.level === "builtin" ? { badge: t("command.builtin") } : {}),
		})),
	].filter((item) => item.label.startsWith(query));
}
