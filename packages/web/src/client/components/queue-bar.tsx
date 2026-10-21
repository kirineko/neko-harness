import type { WireQueuedInput } from "@neko-harness/gateway/contract";
import { useT } from "../lib/i18n/index.ts";

type Props = {
	queued: readonly WireQueuedInput[];
	/** An operation is in flight; the buttons wait for it. */
	busy: boolean;
	onSteer(item: WireQueuedInput): void;
	onWithdraw(item: WireQueuedInput): void;
};

/** Messages accepted while the run is busy and not yet in the transcript; the host is the source of truth. */
export function QueueBar({ queued, busy, onSteer, onWithdraw }: Props) {
	const t = useT();
	if (!queued.length) return null;
	const modeLabel = (mode: WireQueuedInput["mode"]) => t(`queue.mode.${mode}`);
	return (
		<section
			aria-label={t("queue.section")}
			className="mb-2 rounded-2xl border border-sakura-200 bg-base/90 px-2 py-1.5"
		>
			<ul className="flex max-h-32 flex-col gap-1 overflow-y-auto">
				{queued.map((item) => {
					const label = item.preview || (item.images ? t("queue.image") : "");
					return (
						<li key={item.id} className="flex min-w-0 items-center gap-1 text-sm">
							<span
								className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${item.mode === "steer" ? "bg-sakura-100 text-sakura-700" : "bg-tianyi-50 text-ink-600"}`}
							>
								{modeLabel(item.mode)}
							</span>
							<span className="min-w-0 flex-1 truncate text-ink-700" title={item.preview}>
								{item.preview || (item.images ? t("queue.imageOnly") : "")}
							</span>
							{item.images > 0 && item.preview && (
								<span className="shrink-0 text-xs text-ink-500">{t("queue.images", { count: item.images })}</span>
							)}
							{item.mode === "followUp" && (
								<button
									type="button"
									disabled={busy}
									aria-label={t("queue.steerAria", { label })}
									title={t("queue.steerTitle")}
									onClick={() => onSteer(item)}
									className="focus-neko h-8 shrink-0 rounded-full px-2 text-xs text-sakura-700 hover:bg-sakura-50 disabled:opacity-50"
								>
									{t("queue.steer")}
								</button>
							)}
							<button
								type="button"
								disabled={busy}
								aria-label={t("queue.withdrawAria", { mode: modeLabel(item.mode), label })}
								onClick={() => onWithdraw(item)}
								className="focus-neko h-8 shrink-0 rounded-full px-2 text-xs text-ink-600 hover:bg-sakura-50 disabled:opacity-50"
							>
								{t("queue.withdraw")}
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
