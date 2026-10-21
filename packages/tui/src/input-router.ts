import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { usableSize } from "./layout.ts";
import { QUESTION_KEY } from "./question-dock.ts";

export type KeyResult = { consume: true } | undefined;

/** What the router needs from the app; everything stateful stays behind these callbacks. */
export type InputHost = {
	size(): { columns: number; rows: number };
	editor: { resetEscapeSequence(): void; getText(): string; isShowingAutocomplete(): boolean };
	approval: { handleInput(data: string): boolean };
	question: { readonly open: boolean; handleInput(data: string): boolean; swallowEscRepeat(data: string): boolean };
	/** The plan panel; absent in hosts without plan mode. */
	plan?: { readonly open: boolean; handleInput(data: string): boolean; swallowEscRepeat(data: string): boolean };
	/** A picker or login panel is open. */
	overlayOpen(): boolean;
	/** The run is busy, so Esc and Ctrl+C stop it. */
	busy(): boolean;
	compactionActive(): boolean;
	/** A manual or blocking compaction runs, which Esc can cancel. */
	compactionStoppable(): boolean;
	sessionOperation(): boolean;
	queueKey(data: string): KeyResult;
	hasSubagents(): boolean;
	showAgents(): void;
	toggleQuestion(): void;
	/** Shift+Tab: enter or leave plan mode. */
	togglePlan?(): void;
	/** Clipboard paste shortcut; returns whether the key was one. */
	clipboardKey(data: string): boolean;
	/** Pasted or dropped image paths; returns whether they were taken. */
	pasteImages(data: string): boolean;
	openSessions(): void;
	abort(): void;
	exit(): void;
};

/**
 * The single place that decides which control owns a key. Exactly one owner handles it:
 * the question panel (while open) > plan panel (while open) > approval dock > picker/login > queue selection >
 * editor shortcuts.
 * A key the owner consumed never reaches the next one, so Esc that closes the question panel cannot also stop
 * the run, and an answer's Enter cannot approve a command or steer a queued message.
 */
export function createInputRouter(host: InputHost): (data: string) => KeyResult {
	const consume = { consume: true } as const;
	const stop = (): KeyResult => {
		if (host.busy()) host.abort();
		else host.exit();
		return consume;
	};
	return (data) => {
		if (isKeyRelease(data)) return consume;
		if (
			!matchesKey(data, "escape") ||
			host.overlayOpen() ||
			host.question.open ||
			host.plan?.open ||
			host.busy() ||
			host.compactionActive()
		)
			host.editor.resetEscapeSequence();

		const { columns, rows } = host.size();
		if (!usableSize(columns, rows)) {
			if (matchesKey(data, "ctrl+c")) host.exit();
			return consume;
		}
		if (host.question.swallowEscRepeat(data)) return consume;
		if (host.question.open) return host.question.handleInput(data) ? consume : stop();
		if (host.plan?.swallowEscRepeat(data)) return consume;
		if (host.plan?.open) return host.plan.handleInput(data) ? consume : stop();
		if (matchesKey(data, QUESTION_KEY) && !host.overlayOpen() && !host.sessionOperation()) {
			host.toggleQuestion();
			return consume;
		}
		if (host.approval.handleInput(data)) return consume;
		if (host.overlayOpen()) {
			// Let focused-component dispatch filter key releases before handling panel input.
			return undefined;
		}
		if (host.sessionOperation()) return consume;
		const queueKey = host.queueKey(data);
		if (queueKey) return queueKey;
		if (host.togglePlan && matchesKey(data, "shift+tab") && !host.editor.isShowingAutocomplete()) {
			host.togglePlan();
			return consume;
		}
		if (
			matchesKey(data, "right") &&
			host.hasSubagents() &&
			host.editor.getText() === "" &&
			!host.editor.isShowingAutocomplete()
		) {
			host.showAgents();
			return consume;
		}
		if (host.clipboardKey(data)) return consume;
		if (host.pasteImages(data)) return consume;
		if (matchesKey(data, "escape") && host.editor.isShowingAutocomplete()) {
			host.editor.resetEscapeSequence();
			return undefined;
		}
		if (matchesKey(data, "ctrl+c")) return stop();
		if (matchesKey(data, "escape") && (host.busy() || host.compactionStoppable())) {
			host.abort();
			return consume;
		}
		if (matchesKey(data, "ctrl+s")) {
			host.openSessions();
			return consume;
		}
		return undefined;
	};
}
