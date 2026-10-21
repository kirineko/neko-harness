import { getT, type PlainKey, type Translate } from "./index.ts";

/**
 * Strings the local Web server (src/open-target.ts) sends for the open-workspace menu: file manager labels and
 * launch failure reasons. The server stays untouched; unknown text is shown as is.
 */
export const EXPLORER_LABEL = "资源管理器";

const KNOWN: Record<string, PlainKey> = {
	[EXPLORER_LABEL]: "open.explorer",
	文件管理器: "open.fileManager",
	"未找到 VS Code（Code.exe）": "open.noVscodeExe",
	"未找到 VS Code（命令 code 不在 PATH 中）": "open.noVscodeCommand",
	"未找到 explorer.exe（需启用 Windows 互操作）": "open.noExplorer",
	"未找到 xdg-open": "open.noXdg",
};

export function localizeServerText(text: string, t: Translate = getT()): string {
	const key = KNOWN[text];
	return key === undefined ? text : t(key);
}
