import { useState } from "react";
import { useT } from "../lib/i18n/index.ts";

/** 思考过程：默认折叠为一行弱化斜体，点击展开（与 TUI 行为一致）。 */
export function ThinkingBlock({ text }: { text: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	if (text.trim() === "") return null;
	return (
		<div className="rounded-xl border border-dashed border-sakura-300 bg-sakura-50/70">
			<button
				type="button"
				onClick={() => {
					setOpen(!open);
				}}
				className="focus-neko flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-ink-600 italic"
			>
				<span aria-hidden>{open ? "▾" : "▸"}</span>
				{t("thinking.label")}
			</button>
			{open && <div className="px-3 pb-2 text-sm whitespace-pre-wrap text-ink-600 italic">{text}</div>}
		</div>
	);
}
