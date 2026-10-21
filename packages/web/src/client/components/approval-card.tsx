import type { ToolApproval } from "@neko-harness/core";
import { useRef, useState } from "react";
import { useT } from "../lib/i18n/index.ts";

const display = (text: string) =>
	[...text]
		.map((c) => {
			const n = c.charCodeAt(0);
			return (n < 32 && n !== 9 && n !== 10) ||
				(n >= 127 && n <= 159) ||
				(n >= 8234 && n <= 8238) ||
				(n >= 8294 && n <= 8297)
				? `\\u${n.toString(16).padStart(4, "0")}`
				: c;
		})
		.join("");
export function ApprovalCard({
	item,
	title,
	decide,
}: {
	item: ToolApproval;
	title: string;
	decide: (decision: "allowed" | "denied") => Promise<unknown>;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const sending = useRef(false);
	const submit = async (decision: "allowed" | "denied") => {
		if (sending.current || item.status !== "pending") return;
		sending.current = true;
		setBusy(true);
		setError("");
		try {
			await decide(decision);
		} catch (e) {
			setError(String(e));
		} finally {
			sending.current = false;
			setBusy(false);
		}
	};
	return (
		<section
			aria-label={t("approval.section")}
			className="min-w-0 rounded-xl border border-sakura-200 bg-surface p-3 text-sm"
		>
			<output className="block font-medium text-sakura-800">
				{title} · Bash · {t(`approval.status.${item.status}`)}
			</output>
			<p className="break-all text-xs text-ink-500">
				{display(item.cwd)} · {t("approval.timeout", { value: item.timeout ?? t("approval.timeoutDefault") })}
			</p>
			<textarea
				readOnly
				rows={Math.min(6, Math.max(1, item.command.split("\n").length))}
				aria-label={t("approval.command")}
				value={display(item.command)}
				className="focus-neko my-2 w-full resize-y whitespace-pre-wrap break-all rounded-lg bg-base p-2 font-mono text-xs"
			/>
			{item.status === "pending" && (
				<div className="flex gap-2">
					<button
						type="button"
						disabled={busy}
						className="focus-neko rounded-lg bg-tianyi-100 px-3 py-1 text-tianyi-800 disabled:opacity-50"
						onClick={() => void submit("allowed")}
					>
						{t("approval.allow")}
					</button>
					<button
						type="button"
						disabled={busy}
						className="focus-neko rounded-lg border border-sakura-300 px-3 py-1 disabled:opacity-50"
						onClick={() => void submit("denied")}
					>
						{t("approval.deny")}
					</button>
				</div>
			)}
			{error && (
				<p role="alert" className="break-all text-xs text-sakura-800">
					{error}
				</p>
			)}
		</section>
	);
}
