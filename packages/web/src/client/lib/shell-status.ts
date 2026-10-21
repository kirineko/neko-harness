import type { NekoShellStatus } from "./contract.ts";
import { getT } from "./i18n/index.ts";

/** Chat-page banner text; undefined = nothing to warn about (ready, or the gateway does not report a shell). */
export function shellBannerText(shell: NekoShellStatus | null): string | undefined {
	if (shell?.status !== "missing") return undefined;
	const t = getT();
	if (shell.reason === "invalid_config")
		return t("shell.invalid", { detail: shell.detail ?? t("shell.invalidDefault") });
	return t("shell.missing");
}

export type ShellRow = { label: string; tone: "ok" | "warn"; detail: string };

/** About-page row; null = the gateway does not report a shell (non-Windows or an older gateway). */
export function shellRow(shell: NekoShellStatus | null): ShellRow | null {
	if (shell === null) return null;
	const t = getT();
	if (shell.status === "ready")
		return {
			label: t("shell.ready"),
			tone: "ok",
			detail: t(shell.source === "config" ? "shell.sourceConfig" : "shell.sourceAuto", { path: shell.path }),
		};
	return { label: t("shell.unavailable"), tone: "warn", detail: shellBannerText(shell) ?? "" };
}
