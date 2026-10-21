import type { ChatView } from "@neko-harness/core";
import type { StatusTone } from "./components/footer.ts";
import { localizeError } from "./i18n/core-text.ts";
import { t } from "./i18n/index.ts";

/** Footer text and colour for the compaction state; recent results fade out after 10s, apply-pending ones stay. */
export function compactionStatus(
	compaction: ChatView["compaction"],
	now: number = Date.now(),
): { text: string; tone: StatusTone } | undefined {
	if (!compaction) return undefined;
	if (compaction.active.length) {
		const text = compaction.active.some((c) => c.retry)
			? t("compaction.retrying")
			: compaction.active.some((c) => c.blocking)
				? t("compaction.waiting")
				: t("compaction.running");
		return { text, tone: "warning" };
	}
	if (compaction.failure)
		return { text: t("compaction.failedWith", { error: localizeError(compaction.failure.error) }), tone: "error" };
	const latest = compaction.latest;
	if (!latest || !(latest.phase === "waiting-to-apply" || now - latest.at < 10000)) return undefined;
	switch (latest.phase) {
		case "applied":
			return { text: t("compaction.applied"), tone: "ok" };
		case "nothing":
			return { text: t("compaction.nothing"), tone: "ok" };
		case "skipped":
			return { text: t("compaction.skipped"), tone: "ok" };
		case "cancelled":
			return { text: t("compaction.cancelled"), tone: "ok" };
		case "failed":
			return { text: t("compaction.failed"), tone: "error" };
		case "summarizing":
			return { text: t("compaction.running"), tone: "warning" };
		default:
			return { text: t("compaction.applying"), tone: "warning" };
	}
}
