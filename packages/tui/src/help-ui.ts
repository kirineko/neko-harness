import { getKeybindings, matchesKey, TUI_KEYBINDINGS, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PickerDetail } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { type PlainKey, t } from "./i18n/index.ts";
import { clipboardShortcutKey, runningInWsl } from "./image-input.ts";
import { commands } from "./labels.ts";
import { skipLabel } from "./question-dock.ts";
import { theme } from "./theme/index.ts";

const keyLabel = (key: string) =>
	key
		.split("+")
		.map(
			(part) => ({ escape: "Esc", pageUp: "PgUp", pageDown: "PgDn" })[part] ?? part[0]!.toUpperCase() + part.slice(1),
		)
		.join("+");

/** Pi's own binding descriptions are English; known ids are translated, unknown ones keep Pi's text. */
export const BINDING_KEYS: Readonly<Record<string, PlainKey>> = {
	"tui.editor.cursorUp": "help.binding.cursorUp",
	"tui.editor.cursorDown": "help.binding.cursorDown",
	"tui.editor.historyPrevious": "help.binding.historyPrevious",
	"tui.editor.historyNext": "help.binding.historyNext",
	"tui.editor.cursorLeft": "help.binding.cursorLeft",
	"tui.editor.cursorRight": "help.binding.cursorRight",
	"tui.editor.cursorWordLeft": "help.binding.cursorWordLeft",
	"tui.editor.cursorWordRight": "help.binding.cursorWordRight",
	"tui.editor.cursorLineStart": "help.binding.cursorLineStart",
	"tui.editor.cursorLineEnd": "help.binding.cursorLineEnd",
	"tui.editor.jumpForward": "help.binding.jumpForward",
	"tui.editor.jumpBackward": "help.binding.jumpBackward",
	"tui.editor.deleteCharBackward": "help.binding.deleteCharBackward",
	"tui.editor.deleteCharForward": "help.binding.deleteCharForward",
	"tui.editor.deleteWordBackward": "help.binding.deleteWordBackward",
	"tui.editor.deleteWordForward": "help.binding.deleteWordForward",
	"tui.editor.deleteToLineStart": "help.binding.deleteToLineStart",
	"tui.editor.deleteToLineEnd": "help.binding.deleteToLineEnd",
	"tui.editor.yank": "help.binding.yank",
	"tui.editor.yankPop": "help.binding.yankPop",
	"tui.editor.undo": "help.binding.undo",
	"tui.input.newLine": "help.binding.newLine",
	"tui.input.tab": "help.binding.tab",
	"tui.altScreen.pageUp": "help.binding.viewportPageUp",
	"tui.altScreen.pageDown": "help.binding.viewportPageDown",
	"tui.altScreen.halfPageUp": "help.binding.viewportHalfPageUp",
	"tui.altScreen.halfPageDown": "help.binding.viewportHalfPageDown",
	"tui.altScreen.lineUp": "help.binding.viewportLineUp",
	"tui.altScreen.lineDown": "help.binding.viewportLineDown",
	"tui.altScreen.previousPrompt": "help.binding.previousPrompt",
	"tui.altScreen.nextPrompt": "help.binding.nextPrompt",
	"tui.altScreen.search": "help.binding.search",
	"tui.altScreen.searchNext": "help.binding.searchNext",
	"tui.altScreen.searchPrevious": "help.binding.searchPrevious",
	"tui.altScreen.searchClose": "help.binding.searchClose",
	"tui.altScreen.top": "help.binding.top",
	"tui.altScreen.bottom": "help.binding.bottom",
};

type Row = readonly [key: string, description: string];

export function helpLines(platform: string = process.platform, wsl: boolean = runningInWsl()): string[] {
	const rows: string[] = [];
	const section = (title: string, hints: readonly Row[]) => {
		rows.push(theme.accent(title), ...hints.map(([key, description]) => shortcutHints([key, description])), "");
	};
	section(t("help.section.chat"), [
		["Enter", t("help.chat.send")],
		["Esc", t("help.chat.stop")],
		["Esc Esc", t("help.chat.clear")],
		["Up / Down", t("help.chat.history")],
		["Ctrl+C", t("help.chat.ctrlc")],
		["Ctrl+S", t("help.chat.sessions")],
		["Ctrl+O", t("help.chat.question")],
		[keyLabel(clipboardShortcutKey(platform, wsl)), t("help.chat.paste")],
		["/", t("help.chat.commands")],
		["@", t("help.chat.files")],
		["/skill:", t("help.chat.skills")],
	]);
	section(t("help.section.menus"), [
		["↑↓", t("help.menus.select")],
		["Enter", t("help.menus.open")],
		[t("help.label.type"), t("help.menus.filter")],
		["Esc / Ctrl+C", t("help.menus.close")],
		["↑↓ / Wheel", t("help.menus.scroll")],
		["PgUp / PgDn", t("help.menus.page")],
	]);
	section(t("help.section.agents"), [
		["→", t("help.agents.open")],
		["←", t("help.agents.back")],
		["E", t("help.agents.expand")],
		["↑ / ↓", t("help.agents.approvalSelect")],
		["Enter", t("help.agents.approvalConfirm")],
		["PgUp / PgDn", t("help.agents.approvalScroll")],
		["[/]", t("help.agents.approvalSwitch")],
		["S", t("help.agents.stop")],
		[t("help.label.click"), t("help.agents.click")],
	]);
	section(t("help.section.jobs"), [
		["/jobs", t("help.jobs.list")],
		["Enter", t("help.jobs.output")],
		["S", t("help.jobs.stop")],
		["End", t("help.jobs.end")],
		["←", t("help.jobs.back")],
	]);
	section(t("help.section.queue"), [
		["Alt+↑", t("help.queue.select")],
		["↑ / ↓", t("help.queue.move")],
		["Enter", t("help.queue.steer")],
		["Esc", t("help.queue.withdraw")],
	]);
	section(t("help.section.todos"), [
		["/todos", t("help.todos.list")],
		["↑↓ / Wheel", t("help.todos.scroll")],
		["PgUp / PgDn", t("help.todos.page")],
		["Esc", t("help.todos.close")],
	]);
	section(t("help.section.questions"), [
		["Ctrl+O", t("help.questions.open")],
		["↑ / ↓", t("help.questions.move")],
		["1-9", t("help.questions.jump")],
		["Space", t("help.questions.select")],
		["Tab", t("help.questions.tab")],
		["Enter", t("help.questions.enter", { skip: skipLabel() })],
		["PgUp / PgDn", t("help.questions.scroll")],
		["[ / ]", t("help.questions.switch")],
		["Esc", t("help.questions.esc")],
		["Ctrl+C", t("help.questions.ctrlc")],
		[t("help.label.messages"), t("help.questions.messages")],
		[t("help.label.approvals"), t("help.questions.approvals")],
	]);
	section(t("help.section.plan"), [
		["/plan", t("help.plan.toggle")],
		["Shift+Tab", t("help.plan.shiftTab")],
		["↑ / ↓", t("help.plan.move")],
		["Enter", t("help.plan.choose")],
		["A / R", t("help.plan.ar")],
		["X", t("help.plan.exit")],
		["PgUp / PgDn", t("help.plan.scroll")],
		["Esc", t("help.plan.esc")],
		[t("help.label.messages"), t("help.plan.messages")],
	]);
	section(t("help.section.search"), [
		["/search", t("help.search.choose")],
		["Enter", t("help.search.apply")],
		["K", t("help.search.key")],
	]);
	section(t("help.section.context"), [
		["/context", t("help.context.tune")],
		["Enter", t("help.context.choose")],
		["Esc", t("help.context.back")],
	]);
	section(t("help.section.language"), [["/language", t("help.language.choose")]]);
	section(t("help.section.skills"), [
		["U", t("help.skills.user")],
		["P", t("help.skills.project")],
		["D", t("help.skills.remove")],
		["V", t("help.skills.preview")],
		["Y / N", t("help.skills.confirm")],
	]);
	section(t("help.section.credentials"), [
		["← / →", t("help.credentials.switch")],
		["Enter", t("help.credentials.save")],
		["Ctrl+R", t("help.credentials.remove")],
	]);
	const bindings = getKeybindings();
	const describe = (id: string): string => {
		const known = BINDING_KEYS[id];
		return known !== undefined ? t(known) : (bindings.getDefinition(id as never).description ?? id);
	};
	for (const [prefix, title] of [
		["tui.editor.", t("help.section.editing")],
		["tui.altScreen.", t("help.section.transcript")],
	] as const) {
		const hints: [string, string][] = [];
		for (const id of Object.keys(TUI_KEYBINDINGS) as (keyof typeof TUI_KEYBINDINGS)[]) {
			if (!id.startsWith(prefix) || id === "tui.editor.pageUp" || id === "tui.editor.pageDown") continue;
			const keys = bindings.getKeys(id);
			if (keys.length) hints.push([keys.map(keyLabel).join(" / "), describe(id)]);
		}
		if (prefix === "tui.editor.") {
			for (const id of ["tui.input.newLine", "tui.input.tab"] as const)
				hints.push([bindings.getKeys(id).map(keyLabel).join(" / "), describe(id)]);
		}
		section(title, hints);
	}
	section(t("help.section.mouse"), [
		[t("help.label.wheel"), t("help.mouse.wheel")],
		[t("help.label.click"), t("help.mouse.click")],
		[t("help.label.drag"), t("help.mouse.drag")],
	]);
	section(
		t("help.section.commands"),
		commands().map((command) => [`/${command.name}`, command.description ?? ""]),
	);
	return rows;
}

export class HelpDetail implements PickerDetail {
	backCloses = true;
	#offset = 0;
	#max = 0;
	#page = 1;
	get help() {
		return shortcutHints(["↑↓/Wheel", t("action.scroll")], ["PgUp/PgDn", t("action.page")], ["Esc", t("action.close")]);
	}
	scroll(delta: number) {
		this.#offset = Math.max(0, Math.min(this.#max, this.#offset + delta));
	}
	handleKey(data: string): boolean {
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.#page);
		else if (matchesKey(data, "pageDown")) this.scroll(this.#page);
		else return false;
		return true;
	}
	lines(width: number, height: number): readonly string[] {
		const rows = helpLines().flatMap((line) => wrapTextWithAnsi(line, width));
		this.#max = Math.max(0, rows.length - height);
		this.#page = Math.max(1, height - 1);
		this.#offset = Math.min(this.#offset, this.#max);
		return rows.slice(this.#offset, this.#offset + height);
	}
}
