import { afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	JOBS_UNSUPPORTED,
	PLAN_UNSUPPORTED,
	QUESTIONS_UNSUPPORTED,
	QUEUE_UNSUPPORTED,
	TODOS_UNSUPPORTED,
} from "@neko-harness/gateway/client-session";
import { localizeCoreText, localizeError, localizeStatus } from "../src/i18n/core-text.ts";
import { setLanguage, t } from "../src/i18n/index.ts";
import "./support/lang-en.ts";

type Sample = { id: string; text: string; params?: Record<string, string> };
const fixture = JSON.parse(
	readFileSync(new URL("../../core/test/fixtures/core-ui-strings.json", import.meta.url), "utf8"),
) as {
	status: Sample[];
	systemRows: Sample[];
	toolNotes: Sample[];
	errors: { code: string; text: string }[];
};

afterEach(() => setLanguage("en"));

const byId = (items: Sample[], id: string): Sample => {
	const item = items.find((entry) => entry.id === id);
	if (!item) throw new Error(`fixture entry missing: ${id}`);
	return item;
};

it("maps every status line of the core fixture and keeps parameters verbatim", () => {
	const thinking = byId(fixture.status, "thinking").text;
	const running = byId(fixture.status, "running");
	const retrying = byId(fixture.status, "retrying");

	expect(localizeStatus(thinking)).toBe("Thinking...");
	expect(localizeStatus(running.text)).toBe("Running bash...");
	expect(localizeStatus(retrying.text)).toBe("Retrying (attempt 2)...");

	setLanguage("zh");
	expect(localizeStatus(thinking)).toBe(t("core.status.thinking"));
	expect(localizeStatus(thinking)).not.toBe(thinking);
	expect(localizeStatus(running.text)).toBe(t("core.status.running", { tool: running.params?.tool ?? "" }));
	expect(localizeStatus(running.text)).toContain("bash");
	expect(localizeStatus(retrying.text)).toBe(t("core.status.retrying", { attempt: retrying.params?.attempt ?? "" }));
	expect(localizeStatus(retrying.text)).toContain("2");
	expect(localizeStatus("Running mcp__fs.read-file...")).toContain("mcp__fs.read-file");
});

it("maps system rows, tool notes and gateway notices in both languages", () => {
	const fixed = [
		byId(fixture.systemRows, "compacted").text,
		byId(fixture.systemRows, "newContext").text,
		byId(fixture.toolNotes, "notRun").text,
		JOBS_UNSUPPORTED,
		QUEUE_UNSUPPORTED,
		TODOS_UNSUPPORTED,
		QUESTIONS_UNSUPPORTED,
		PLAN_UNSUPPORTED,
	];
	for (const text of fixed) expect(localizeCoreText(text)).not.toBe("");
	expect(localizeCoreText("[context compacted]")).toBe(t("core.system.compacted"));
	expect(localizeCoreText("Not run: response interrupted.")).toBe(t("core.note.notRun"));
	setLanguage("zh");
	const zh = fixed.map((text) => localizeCoreText(text));
	expect(zh.every((text, index) => text !== fixed[index])).toBe(true);
	expect(zh.some((text) => /[\u4e00-\u9fff]/.test(text))).toBe(true);
	expect(localizeCoreText("[context compacted]")).toBe(t("core.system.compacted"));
	expect(localizeCoreText(JOBS_UNSUPPORTED)).toBe(t("core.unsupported.jobs"));
});

it("maps every error code of the core fixture, keeping the code prefix and the provider name", () => {
	for (const language of ["en", "zh"] as const) {
		setLanguage(language);
		for (const { code, text } of fixture.errors) {
			const mapped = localizeError(text);
			expect(mapped.startsWith(`${code}: `)).toBe(true);
			if (language === "zh") expect(mapped).not.toBe(text);
		}
	}
	const disabled = fixture.errors.find((e) => e.code === "PROVIDER_DISABLED")?.text ?? "";
	const keyRequired = fixture.errors.find((e) => e.code === "PROVIDER_KEY_REQUIRED")?.text ?? "";
	const busy = fixture.errors.find((e) => e.code === "PLAN_BUSY")?.text ?? "";
	expect(localizeError(disabled)).toContain("OpenRouter");
	expect(localizeError(keyRequired)).toContain("DeepSeek");
	setLanguage("en");
	expect(localizeError(disabled)).toBe(t("core.error.providerDisabled", { name: "OpenRouter" }));
	setLanguage("zh");
	expect(localizeError(disabled)).toBe(t("core.error.providerDisabled", { name: "OpenRouter" }));
	expect(localizeError(keyRequired)).toBe(t("core.error.providerKeyRequired", { name: "DeepSeek" }));
	expect(localizeError(busy)).toBe(t("core.error.planBusy"));
	expect(localizeError("PROVIDER_KEY_REQUIRED: Configure an OpenAI API key in /login or Web settings.")).toBe(
		t("core.error.providerKeyRequiredAn", { name: "OpenAI" }),
	);
});

it("returns the original text when nothing matches", () => {
	for (const language of ["en", "zh"] as const) {
		setLanguage(language);
		for (const text of ["", "plain", "Thinking... more", "任意中文", "[context compacted] extra"]) {
			expect(localizeStatus(text)).toBe(text);
			expect(localizeCoreText(text)).toBe(text);
		}
		for (const text of [
			"boom",
			"UNKNOWN_CODE: Something happened.",
			"PROVIDER_DISABLED: totally different wording",
			"PROVIDER_KEY_REQUIRED: unexpected",
			"lowercase: text",
		]) {
			expect(localizeError(text)).toBe(text);
		}
	}
});
