import { type Component, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { ThemeSlot } from "../theme/index.ts";

/** Keep unstyled content so a theme change never leaves cached ANSI colors. */
export class ThemedText extends Text {
	#raw: string;
	readonly #color: ThemeSlot;
	constructor(text: string, color: ThemeSlot, paddingX = 1, paddingY = 0) {
		super("", paddingX, paddingY);
		this.#raw = text;
		this.#color = color;
	}
	override setText(text: string): void {
		this.#raw = text;
		this.invalidate();
	}
	override render(width: number): readonly string[] {
		super.setText(this.#color(this.#raw));
		return super.render(width);
	}
}

export class ThemedTruncatedText implements Component {
	readonly #content: () => string;
	readonly #paddingX: number;
	readonly #paddingY: number;
	constructor(content: () => string, paddingX = 1, paddingY = 0) {
		this.#content = content;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
	}
	invalidate(): void {}
	render(width: number): readonly string[] {
		return new TruncatedText(this.#content(), this.#paddingX, this.#paddingY).render(width);
	}
}

/** Like ThemedTruncatedText but wraps, for notices whose full text (e.g. a file path) must stay readable. */
export class ThemedWrappedText implements Component {
	readonly #content: () => string;
	constructor(content: () => string) {
		this.#content = content;
	}
	invalidate(): void {}
	render(width: number): readonly string[] {
		return new Text(this.#content(), 1, 0).render(width);
	}
}
