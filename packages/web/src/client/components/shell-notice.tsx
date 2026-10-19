import { useState } from "react";
import { shellBannerText } from "../lib/shell-status";
import { useNekoState } from "../lib/store";
import { DismissButton } from "./primitives";

export function ShellNotice() {
	const { shell } = useNekoState();
	// 仅本次页面内关闭；状态或原因变化（文案不同）会重新提示。
	const [dismissed, setDismissed] = useState<string | null>(null);
	const text = shellBannerText(shell);
	if (text === undefined || dismissed === text) return null;
	return (
		<div
			className="discrete-in flex items-center gap-2 border-b border-sakura-300 bg-sakura-100 py-1 pr-2 pl-9 text-xs text-sakura-900"
			role="alert"
			data-shell-notice
		>
			<span className="min-w-0 flex-1 text-center">{text}</span>
			<DismissButton label="关闭 shell 提示" onClick={() => setDismissed(text)} />
		</div>
	);
}
