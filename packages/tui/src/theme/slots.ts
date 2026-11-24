import {
	backgroundAnsi,
	type Color,
	foregroundAnsi,
	getTerminalColorMode,
	parseColor,
	styleText,
} from "@earendil-works/pi-tui";
import { DARK_PALETTE, LIGHT_PALETTE, SLOT_NAMES, type SlotStyle, type ThemeSlotName } from "./palette.ts";

export type { ThemeSlotName } from "./palette.ts";

export type ThemeMode = "light" | "dark";
/** 主题偏好:明确明暗,或跟随终端(自动检测)。 */
export type ThemePreference = ThemeMode | "auto";

export type ThemeSlot = (text: string) => string;
export type NekoTheme = Record<ThemeSlotName, ThemeSlot>;

/** Restore surface defaults after nested SGR resets, without overwriting explicit inner colors. */
function surfaceText(text: string, fg: string, bg: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: parse terminal SGR escapes
	return text.replace(/\x1b\[([0-9;:]*)m/g, (sequence, parameters: string) => {
		const codes = parameters.split(";");
		let resetFg = false;
		let resetBg = false;
		for (let i = 0; i < codes.length; i++) {
			const code = Number(codes[i]!.split(":")[0]);
			if (code === 0) {
				resetFg = true;
				resetBg = true;
			} else if (code === 39) resetFg = true;
			else if (code === 49) resetBg = true;
			else if (code === 38 || code === 48) {
				if (code === 38) resetFg = false;
				else resetBg = false;
				if (!codes[i]!.includes(":")) i += codes[i + 1] === "2" ? 4 : codes[i + 1] === "5" ? 2 : 0;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) resetFg = false;
			else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) resetBg = false;
		}
		return sequence + (resetFg ? fg : "") + (resetBg ? bg : "");
	});
}

function createTheme(palette: Record<ThemeSlotName, SlotStyle>): NekoTheme {
	const colorCache = new Map<string, Color>();
	const colorOf = (hex: string): Color => {
		let color = colorCache.get(hex);
		if (color === undefined) {
			color = parseColor(hex);
			colorCache.set(hex, color);
		}
		return color;
	};
	const theme = {} as Record<ThemeSlotName, ThemeSlot>;
	for (const name of SLOT_NAMES) {
		const style = palette[name];
		theme[name] = (text: string) => {
			const mode = getTerminalColorMode();
			if (palette === DARK_PALETTE && style.fg && style.bg)
				text = surfaceText(text, foregroundAnsi(colorOf(style.fg), mode), backgroundAnsi(colorOf(style.bg), mode));
			return styleText(
				text,
				{
					...(style.fg !== undefined ? { fg: colorOf(style.fg) } : {}),
					...(style.bg !== undefined ? { bg: colorOf(style.bg) } : {}),
					...(style.bold !== undefined ? { bold: style.bold } : {}),
					...(style.italic !== undefined ? { italic: style.italic } : {}),
					...(style.strikethrough !== undefined ? { strikethrough: style.strikethrough } : {}),
					...(style.underline !== undefined ? { underline: style.underline } : {}),
				},
				mode,
			);
		};
	}
	return theme as NekoTheme;
}

/** 独立冷灰蓝深色主题与原 sakura-day 浅色主题。 */
export const darkTheme: NekoTheme = createTheme(DARK_PALETTE);
export const lightTheme: NekoTheme = createTheme(LIGHT_PALETTE);

const THEMES: Record<ThemeMode, NekoTheme> = { dark: darkTheme, light: lightTheme };

let activeMode: ThemeMode = "dark";
let activeTheme: NekoTheme = darkTheme;

/** 切换当前主题;返回是否发生变化。已渲染组件需 invalidate 后重绘。 */
export function setActiveTheme(mode: ThemeMode): boolean {
	if (mode === activeMode) return false;
	activeMode = mode;
	activeTheme = THEMES[mode];
	return true;
}

export function getActiveThemeMode(): ThemeMode {
	return activeMode;
}

function delegate(name: ThemeSlotName): ThemeSlot {
	return (text: string) => activeTheme[name](text);
}

/** 组件使用的动态主题入口:槽位委托到当前激活主题,切换后自动生效。 */
export const theme: NekoTheme = Object.fromEntries(SLOT_NAMES.map((name) => [name, delegate(name)])) as NekoTheme;

/**
 * diff 行底色 ANSI(TUI 两层高亮的增删行着色层,配色取 diffAdded/diffRemoved 槽位的 bg)。
 * 语法 token 只发 39 前景重置,行底色跨段保持;gutter 的 49 重置后由调用方重铺。
 */
export function diffBackgroundAnsi(kind: "added" | "removed"): string {
	const style = (activeMode === "dark" ? DARK_PALETTE : LIGHT_PALETTE)[kind === "added" ? "diffAdded" : "diffRemoved"];
	return backgroundAnsi(parseColor(style.bg!), getTerminalColorMode());
}

export type LogoPalette = {
	readonly outline: string;
	readonly eye: string;
	readonly body: string;
	readonly shine: string;
	readonly spout: string;
	readonly shade: string;
	readonly belly: string;
	readonly cheek: string;
	readonly wordTop: string;
	readonly wordStart: string;
	readonly wordEnd: string;
};

const LIGHT_LOGO_PALETTE: LogoPalette = {
	outline: "#12265E",
	eye: "#0B1942",
	body: "#356BF6",
	shine: "#82B4FF",
	spout: "#7CC8FF",
	shade: "#BCE4FF",
	belly: "#FFFFFF",
	cheek: "#FF9BB3",
	wordTop: "#2862DF",
	wordStart: "#3874EB",
	wordEnd: "#AACBF8",
};

const DARK_LOGO_PALETTE: LogoPalette = {
	outline: "#1E4294",
	eye: "#0B1942",
	body: "#4E8BFF",
	shine: "#94C2FF",
	spout: "#78CBFF",
	shade: "#9ED4FF",
	belly: "#F0F7FF",
	cheek: "#FF8FAB",
	wordTop: "#66A0FF",
	wordStart: "#66A0FF",
	wordEnd: "#3D6BC2",
};

const pixelColorCache = new Map<string, Color>();

function cachedColor(hex: string): Color {
	let parsed = pixelColorCache.get(hex);
	if (parsed === undefined) {
		parsed = parseColor(hex);
		pixelColorCache.set(hex, parsed);
	}
	return parsed;
}

export function getLogoPalette(): LogoPalette {
	return activeMode === "dark" ? DARK_LOGO_PALETTE : LIGHT_LOGO_PALETTE;
}

/**
 * 将像素颜色矩阵（每格为 `#RRGGBB` 或 `null` 透明）按两行一组编码为终端半高块（`▀`/`▄`/`█`）。
 * 透明像素只重置前景/背景（`\x1b[39m` / `\x1b[49m`），透出终端自身底色与壁纸。
 */
export function renderHalfBlockRows(rows: readonly (readonly (string | null)[])[]): string[] {
	const mode = getTerminalColorMode();
	const out: string[] = [];
	for (let y = 0; y < rows.length; y += 2) {
		const top = rows[y] ?? [];
		const bottom = rows[y + 1] ?? [];
		const width = Math.max(top.length, bottom.length);
		let line = "";
		for (let x = 0; x < width; x++) {
			const t = top[x] ?? null;
			const b = bottom[x] ?? null;
			if (t === null && b === null) {
				line += " ";
			} else if (t !== null && b === null) {
				line += `${foregroundAnsi(cachedColor(t), mode)}▀\x1b[39m`;
			} else if (t === null && b !== null) {
				line += `${foregroundAnsi(cachedColor(b), mode)}▄\x1b[39m`;
			} else if (t === b && t !== null) {
				line += `${foregroundAnsi(cachedColor(t), mode)}${backgroundAnsi(cachedColor(t), mode)}█\x1b[39m\x1b[49m`;
			} else if (t !== null && b !== null) {
				line += `${foregroundAnsi(cachedColor(t), mode)}${backgroundAnsi(cachedColor(b), mode)}▀\x1b[39m\x1b[49m`;
			}
		}
		out.push(line.replace(/ +$/, ""));
	}
	return out;
}

// bold/italic/strikethrough/underline 是无色属性:SGR 开关不随主题变化,本地实现。
const sgr =
	(attrs: SlotStyle): ThemeSlot =>
	(text) =>
		styleText(
			text,
			{
				...(attrs.bold !== undefined ? { bold: attrs.bold } : {}),
				...(attrs.italic !== undefined ? { italic: attrs.italic } : {}),
				...(attrs.strikethrough !== undefined ? { strikethrough: attrs.strikethrough } : {}),
				...(attrs.underline !== undefined ? { underline: attrs.underline } : {}),
			},
			getTerminalColorMode(),
		);

const boldText = sgr({ bold: true });
const italicText = sgr({ italic: true });
const strikethroughText = sgr({ strikethrough: true });
const underlineText = sgr({ underline: true });

/** 无色 SGR 属性助手(不随主题变化)。 */
export const style = {
	bold: boldText,
	italic: italicText,
	strikethrough: strikethroughText,
	underline: underlineText,
};
