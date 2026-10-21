import { describe, expect, it } from "bun:test";
import { findProtectedTerms, PROTECTED_TERMS } from "../src/i18n/protected-terms.ts";

describe("protected terms", () => {
	it("has well-formed, unique entries", () => {
		const kinds = new Set(["command", "cli", "env", "config", "key", "code", "tool", "product", "tech"]);
		expect(PROTECTED_TERMS.length).toBeGreaterThan(50);
		for (const entry of PROTECTED_TERMS) {
			expect(entry.term.length).toBeGreaterThan(0);
			expect(kinds.has(entry.kind)).toBe(true);
		}
		expect(new Set(PROTECTED_TERMS.map((entry) => entry.term)).size).toBe(PROTECTED_TERMS.length);
	});

	it("matches case-sensitively on word boundaries", () => {
		expect(findProtectedTerms("运行 neko update 后重启")).toEqual(["neko", "neko update"]);
		expect(findProtectedTerms("Use /plan or /compact")).toEqual(["/compact", "/plan"]);
		expect(findProtectedTerms("a/plan")).toEqual([]);
		expect(findProtectedTerms("/sessions")).toEqual(["/sessions"]);
		expect(findProtectedTerms("Bash 审批 / Bash approval")).toEqual(["Bash"]);
		expect(findProtectedTerms("keylessly")).toEqual([]);
	});

	it("skips words that are ordinary English unless asked", () => {
		expect(findProtectedTerms("Edit the file, write a note")).toEqual([]);
		expect(findProtectedTerms("edit / write 工具", { includeAmbiguous: true })).toEqual(["edit", "write"]);
	});

	it("detects keys, env vars and error codes", () => {
		expect(findProtectedTerms("Press Shift+Tab; set NEKO_LANG; PLAN_BUSY: wait")).toEqual([
			"NEKO_LANG",
			"PLAN_BUSY",
			"Shift+Tab",
		]);
		expect(findProtectedTerms("Alt+↑ 选择")).toEqual(["Alt+↑"]);
	});
});
