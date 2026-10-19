import { parse } from "yaml";

export type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(content.replace(/^\uFEFF/, ""));
	const opening = /^---[ \t]*\n/.exec(normalized);
	if (!opening) return { yamlString: null, body: normalized };
	const rest = normalized.slice(opening[0].length);
	const closing = /^---[ \t]*(?:\n|$)/m.exec(rest);
	if (!closing) return { yamlString: null, body: normalized };
	return { yamlString: rest.slice(0, closing.index), body: rest.slice(closing.index + closing[0].length).trim() };
};

export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) return { frontmatter: {} as T, body };
	const parsed = parse(yamlString);
	if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed)))
		throw new Error("Frontmatter must be a YAML mapping.");
	return { frontmatter: (parsed ?? {}) as T, body };
};

export const stripFrontmatter = (content: string): string => extractFrontmatter(content).body;
