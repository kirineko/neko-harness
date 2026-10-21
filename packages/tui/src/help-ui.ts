import { getKeybindings, matchesKey, TUI_KEYBINDINGS, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { PickerDetail } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { clipboardShortcutKey, runningInWsl } from "./image-input.ts";
import { commands } from "./labels.ts";
import { theme } from "./theme/index.ts";

const keyLabel = (key: string) =>
	key
		.split("+")
		.map(
			(part) => ({ escape: "Esc", pageUp: "PgUp", pageDown: "PgDn" })[part] ?? part[0]!.toUpperCase() + part.slice(1),
		)
		.join("+");

export function helpLines(platform: string = process.platform, wsl: boolean = runningInWsl()): string[] {
	const rows: string[] = [];
	const section = (title: string, hints: readonly (readonly [string, string])[]) => {
		rows.push(theme.accent(title), ...hints.map(([key, description]) => shortcutHints([key, description])), "");
	};
	section("Chat", [
		["Enter", "Send; queue while running"],
		["Esc", "Stop a running task or blocking compaction"],
		["Esc Esc", "Clear draft when idle (press twice quickly)"],
		["Up / Down", "Browse previous inputs in this session"],
		["Ctrl+C", "Stop while running; exit when idle"],
		["Ctrl+S", "Open sessions"],
		["Ctrl+O", "Open or close the assistant's question"],
		[keyLabel(clipboardShortcutKey(platform, wsl)), "Paste clipboard image or text"],
		["/", "Complete commands"],
		["@", "Complete workspace files"],
		["/skill:", "Complete installed skills"],
	]);
	section("Menus", [
		["↑↓", "Select"],
		["Enter", "Open or apply"],
		["Type", "Filter list"],
		["Esc / Ctrl+C", "Back or close"],
		["↑↓ / Wheel", "Scroll details"],
		["PgUp / PgDn", "Page through details"],
	]);
	section("Agents", [
		["→", "Open agents from an empty editor; open selected task"],
		["←", "Return to main chat"],
		["E", "Expand or collapse tool results and thinking"],
		["↑ / ↓", "Select Allow once / Deny when approval appears"],
		["Enter", "Confirm selected approval option"],
		["PgUp / PgDn", "Scroll full approval command"],
		["[/]", "Select another pending approval"],
		["S", "Stop current round; keep agent context (Enter confirms)"],
		["Click", "Open round card or status-bar Agents entry"],
	]);
	section("Jobs", [
		["/jobs", "View background jobs"],
		["Enter", "Open job output"],
		["S", "Stop selected running job (Enter confirms)"],
		["End", "Jump to the newest output"],
		["←", "Back"],
	]);
	section("Queue", [
		["Alt+↑", "Select queued messages above the editor"],
		["↑ / ↓", "Move between queued messages"],
		["Enter", "Steer the selected message (joins the run after the current tool round)"],
		["Esc", "Withdraw the selected message into the editor; the run keeps going"],
	]);
	section("Todos", [
		["/todos", "View the assistant's todo list (read-only)"],
		["↑↓ / Wheel", "Scroll a long list"],
		["PgUp / PgDn", "Page through the list"],
		["Esc", "Close"],
	]);
	section("Questions", [
		["Ctrl+O", "Open or close the question panel (also /question)"],
		["↑ / ↓", "Move between options"],
		["1-9", "Jump to an option"],
		["Space", "Select (single choice) or toggle (multiple choice); nothing is preselected"],
		["Tab", "Switch between the options and the note or answer field"],
		["Enter", "Submit the answer; on 跳过此问题 it skips the question"],
		["PgUp / PgDn", "Scroll a long question"],
		["[ / ]", "Switch between several waiting questions"],
		["Esc", "Close the panel only: the draft is kept, the question stays open and the run keeps going"],
		["Ctrl+C", "Stop the run, which cancels the question"],
		["Messages", "Typed messages stay queued until the question is settled; they are never the answer"],
		["Approvals", "A waiting approval keeps the keys until you press Ctrl+O; Esc then returns to it"],
	]);
	section("Plan mode", [
		["/plan", "Enter or leave plan mode; with a plan waiting, open it for review"],
		["Shift+Tab", "Enter or leave plan mode (idle sessions only)"],
		["↑ / ↓", "Move between Approve and Request changes in the plan panel"],
		["Enter", "Choose the highlighted row; Request changes then takes a typed note"],
		["A / R", "Approve the plan / write the requested changes"],
		["X", "Cancel the waiting plan and exit plan mode (idle sessions only)"],
		["PgUp / PgDn", "Scroll a long plan"],
		["Esc", "Close the panel only: the plan keeps waiting and the draft is kept"],
		["Messages", "A normal message sent while a plan waits replaces that plan"],
	]);
	section("Web search", [
		["/search", "Choose the web search provider"],
		["Enter", "Apply the highlighted provider"],
		["K", "Set the highlighted provider's API key (opens /login)"],
	]);
	section("Context", [
		["/context", "Tune compaction and tool result pruning"],
		["Enter", "Choose a setting, then a value to save"],
		["Esc", "Back"],
	]);
	section("Skills", [
		["U", "Install for user"],
		["P", "Install for project"],
		["D", "Remove"],
		["V", "Preview"],
		["Y / N", "Confirm / cancel changes"],
	]);
	section("Credentials", [
		["← / →", "Switch provider"],
		["Enter", "Save key"],
		["Ctrl+R", "Remove saved key"],
	]);
	const bindings = getKeybindings();
	for (const [prefix, title] of [
		["tui.editor.", "Editing"],
		["tui.altScreen.", "Main transcript and search"],
	] as const) {
		const hints: [string, string][] = [];
		for (const id of Object.keys(TUI_KEYBINDINGS) as (keyof typeof TUI_KEYBINDINGS)[]) {
			if (!id.startsWith(prefix) || id === "tui.editor.pageUp" || id === "tui.editor.pageDown") continue;
			const keys = bindings.getKeys(id);
			if (keys.length) hints.push([keys.map(keyLabel).join(" / "), bindings.getDefinition(id).description ?? id]);
		}
		if (prefix === "tui.editor.") {
			for (const id of ["tui.input.newLine", "tui.input.tab"] as const)
				hints.push([bindings.getKeys(id).map(keyLabel).join(" / "), bindings.getDefinition(id).description ?? id]);
		}
		section(title, hints);
	}
	section("Mouse", [
		["Wheel", "Scroll transcript or details"],
		["Click", "Expand messages, thinking, tools and images"],
		["Drag", "Select text; release to copy"],
	]);
	section(
		"Commands",
		commands.map((command) => [`/${command.name}`, command.description ?? ""]),
	);
	return rows;
}

export class HelpDetail implements PickerDetail {
	backCloses = true;
	#offset = 0;
	#max = 0;
	#page = 1;
	get help() {
		return shortcutHints(["↑↓/Wheel", "Scroll"], ["PgUp/PgDn", "Page"], ["Esc", "Close"]);
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
