import { readFileSync } from "node:fs";

export type ProtectedTermKind = "command" | "cli" | "env" | "config" | "key" | "code" | "tool" | "product" | "tech";

export interface ProtectedTerm {
	term: string;
	kind: ProtectedTermKind;
	/** `false` for words that are also ordinary English; excluded from the automatic zh/en parity check. */
	auto?: boolean;
}

// Read at runtime: the JSON is shared with the Dart tests, and Node16 modules cannot import JSON without attributes.
const data = JSON.parse(readFileSync(new URL("./protected-terms.json", import.meta.url), "utf8")) as {
	terms: ProtectedTerm[];
};

export const PROTECTED_TERMS: readonly ProtectedTerm[] = data.terms;

const WORD = "A-Za-z0-9_";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const matchers = PROTECTED_TERMS.map((entry) => {
	const last = entry.term.at(-1) ?? "";
	const after = new RegExp(`[${WORD}]`).test(last) ? `(?![${WORD}-])` : "";
	return { entry, pattern: new RegExp(`(?<![${WORD}])${escapeRegExp(entry.term)}${after}`) };
});

/**
 * Protected terms present in `text` (case-sensitive, word-bounded), sorted and unique. Terms that are also ordinary
 * English words are skipped unless `includeAmbiguous` is set.
 */
export function findProtectedTerms(text: string, options: { includeAmbiguous?: boolean } = {}): string[] {
	const found = new Set<string>();
	for (const { entry, pattern } of matchers) {
		if (entry.auto === false && options.includeAmbiguous !== true) continue;
		if (pattern.test(text)) found.add(entry.term);
	}
	return [...found].sort();
}
