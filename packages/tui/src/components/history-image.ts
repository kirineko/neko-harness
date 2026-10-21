import {
	type Component,
	Container,
	getCapabilities,
	Image,
	type ScrollView,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { type ChatImage, terminalImage } from "@neko-harness/core";
import { encodeChunk, type ImageFile } from "@neko-harness/core/image-transfer";
import { t } from "../i18n/index.ts";
import { theme } from "../theme/index.ts";

let active = 0;
const queue: (() => void)[] = [];
async function bounded<T>(work: () => Promise<T>): Promise<T> {
	if (active >= 2) await new Promise<void>((r) => queue.push(r));
	else active++;
	try {
		return await work();
	} finally {
		const next = queue.shift();
		if (next) next();
		else active--;
	}
}
/** Only visible images retain decoded previews; Pi handles the terminal graphics protocol. */
export class HistoryImage implements Component {
	#component: Component | undefined;
	#started = false;
	#visible = false;
	#failed = false;
	private image: ChatImage;
	private load: () => Promise<ImageFile>;
	private changed: () => void;
	constructor(image: ChatImage, load: () => Promise<ImageFile>, changed: () => void) {
		this.image = image;
		this.load = load;
		this.changed = changed;
	}
	get #fallback(): Text {
		const { name, mimeType, width, height } = this.image;
		return new Text(
			width
				? t("image.fallbackSized", { name, type: mimeType, size: `${width}x${height}` })
				: t("image.fallback", { name, type: mimeType }),
			1,
			0,
		);
	}
	updateInfo(image: ChatImage) {
		this.image = image;
	}
	setVisible(value: boolean) {
		if (value && !this.#visible) this.#failed = false;
		this.#visible = value;
		if (!value) this.#component = undefined;
	}
	invalidate() {
		this.#component?.invalidate();
	}
	measure(width: number): string[] {
		const lines = this.#fallback.render(width);
		if (getCapabilities().images) while (lines.length < 8) lines.push("");
		return lines;
	}
	render(width: number): string[] {
		if (this.#visible && !this.#started && !this.#component && !this.#failed && getCapabilities().images) {
			this.#started = true;
			void bounded(async () => {
				if (!this.#visible) return;
				const file = await this.load();
				const png = await terminalImage(file.bytes);
				if (this.#visible)
					this.#component = new Image(
						encodeChunk(png),
						"image/png",
						{ fallbackColor: theme.dim },
						{ filename: this.image.name, maxWidthCells: Math.min(width, 60), maxHeightCells: 8 },
					);
			})
				.catch(() => {
					this.#failed = true;
				})
				.finally(() => {
					this.#started = false;
					this.changed();
				});
		}
		const lines = (this.#component ?? this.#fallback).render(width);
		if (getCapabilities().images) while (lines.length < 8) lines.push("");
		return lines;
	}
}
export class ImageTranscript extends Container {
	private scroll: () => ScrollView | undefined;
	#itemCount = 0;
	readonly #itemSpacers = new Map<Component, Spacer>();
	constructor(scroll: () => ScrollView | undefined) {
		super();
		this.scroll = scroll;
	}
	/**
	 * 顶层条目(user/assistant/tool/system/流式块):条目间固定 1 空行,首条除外。
	 * 图片等依附于条目的内容仍用 addChild,不产生间距。
	 */
	addItem(component: Component): void {
		if (this.#itemCount > 0) {
			const spacer = new Spacer(1);
			this.addChild(spacer);
			this.#itemSpacers.set(component, spacer);
		}
		this.addChild(component);
		this.#itemCount++;
	}
	/** 移除条目及其前导空行(流式块让位给正式条目时不遗留孤儿 Spacer)。 */
	removeItem(component: Component): void {
		const spacer = this.#itemSpacers.get(component);
		if (spacer !== undefined) {
			this.removeChild(spacer);
			this.#itemSpacers.delete(component);
		}
		if (this.children.includes(component)) {
			this.removeChild(component);
			this.#itemCount--;
		}
	}
	get itemCount(): number {
		return this.#itemCount;
	}
	override clear() {
		for (const child of this.children) if (child instanceof HistoryImage) child.setVisible(false);
		this.#itemCount = 0;
		this.#itemSpacers.clear();
		super.clear();
	}
	override render(width: number): string[] {
		const scroll = this.scroll();
		const top = scroll?.scrollTop ?? 0;
		const bottom = top + (scroll?.viewportHeight ?? 0);
		let offset = 0;
		// Measure without initiating I/O, then load only rows in the viewport.
		const measured = this.children.map((child) => {
			const lines = child instanceof HistoryImage ? child.measure(width) : child.render(width);
			const start = offset;
			offset += lines.length;
			return { child, lines, start };
		});
		const viewportTop = scroll?.isFollowingEnd ? Math.max(0, offset - (scroll.viewportHeight || 0)) : top;
		const viewportBottom = scroll?.isFollowingEnd ? offset : bottom;
		for (const item of measured)
			if (item.child instanceof HistoryImage)
				item.child.setVisible(item.start < viewportBottom && item.start + item.lines.length > viewportTop);
		return measured.flatMap(({ child, lines }) => (child instanceof HistoryImage ? child.render(width) : lines));
	}
}
