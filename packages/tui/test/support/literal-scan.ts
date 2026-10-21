import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseSync } from "rolldown/utils";

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;
// Prose-like English: a word of two or more letters followed by whitespace and another word.
const PROSE = /[A-Za-z]{2,}[ \t\n]+[A-Za-z]/;

export type LiteralFinding = { file: string; line: number; kind: "cjk" | "english"; text: string };

type Node = { type?: string; start?: number; [key: string]: unknown };

/** `.ts` sources under `root`, relative to it, skipping declaration files. */
export function listSources(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(relative(root, path));
		}
	};
	walk(root);
	return out.sort();
}

const MODULE_SPECIFIER_PARENTS = new Set(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"]);

/** CJK characters and prose-like English in string and template literals; comments are not AST nodes. */
export function scanLiterals(file: string, source: string): LiteralFinding[] {
	const result = parseSync(file, source);
	const findings: LiteralFinding[] = [];
	const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
	const report = (node: Node, text: unknown) => {
		if (typeof text !== "string") return;
		const kind = CJK.test(text) ? "cjk" : PROSE.test(text) ? "english" : null;
		if (kind) findings.push({ file, line: lineOf(node.start ?? 0), kind, text: text.trim().slice(0, 60) });
	};
	const visit = (value: unknown, parent?: Node) => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item, parent);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as Node;
		if (node.type === "Literal" && typeof node.value === "string") {
			if (!MODULE_SPECIFIER_PARENTS.has(parent?.type ?? "")) report(node, node.value);
		} else if (node.type === "TemplateElement") report(node, (node.value as { raw?: string }).raw);
		for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child, node);
	};
	visit(result.program);
	return findings;
}

export function scanDirectory(root: string): LiteralFinding[] {
	return listSources(root).flatMap((file) => scanLiterals(file, readFileSync(join(root, file), "utf8")));
}
