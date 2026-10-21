import { Container, Markdown, MouseRegion, Text } from "@earendil-works/pi-tui";
import type { DefaultImagePrompt } from "@neko-harness/core";
import type { SkillInvocation } from "@neko-harness/core/skill-invocation";
import { getLanguage, t } from "../i18n/index.ts";
import { getActiveThemeMode, getMarkdownTheme, theme } from "../theme/index.ts";

/** 用户消息：蓝色气泡（整行背景 + 樱花左缘条），Markdown 渲染；/skill: 展开块折叠为单行标记。 */
export class UserMessageComponent extends Container {
	#renderTheme = getActiveThemeMode();
	#renderLanguage = getLanguage();
	#text: string;
	#skill?: SkillInvocation;
	#defaultImagePrompt?: DefaultImagePrompt;
	#expanded = false;

	constructor(text: string, skill?: SkillInvocation, defaultImagePrompt?: DefaultImagePrompt) {
		super();
		this.#text = text;
		this.#skill = skill;
		this.#defaultImagePrompt = defaultImagePrompt;
		this.#rebuild();
	}

	setText(text: string): void {
		this.#text = text;
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#rebuild();
	}

	/** 每行加 `▍` accent 左缘（底色 userBg 贯通）；内容宽度 -1，间距由内容自身 padding 提供。 */
	override render(width: number): string[] {
		if (this.#renderTheme !== getActiveThemeMode() || this.#renderLanguage !== getLanguage()) {
			this.#renderTheme = getActiveThemeMode();
			this.#renderLanguage = getLanguage();
			this.#rebuild();
		}

		const bar = theme.userBg(theme.accent("▍"));
		return super.render(Math.max(1, width - 1)).map((line) => `${bar}${line}`);
	}

	#rebuild(): void {
		this.clear();
		const prompt = this.#defaultImagePrompt;
		if (prompt) {
			this.addChild(
				new MouseRegion(
					new Text(
						theme.dim(this.#expanded ? t("user.imagePromptExpanded") : t("user.imagePromptCollapsed")),
						1,
						0,
						theme.userBg,
					),
					(event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.setExpanded(!this.#expanded);
						return { handled: true };
					},
				),
			);
			if (this.#expanded) this.addChild(new Text(prompt.text, 1, 0, theme.userBg));
			if (!this.#text.trim()) return;
		}
		const invocation = this.#skill;
		if (invocation !== undefined) {
			// 技能正文不铺开：单行技能标记 + 参数预览 + dim 来源行；正文始终在本地文件中可读。
			const args = invocation.args.replace(/\s+/g, " ").trim();
			const preview = args.length > 100 ? `${args.slice(0, 99)}…` : args;
			const head = `${theme.toolTitle(`✦ skill:${invocation.name}`)}${preview ? ` ${theme.userText(preview)}` : ""}`;
			const source = theme.dim(t("user.skillSource", { location: invocation.location }));
			this.addChild(new Text(`${head}\n${source}`, 1, 0, theme.userBg));
			return;
		}
		this.addChild(
			new Markdown(
				this.#text,
				1,
				0,
				getMarkdownTheme(),
				{
					color: theme.userText,
					bgColor: theme.userBg,
				},
				{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
			),
		);
	}
}
