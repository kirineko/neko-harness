import { afterEach, expect, it } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { findProtectedTerms } from "@neko-harness/core/protected-terms";
import { APPLICATION_PROTOCOL, type UpdateState } from "../../core/src/application-version.ts";
import { contextEmpty, contextItems } from "../src/context-ui.ts";
import { helpLines } from "../src/help-ui.ts";
import { setLanguage, t } from "../src/i18n/index.ts";
import { jobsEmpty } from "../src/jobs-ui.ts";
import { commands } from "../src/labels.ts";
import { providerSendBlock } from "../src/provider-ui.ts";
import { searchEmpty } from "../src/search-ui.ts";
import { todosEmpty } from "../src/todos-ui.ts";
import { versionNotice, versionOverview } from "../src/version-ui.ts";
import "./support/lang-en.ts";

afterEach(() => setLanguage("en"));

const CJK = /[\u4e00-\u9fff]/;
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

it("shows the help panel in Chinese while commands, keys and tool names stay as they are", () => {
	setLanguage("zh");
	const text = plain(helpLines("darwin"));
	expect(text).toMatch(CJK);
	for (const command of commands()) {
		expect(text).toContain(`/${command.name}`);
		expect(command.description).toMatch(CJK);
	}
	for (const key of ["Enter", "Esc", "Ctrl+S", "Alt+↑", "Shift+Tab", "PgUp"]) expect(text).toContain(key);
	setLanguage("en");
	expect(plain(helpLines("darwin"))).not.toMatch(CJK);
});

it("keeps the /plan and /language command names in both languages", () => {
	for (const language of ["zh", "en"] as const) {
		setLanguage(language);
		const names = commands().map((command) => command.name);
		expect(names).toContain("plan");
		expect(names).toContain("language");
		expect(commands().find((command) => command.name === "plan")?.description).toBeTruthy();
	}
});

it("renders empty states, provider blocks and context rows in Chinese", () => {
	setLanguage("zh");
	for (const text of [jobsEmpty(), todosEmpty(), searchEmpty(), contextEmpty()]) expect(text).toMatch(CJK);
	const credentials = { statuses: { deepseek: { source: "none", enabled: true } } } as never;
	const block = providerSendBlock({ provider: "deepseek" }, credentials) ?? "";
	expect(block).toMatch(CJK);
	expect(block).toContain("/login");
	const items = contextItems({
		revision: 1,
		effective: {
			compaction: { enabled: true, triggerPercent: null, keepRecentTokens: 20000 },
			pruning: { enabled: false, triggerPercent: 35, keepRecent: 10, minChars: 4000, minSavePercent: 5 },
		},
		sources: {
			compaction: { enabled: "default", triggerPercent: "default", keepRecentTokens: "default" },
			pruning: {
				enabled: "default",
				triggerPercent: "default",
				keepRecent: "default",
				minChars: "default",
				minSavePercent: "default",
			},
		},
	} as never);
	expect(items.length).toBeGreaterThan(3);
	for (const item of items.filter((entry) => !entry.header)) expect(item.label).toMatch(CJK);
});

it("renders the version overview in Chinese and keeps the upgrade command verbatim", () => {
	const state: UpdateState = {
		runningVersion: "1.0.0",
		installedVersion: "1.0.0",
		protocolVersion: APPLICATION_PROTOCOL,
		checkState: "ok",
		latestVersion: "1.2.0",
		checkedAt: 1,
	};
	const options = { runningVersion: "1.0.0", platform: "darwin" as const };
	setLanguage("en");
	const en = versionNotice(state, "1.0.0", options);
	setLanguage("zh");
	const zh = versionNotice(state, "1.0.0", options);
	expect(zh).toMatch(CJK);
	expect(zh).not.toBe(en);
	expect(findProtectedTerms(zh)).toEqual(findProtectedTerms(en));
	expect(versionOverview(state, "1.0.0", options)).toMatch(CJK);
});

it("keeps protected terms in Chinese messages", () => {
	setLanguage("zh");
	expect(t("login.useLogin")).toContain("/login");
	expect(t("plan.modeOn")).toContain("/plan");
	expect(t("plan.modeOn")).toContain("Shift+Tab");
	expect(t("export.exists", { path: "a.md" })).toContain("a.md");
});
