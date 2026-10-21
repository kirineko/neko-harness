/** Product text follows the interface language (see `./i18n`); conversation and tool payloads are never translated. */

import type { SlashCommand } from "@earendil-works/pi-tui";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { t } from "./i18n/index.ts";

/** Slash command list for the current language; rebuild it after a language switch. */
export const commands = (): SlashCommand[] => [
	{ name: "help", description: t("command.help") },
	{ name: "version", description: t("command.version") },
	{ name: "compact", description: t("command.compact") },
	{ name: "copy", description: t("command.copy") },
	{ name: "export", description: t("command.export") },
	{ name: "exit", description: t("command.exit") },
	{ name: "new", description: t("command.new") },
	{ name: "sessions", description: t("command.sessions") },
	{ name: "login", description: t("command.login") },
	{ name: "model", description: t("command.model") },
	{ name: "agents", description: t("command.agents") },
	{ name: "jobs", description: t("command.jobs") },
	{ name: "todos", description: t("command.todos") },
	{ name: "question", description: t("command.question") },
	{ name: "plan", description: t("command.plan") },
	{ name: "search", description: t("command.search") },
	{ name: "context", description: t("command.context") },
	{ name: "theme", description: t("command.theme") },
	{ name: "language", description: t("command.language") },
	{ name: "think", description: t("command.think") },
	{ name: "fork", description: t("command.fork") },
	{ name: "archive", description: t("command.archive") },
	{ name: "skills", description: t("command.skills") },
];
export const labels = {
	get ready() {
		return t("common.ready");
	},
	get connecting() {
		return t("common.connecting");
	},
	get loading() {
		return t("common.loading");
	},
	get applying() {
		return t("common.applying");
	},
	get noResults() {
		return t("common.noResults");
	},
	get close() {
		return shortcutHints(["Esc", t("action.close")]);
	},
	get retry() {
		return shortcutHints(["Enter", t("action.retry")], ["Esc", t("action.close")]);
	},
	get select() {
		return shortcutHints(["↑↓", t("action.select")], ["Enter", t("action.open")], ["Esc", t("action.close")]);
	},
	get idleHints() {
		return t("hint.idle");
	},
	get busyHints() {
		return t("hint.busy");
	},
	get idleCompact() {
		return t("hint.idle");
	},
	get busyCompact() {
		return t("hint.busy");
	},
};
