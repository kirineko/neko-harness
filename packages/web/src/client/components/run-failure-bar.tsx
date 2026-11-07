import type { WireRunFailure } from "@neko-harness/gateway/contract";
import { DICTIONARIES, type PlainKey, useT } from "../lib/i18n/index.ts";

type Props = {
	failure: WireRunFailure;
	/** A continue request is in flight. */
	pending: boolean;
	onContinue(): void;
};

/** Reasons that continuing cannot fix: the context has nothing to answer. */
const NOT_CONTINUABLE = new Set(["nothing_to_answer"]);

/** Why the last run ended without an answer, with "Continue" to run again on the same context. Plain text only. */
export function RunFailureBar({ failure, pending, onContinue }: Props) {
	const t = useT();
	// A reason a newer Pi adds is shown as its code until the dictionaries learn it.
	const key = `runFailure.reason.${failure.reason}`;
	const reason = key in DICTIONARIES.zh ? t(key as PlainKey) : failure.reason;
	return (
		<section
			aria-label={t("runFailure.section")}
			data-run-failure={failure.reason}
			className="mb-2 flex min-w-0 items-center gap-2 rounded-2xl border border-sakura-200 bg-base/90 px-3 py-1.5 text-sm"
		>
			<span className="min-w-0 flex-1">
				<span className="font-medium text-ink-800">{reason}</span>
				{failure.detail && (
					<span className="ml-2 break-words text-ink-600" title={failure.detail}>
						{failure.detail}
					</span>
				)}
			</span>
			{!NOT_CONTINUABLE.has(failure.reason) && (
				<button
					type="button"
					disabled={pending}
					aria-label={t("runFailure.continueAria")}
					onClick={onContinue}
					className="focus-neko h-8 shrink-0 rounded-full px-3 text-xs text-sakura-700 hover:bg-sakura-50 disabled:opacity-50"
				>
					{t("runFailure.continue")}
				</button>
			)}
		</section>
	);
}
