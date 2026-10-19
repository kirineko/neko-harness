import {
	type AutocompleteProvider,
	CURSOR_MARKER,
	Editor,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** Bound input height while retaining the cursor and nearby completion rows. */
export class BoundedEditor extends Editor {
	maxRows = 7;
	isImageReference: (ref: string) => boolean = () => false;
	onClearDraft?: () => void;
	#lastEscape = 0;
	#completionEpoch = 0;
	#completionProvider?: AutocompleteProvider;
	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.#completionEpoch++;
		const wrapped: AutocompleteProvider = {
			triggerCharacters: provider.triggerCharacters,
			shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion?.bind(provider),
			getSuggestions: provider.getSuggestions.bind(provider),
			applyCompletion: (...args) => {
				const result = provider.applyCompletion(...args);
				if (args[4].startsWith("@") && args[3].label.endsWith("/")) {
					const epoch = this.#completionEpoch;
					// Pi closes the current list after applying. Resume via its public Tab path.
					queueMicrotask(() => {
						const cursor = this.getCursor();
						if (
							epoch === this.#completionEpoch &&
							this.getText() === result.lines.join("\n") &&
							cursor.line === result.cursorLine &&
							cursor.col === result.cursorCol
						)
							super.handleInput("\t");
					});
				}
				return result;
			},
		};
		this.#completionProvider = wrapped;
		super.setAutocompleteProvider(wrapped);
	}
	resetEscapeSequence(): void {
		this.#lastEscape = 0;
	}
	override setText(text: string): void {
		this.#completionEpoch++;
		this.resetEscapeSequence();
		super.setText(text);
		this.#flushHistory();
	}

	/**
	 * Replace the browsable prompt history (newest first). Pi exposes only append, so this writes its private
	 * field; the version is pinned and a test covers it. While browsing, the update waits so the visible entry
	 * and position do not shift.
	 */
	setHistory(entries: readonly string[]): void {
		// biome-ignore lint/complexity/useLiteralKeys: pi-tui 将 history/historyIndex 声明为 private，只能用括号访问
		if (this["historyIndex"] > -1) {
			this.#pendingHistory = entries;
			return;
		}
		this.#pendingHistory = undefined;
		// biome-ignore lint/complexity/useLiteralKeys: pi-tui 将 history/historyIndex 声明为 private，只能用括号访问
		const current: string[] = this["history"];
		if (current.length === entries.length && current.every((entry, i) => entry === entries[i])) return;
		// biome-ignore lint/complexity/useLiteralKeys: pi-tui 将 history/historyIndex 声明为 private，只能用括号访问
		this["history"] = [...entries];
	}
	#pendingHistory?: readonly string[];
	#flushHistory(): void {
		// biome-ignore lint/complexity/useLiteralKeys: pi-tui 将 history/historyIndex 声明为 private，只能用括号访问
		if (this.#pendingHistory !== undefined && this["historyIndex"] === -1) this.setHistory(this.#pendingHistory);
	}

	override handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		this.#flushHistory();
		this.#completionEpoch++;
		if (matchesKey(data, "escape") && this.isShowingAutocomplete()) {
			this.resetEscapeSequence();
			super.handleInput(data);
			return;
		}
		if (matchesKey(data, "escape")) {
			// Also cancel a pending directory query before its list becomes visible.
			if (this.#completionProvider) super.setAutocompleteProvider(this.#completionProvider);
			if (isKeyRepeat(data)) return;
			const now = Date.now();
			if (this.#lastEscape && now - this.#lastEscape <= 400) {
				this.#lastEscape = 0;
				this.setText("");
				this.onClearDraft?.();
				return;
			}
			this.#lastEscape = now;
			super.handleInput(data);
			return;
		}
		this.#lastEscape = 0;
		const backward = matchesKey(data, "backspace");
		const forward = matchesKey(data, "delete") || matchesKey(data, "ctrl+d");
		if (backward || forward) {
			const { line, col } = this.getCursor();
			const lines = this.getLines();
			const offset = lines.slice(0, line).reduce((n, s) => n + s.length + 1, 0) + col;
			const raw = this.getText();
			for (const match of raw.matchAll(/\[Image \d+: [^\]\r\n]*\]/g)) {
				const start = match.index,
					end = start + match[0].length;
				if (
					!this.isImageReference(match[0]) ||
					!(backward ? offset > start && offset <= end : offset >= start && offset < end)
				)
					continue;
				// Expand Pi's large-paste markers before setText clears their registry.
				const expanded = this.getExpandedText();
				const occurrence = raw.slice(0, start).split(match[0]).length - 1;
				let at = -1;
				for (let n = 0; n <= occurrence; n++) at = expanded.indexOf(match[0], at + 1);
				const suffix = expanded.slice(at + match[0].length);
				this.setText(expanded.slice(0, at) + suffix);
				// setText records one native undo snapshot and places the cursor at the end.
				for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(suffix))
					super.handleInput("\x1b[D");
				return;
			}
		}
		super.handleInput(data);
	}

	#rowMap: number[] = [];
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return super.handleMouse({ ...event, y: this.#rowMap[event.y] ?? event.y });
	}
	override render(width: number): string[] {
		const lines = super.render(width);
		this.#rowMap = lines.map((_, i) => i);
		if (lines.length <= this.maxRows) return lines;
		const borders = lines.flatMap((line, index) => (/^[─↑↓]/u.test(stripTerminalSequences(line)) ? [index] : []));
		const bottom = borders.at(-1) ?? lines.length - 1;
		const completions = lines.slice(bottom + 1).slice(0, Math.max(0, this.maxRows - 3));
		const count = Math.max(1, this.maxRows - 2 - completions.length);
		const cursor = Math.max(
			1,
			lines.findIndex((line) => line.includes(CURSOR_MARKER)),
		);
		const start = Math.max(1, Math.min(cursor - count + 1, bottom - count));
		this.#rowMap = [
			0,
			...Array.from({ length: count }, (_, i) => start + i),
			bottom,
			...completions.map((_, i) => bottom + 1 + i),
		];
		return [lines[0]!, ...lines.slice(start, start + count), lines[bottom]!, ...completions];
	}
}
