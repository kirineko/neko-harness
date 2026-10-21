import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { t } from "../i18n/index.ts";
import { style, theme } from "../theme/index.ts";

const CAT = ["|\\___/|", ")     (", "=\\^_^ /=", ")---("] as const;
/** 猫脸栏宽 + 与右侧文案的间隔。 */
const SIDE_AT = 16;
const MARGIN = "    ";

/**
 * 空会话品牌欢迎屏(design D10):猫脸 accent、产品名 muted 加粗、模型行 muted、
 * 入口提示 dim,整体左缩进 4。模型行随会话配置实时更新;由 tui.ts 在转录为空且
 * 不忙碌时挂载,首条消息到达即移除(不占条目序列)。
 */
export class WelcomeScreen implements Component {
	#modelLine = "";

	setModelLine(line: string): void {
		this.#modelLine = line;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const side = (art: string, text: string) =>
			`${MARGIN}${theme.accent(art)}${" ".repeat(Math.max(1, SIDE_AT - art.length))}${text}`;
		const lines = [
			"",
			`${MARGIN}${theme.accent(CAT[0]!)}`,
			side(CAT[1]!, theme.muted(style.bold("neko harness"))),
			side(CAT[2]!, theme.muted(this.#modelLine)),
			`${MARGIN}${theme.accent(CAT[3]!)}`,
			"",
			`${MARGIN}${theme.dim(t("welcome.hint"))}`,
		];
		return lines.map((line) => truncateToWidth(line, width));
	}
}
