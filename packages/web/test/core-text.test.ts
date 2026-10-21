import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { localizeCoreError, localizeCoreText } from "../src/client/lib/i18n/core-text.ts";
import { translator } from "../src/client/lib/i18n/index.ts";

type Fixture = {
	status: { id: string; text: string; params?: Record<string, string> }[];
	systemRows: { id: string; text: string }[];
	toolNotes: { id: string; text: string }[];
	errors: { code: string; text: string }[];
};

const fixture = JSON.parse(
	readFileSync(new URL("../../core/test/fixtures/core-ui-strings.json", import.meta.url), "utf8"),
) as Fixture;
const zh = translator("zh");
const en = translator("en");
const byId = <T extends { id: string }>(items: T[], id: string): T => {
	const item = items.find((entry) => entry.id === id);
	if (!item) throw new Error(`fixture entry missing: ${id}`);
	return item;
};

it("maps every status line, system row and tool note of the core fixture, keeping params verbatim", () => {
	const thinking = byId(fixture.status, "thinking").text;
	const running = byId(fixture.status, "running");
	const retrying = byId(fixture.status, "retrying");
	const compacted = byId(fixture.systemRows, "compacted").text;
	const newContext = byId(fixture.systemRows, "newContext").text;
	const notRun = byId(fixture.toolNotes, "notRun").text;

	expect(localizeCoreText(thinking, zh)).toBe(zh("core.status.thinking"));
	expect(localizeCoreText(thinking, en)).toBe(en("core.status.thinking"));
	expect(localizeCoreText(running.text, zh)).toBe(zh("core.status.running", { tool: running.params?.tool ?? "" }));
	expect(localizeCoreText(running.text, en)).toBe("Running bash…");
	expect(localizeCoreText(retrying.text, zh)).toBe("重试中（第 2 次）…");
	expect(localizeCoreText(retrying.text, en)).toBe("Retrying (attempt 2)…");
	expect(localizeCoreText(compacted, zh)).toBe(zh("core.row.compacted"));
	expect(localizeCoreText(compacted, en)).toBe(en("core.row.compacted"));
	expect(localizeCoreText(newContext, zh)).toBe(zh("core.row.newContext"));
	expect(localizeCoreText(newContext, en)).toBe(en("core.row.newContext"));
	expect(localizeCoreText(notRun, zh)).toBe(zh("core.note.notRun"));
	expect(localizeCoreText(notRun, en)).toBe(en("core.note.notRun"));
});

it("keeps tool names with unusual characters intact", () => {
	expect(localizeCoreText("Running mcp__fs.read-file...", en)).toBe("Running mcp__fs.read-file…");
});

it("maps every error code of the core fixture and keeps the code prefix", () => {
	for (const { code, text } of fixture.errors) {
		for (const t of [zh, en]) {
			const mapped = localizeCoreError(text, t);
			expect(mapped.startsWith(`${code}: `)).toBe(true);
			expect(mapped).not.toBe(text);
		}
	}
	const disabled = byId(
		fixture.errors.map((e) => ({ ...e, id: e.code })),
		"PROVIDER_DISABLED",
	).text;
	expect(localizeCoreError(disabled, en)).toBe(en("core.error.providerDisabled", { provider: "OpenRouter" }));
	expect(localizeCoreError(disabled, zh)).toContain("OpenRouter");
	const keyRequired = fixture.errors.find((e) => e.code === "PROVIDER_KEY_REQUIRED")?.text ?? "";
	expect(localizeCoreError(keyRequired, zh)).toBe(zh("core.error.providerKeyRequired", { provider: "DeepSeek" }));
	const busy = fixture.errors.find((e) => e.code === "PLAN_BUSY")?.text ?? "";
	expect(localizeCoreError(busy, zh)).toBe(zh("core.error.planBusy"));
});

it("falls back to the original text when nothing matches", () => {
	for (const text of ["", "plain", "Thinking... more", "任意中文", "[context compacted] extra"]) {
		expect(localizeCoreText(text, en)).toBe(text);
		expect(localizeCoreText(text, zh)).toBe(text);
	}
	for (const text of [
		"boom",
		"UNKNOWN_CODE: Something happened.",
		"PROVIDER_DISABLED: totally different wording",
		"PROVIDER_KEY_REQUIRED: unexpected",
		"lowercase: text",
	]) {
		expect(localizeCoreError(text, en)).toBe(text);
		expect(localizeCoreError(text, zh)).toBe(text);
	}
});
