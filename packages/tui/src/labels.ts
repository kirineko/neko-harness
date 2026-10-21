/** Product language is English; conversation and tool payloads are never translated. */

import type { SlashCommand } from "@earendil-works/pi-tui";
import { shortcutHints } from "./components/shortcut-hints.ts";

export const commands: SlashCommand[] = [
	{ name: "help", description: "Show keyboard shortcuts and commands" },
	{ name: "version", description: "View versions and check for updates" },
	{ name: "compact", description: "Compact context (/compact optional instructions)" },
	{ name: "copy", description: "Copy the last assistant response" },
	{ name: "export", description: "Export session (/export path.md|.html|.json [--thinking])" },
	{ name: "exit", description: "Exit neko TUI" },
	{ name: "new", description: "Create a new session" },
	{ name: "sessions", description: "Switch or create a session" },
	{ name: "login", description: "Manage model providers and API keys" },
	{ name: "model", description: "Choose a model" },
	{ name: "agents", description: "View agent tasks and activity" },
	{ name: "jobs", description: "View background jobs" },
	{ name: "todos", description: "View the assistant's todo list" },
	{ name: "question", description: "Answer the assistant's question (Ctrl+O)" },
	{ name: "plan", description: "Toggle plan mode, or review the plan awaiting approval (Shift+Tab)" },
	{ name: "search", description: "Choose the web search provider (Tavily/DeepSeek); K sets its key" },
	{ name: "context", description: "Tune context compaction and tool result pruning" },
	{ name: "theme", description: "Choose color theme (auto/light/dark)" },
	{ name: "think", description: "Set thinking level (/think high)" },
	{ name: "fork", description: "Fork this session" },
	{ name: "archive", description: "Archive this session" },
	{ name: "skills", description: "Browse and install skills from the market" },
];
export const labels = {
	ready: "Ready",
	connecting: "Connecting...",
	loading: "Loading...",
	applying: "Applying...",
	noResults: "No results",
	get close() {
		return shortcutHints(["Esc", "Close"]);
	},
	get retry() {
		return shortcutHints(["Enter", "Retry"], ["Esc", "Close"]);
	},
	get select() {
		return shortcutHints(["↑↓", "Select"], ["Enter", "Open"], ["Esc", "Close"]);
	},
	idleHints: "Enter Send · /help Keys",
	busyHints: "Enter Queue · Esc Stop",
	idleCompact: "Enter Send · /help Keys",
	busyCompact: "Enter Queue · Esc Stop",
};
