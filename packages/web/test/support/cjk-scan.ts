import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseSync } from "rolldown/utils";

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

export type CjkFinding = { file: string; line: number; kind: string; text: string };

type Node = { type?: string; start?: number; end?: number; [key: string]: unknown };

/** Source files under `root` (recursive), relative to it, `.ts`/`.tsx` only, skipping declaration files. */
export function listSources(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
				out.push(relative(root, path).split(sep).join("/"));
		}
	};
	walk(root);
	return out.sort();
}

/** CJK characters in string literals, template literals and JSX text; comments are not part of the AST nodes. */
export function scanCjk(file: string, source: string): CjkFinding[] {
	const result = parseSync(file, source);
	const findings: CjkFinding[] = [];
	const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
	const report = (node: Node, kind: string, text: unknown) => {
		if (typeof text === "string" && CJK.test(text)) {
			findings.push({ file, line: lineOf(node.start ?? 0), kind, text: text.trim().slice(0, 40) });
		}
	};
	const visit = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const node = value as Node;
		if (node.type === "Literal" && typeof node.value === "string") report(node, "string", node.value);
		else if (node.type === "TemplateElement") report(node, "template", (node.value as { raw?: string }).raw);
		else if (node.type === "JSXText") report(node, "jsx", node.value);
		for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
	};
	visit(result.program);
	return findings;
}

export function scanDirectory(root: string): CjkFinding[] {
	return listSources(root).flatMap((file) => scanCjk(file, readFileSync(join(root, file), "utf8")));
}
