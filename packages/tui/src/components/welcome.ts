import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "../i18n/index.ts";
import { getLogoPalette, type LogoPalette, renderHalfBlockRows, style, theme } from "../theme/index.ts";

// 24x16 萌系像素小鲸鱼（双喷水珠 + 额头高光 + 腮红 + 胸鳍缺口；16 半行 = 8 个终端行，含底部 1 半行留白）。
const WHALE_SPRITE = [
	"......MM...MM...........",
	".......M...M...KK.......",
	"....KKKKKK.....KBK...KK.",
	"..KKBBBBBBKK...KBBK.KBBK",
	".KBBHHBBBBBBK...KBBKBBK.",
	".KBHBBBBBBBBBK...KBBBK..",
	"KBBBBBBBBBBBBBK..KBBK...",
	"KBBBBBBBBBBBBBBKKBBBK...",
	"KBBBBEBBBBBEBBBBBBBK....",
	"KBBBBEBBBBBEBBBBBBBK....",
	"KBBPPBBBBBBBPPBBBBBK....",
	"KBBBBWWWWWWWBBBBKBBBK...",
	".KBWWWWWWWWWWWBBBKBBBK..",
	"..KSSSSSSSSSSSKBBBBBBK..",
	"...KKKKKKKKKKK.KKKKKK...",
	"........................",
] as const;

// 5x8 窄高像素大字（仿 dsh-tui 比例；NEKO 8px + 2px 间距 + HARNESS 8px = 18px = 9 个终端行）。
const WORD_GLYPHS: Readonly<Record<string, readonly string[]>> = {
	N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#", "#...#"],
	E: ["#####", "#....", "#....", "####.", "#....", "#....", "#....", "#####"],
	K: ["#...#", "#..#.", "#.#..", "##...", "##...", "#.#..", "#..#.", "#...#"],
	O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
	H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#", "#...#"],
	A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#", "#...#"],
	R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#", "#...#"],
	S: [".####", "#....", "#....", ".###.", "....#", "....#", "....#", "####."],
};

const COMPACT_WHALE = [".-~~-.", "(o__o)~"] as const;
const MARGIN = "  ";

function buildWordMask(word: string, gap: number): string[] {
	const chars = [...word];
	const rows = Array.from({ length: 8 }, () => "");
	chars.forEach((ch, idx) => {
		const glyph = WORD_GLYPHS[ch];
		if (!glyph) return;
		for (let r = 0; r < 8; r++) {
			rows[r] = `${rows[r] ?? ""}${idx > 0 ? ".".repeat(gap) : ""}${glyph[r] ?? ""}`;
		}
	});
	return rows;
}

function lerpHex(start: string, end: string, ratio: number): string {
	const s = [1, 3, 5].map((i) => Number.parseInt(start.slice(i, i + 2), 16));
	const e = [1, 3, 5].map((i) => Number.parseInt(end.slice(i, i + 2), 16));
	const hex = s.map((v, idx) =>
		Math.round(v + ((e[idx] ?? v) - v) * ratio)
			.toString(16)
			.padStart(2, "0"),
	);
	return `#${hex.join("")}`;
}

function buildBannerRows(palette: LogoPalette, gap: number): { lines: string[]; canvasWidth: number } {
	const topMask = buildWordMask("NEKO", gap);
	const bottomMask = buildWordMask("HARNESS", gap);
	const canvasWidth = bottomMask[0]?.length ?? 47;
	const whaleWidth = WHALE_SPRITE[0].length;
	const whaleOffset = Math.floor((canvasWidth - whaleWidth) / 2);
	const topOffset = Math.floor((canvasWidth - (topMask[0]?.length ?? 0)) / 2);

	const colorMap: Readonly<Record<string, string>> = {
		K: palette.outline,
		E: palette.eye,
		B: palette.body,
		H: palette.shine,
		M: palette.spout,
		S: palette.shade,
		W: palette.belly,
		P: palette.cheek,
	};

	const pixels: (string | null)[][] = [];
	for (const spriteRow of WHALE_SPRITE) {
		const row = Array<string | null>(canvasWidth).fill(null);
		for (let x = 0; x < spriteRow.length; x++) {
			const pixel = colorMap[spriteRow[x] ?? "."];
			if (pixel !== undefined) row[whaleOffset + x] = pixel;
		}
		pixels.push(row);
	}

	for (let y = 0; y < 8; y++) {
		const row = Array<string | null>(canvasWidth).fill(null);
		const mask = topMask[y] ?? "";
		for (let x = 0; x < mask.length; x++) {
			if (mask[x] === "#") row[topOffset + x] = palette.wordTop;
		}
		pixels.push(row);
	}

	pixels.push(Array<string | null>(canvasWidth).fill(null));
	pixels.push(Array<string | null>(canvasWidth).fill(null));

	const denom = Math.max(1, canvasWidth - 1);
	for (let y = 0; y < 8; y++) {
		const row = Array<string | null>(canvasWidth).fill(null);
		const mask = bottomMask[y] ?? "";
		for (let x = 0; x < mask.length; x++) {
			if (mask[x] === "#") row[x] = lerpHex(palette.wordStart, palette.wordEnd, x / denom);
		}
		pixels.push(row);
	}

	return { lines: renderHalfBlockRows(pixels), canvasWidth };
}

function centerLine(content: string, contentWidth: number, totalWidth: number): string {
	const pad = Math.max(0, Math.floor((totalWidth - contentWidth) / 2));
	return truncateToWidth(`${" ".repeat(pad)}${content}`, totalWidth);
}

/**
 * 空会话品牌欢迎屏：居中渲染萌系像素小鲸鱼 + NEKO / HARNESS 双行流光像素大字，
 * 下方依次展示实时模型状态行与快捷入口提示；总高 19 行适配默认 80x24 终端，超窄窗口退化为紧凑文本布局。
 */
export class WelcomeScreen implements Component {
	#modelLine = "";

	setModelLine(line: string): void {
		this.#modelLine = line;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		if (width < 43) {
			const compact = [
				"",
				`${MARGIN}${theme.model(COMPACT_WHALE[0])}  ${theme.muted(style.bold("neko harness"))}`,
				`${MARGIN}${theme.model(COMPACT_WHALE[1])}${this.#modelLine ? `  ${theme.muted(this.#modelLine)}` : ""}`,
				"",
				`${MARGIN}${theme.dim(t("welcome.hint"))}`,
			];
			return compact.map((line) => truncateToWidth(line, width));
		}

		const gap = width >= 51 ? 2 : 1;
		const { lines: bannerLines, canvasWidth } = buildBannerRows(getLogoPalette(), gap);
		const pad = " ".repeat(Math.max(0, Math.floor((width - canvasWidth) / 2)));
		const out: string[] = [];
		for (const line of bannerLines) {
			out.push(line === "" ? "" : truncateToWidth(`${pad}${line}`, width));
		}
		out.push("");
		if (this.#modelLine !== "") {
			const modelStyled = theme.model(this.#modelLine);
			out.push(centerLine(modelStyled, visibleWidth(modelStyled), width));
		}
		const hintStyled = theme.dim(t("welcome.hint"));
		out.push(centerLine(hintStyled, visibleWidth(hintStyled), width));
		return out;
	}
}
