import { Container, Markdown, MouseRegion, Spacer, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { localizeCoreText } from "../i18n/core-text.ts";
import { getLanguage, t } from "../i18n/index.ts";
import { getActiveThemeMode, getMarkdownTheme, theme } from "../theme/index.ts";

const thinkingCollapsedLabel = () => `✧ ${t("assistant.thinkingCollapsed")}`;

export type AssistantContent = {
	readonly thinking: string;
	readonly text: string;
	/** 回答被中断/出错/截断时的提示行；无则为 null。 */
	readonly note: string | null;
};

/**
 * 助手消息：text 用 Markdown；thinking 默认折叠为一行弱化斜体，点击展开/收起；
 * note（中止/错误/截断提示）在内容后给出。
 */
export class AssistantMessageComponent extends Container {
	#renderTheme = getActiveThemeMode();
	#renderLanguage = getLanguage();
	#lastContent: AssistantContent | undefined;
	#isStreaming = false;
	#thinkingExpanded = false;
	/** 最近一次 render 的宽度:驱动代码块底色铺满(经 getMarkdownTheme 闭包读取)。 */
	#renderWidth = 80;

	constructor(content?: AssistantContent, isStreaming = false) {
		super();
		if (content !== undefined) this.updateContent(content, isStreaming);
	}

	override render(width: number): string[] {
		if (this.#renderTheme !== getActiveThemeMode() || this.#renderLanguage !== getLanguage()) {
			this.#renderTheme = getActiveThemeMode();
			this.#renderLanguage = getLanguage();
			this.#rebuild();
		}

		this.#renderWidth = width;
		return super.render(width);
	}

	/** Markdown contentWidth(width - paddingX*2)减去 codeBlockIndent(2)后的底色目标宽度。 */
	#highlightWidth(): number {
		return Math.max(10, this.#renderWidth - 4);
	}

	updateContent(content: AssistantContent, isStreaming = this.#isStreaming): void {
		this.#lastContent = content;
		this.#isStreaming = isStreaming;
		this.#rebuild();
	}

	setThinkingExpanded(expanded: boolean): void {
		this.#thinkingExpanded = expanded;
		if (this.#lastContent !== undefined) this.#rebuild();
	}

	#rebuild(): void {
		const content = this.#lastContent;
		this.clear();
		if (content === undefined) return;

		if (content.thinking.trim() !== "") {
			const expanded = this.#thinkingExpanded;
			const thinkingComponent = expanded
				? new Markdown(
						content.thinking.trim(),
						1,
						0,
						getMarkdownTheme(() => this.#highlightWidth()),
						{
							color: theme.thinking,
							italic: true,
						},
					)
				: new Text(theme.thinking(thinkingCollapsedLabel()), 1, 0);
			this.addChild(
				new MouseRegion(thinkingComponent, (event: TuiMouseEvent) => {
					if (event.type !== "click" || event.button !== "left") return undefined;
					this.setThinkingExpanded(!expanded);
					return { handled: true };
				}),
			);
		}
		if (content.text.trim() !== "") {
			this.addChild(
				new Markdown(
					content.text.trim(),
					1,
					0,
					getMarkdownTheme(() => this.#highlightWidth()),
				),
			);
		}
		if (content.note !== null) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.error(localizeCoreText(content.note)), 1, 0));
		}
	}
}
