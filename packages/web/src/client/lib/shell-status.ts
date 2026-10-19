import type { NekoShellStatus } from "./contract.ts";

/** Chat-page banner text; undefined = nothing to warn about (ready, or the gateway does not report a shell). */
export function shellBannerText(shell: NekoShellStatus | null): string | undefined {
	if (shell?.status !== "missing") return undefined;
	if (shell.reason === "invalid_config")
		return `${shell.detail ?? "shell.path 配置无效。"}bash 与后台任务不可用，请修正 neko.config.json 中的 shell.path。`;
	return "未找到 Git Bash：bash 与后台任务不可用。请安装 Git for Windows，或在 neko.config.json 中设置 shell.path。";
}

export type ShellRow = { label: string; tone: "ok" | "warn"; detail: string };

/** About-page row; null = the gateway does not report a shell (non-Windows or an older gateway). */
export function shellRow(shell: NekoShellStatus | null): ShellRow | null {
	if (shell === null) return null;
	if (shell.status === "ready")
		return {
			label: "已就绪",
			tone: "ok",
			detail: `${shell.path}（${shell.source === "config" ? "配置 shell.path" : "自动检测"}）`,
		};
	return { label: "不可用", tone: "warn", detail: shellBannerText(shell) ?? "" };
}
