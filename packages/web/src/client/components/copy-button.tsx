import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../lib/clipboard";
import { useT } from "../lib/i18n/index.ts";
import { Icon } from "./primitives";

type CopyState = "idle" | "copied" | "failed";
const STATUS_MS = 1500;

/** 气泡下方的复制按钮；状态文字放进 aria-live 区域，按钮名称保持稳定。 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
	const t = useT();
	const name = label ?? t("copy.label");
	const [state, setState] = useState<CopyState>("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	if (text === "") return null;
	const show = (next: CopyState) => {
		setState(next);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), STATUS_MS);
	};
	return (
		<span className="copy-row" data-state={state}>
			<button
				type="button"
				className="copy-btn focus-neko"
				aria-label={name}
				title={name}
				onClick={() => {
					writeClipboard(text).then(
						() => show("copied"),
						() => show("failed"),
					);
				}}
			>
				<Icon name={state === "copied" ? "check" : "copy"} size={15} />
			</button>
			<output className="copy-status" aria-live="polite">
				{state === "copied" ? t("copy.copied") : state === "failed" ? t("copy.failed") : ""}
			</output>
		</span>
	);
}
