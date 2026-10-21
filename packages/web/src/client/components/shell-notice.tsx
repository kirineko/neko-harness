import { useState } from "react";
import { useT } from "../lib/i18n/index.ts";
import { shellBannerText } from "../lib/shell-status";
import { useNekoState } from "../lib/store";
import { DismissButton } from "./primitives";

export function ShellNotice() {
	const { shell } = useNekoState();
	const t = useT();
	// 仅本次页面内关闭；状态或原因变化会重新提示（以状态而非文案为键，切换语言不会让它重现）。
	const [dismissed, setDismissed] = useState<string | null>(null);
	const text = shellBannerText(shell);
	const key = shell?.status === "missing" ? JSON.stringify([shell.reason, shell.detail]) : null;
	if (text === undefined || dismissed === key) return null;
	return (
		<div
			className="discrete-in flex items-center gap-2 border-b border-sakura-300 bg-sakura-100 py-1 pr-2 pl-9 text-xs text-sakura-900"
			role="alert"
			data-shell-notice
		>
			<span className="min-w-0 flex-1 text-center">{text}</span>
			<DismissButton label={t("shell.dismiss")} onClick={() => setDismissed(key)} />
		</div>
	);
}
