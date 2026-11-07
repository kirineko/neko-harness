import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ContinueClient } from "@neko-harness/gateway/client-session";
import type { WireRunFailure } from "@neko-harness/gateway/contract";
import { localizeError } from "./i18n/core-text.ts";
import { hasMessage, type PlainKey, t } from "./i18n/index.ts";
import { theme } from "./theme/index.ts";

/** Reasons that continuing cannot fix: the context has nothing to answer. */
const NOT_CONTINUABLE = new Set(["nothing_to_answer"]);

/** The reason in the interface language; a reason a newer Pi adds is shown as its code. */
export function runFailureReason(reason: string): string {
	const key = `runFailure.reason.${reason}`;
	return hasMessage(key) ? t(key as PlainKey) : reason;
}

/** One line above the editor: why the last run ended without an answer, and `/continue` when it can help. */
export class RunFailureRow implements Component {
	#failure: WireRunFailure | undefined;

	set(failure: WireRunFailure | undefined): void {
		this.#failure = failure;
	}
	get visible(): boolean {
		return this.#failure !== undefined;
	}

	render(width: number): string[] {
		const failure = this.#failure;
		if (!failure) return [];
		const detail = failure.detail ? `: ${failure.detail.replace(/\s+/g, " ").trim()}` : "";
		const hint = NOT_CONTINUABLE.has(failure.reason) ? "" : theme.dim(` · ${t("runFailure.hint")}`);
		return [truncateToWidth(` ${theme.warning(`${runFailureReason(failure.reason)}${detail}`)}${hint}`, width)];
	}
	invalidate(): void {}
}

/** `/continue`: starts the run, or returns the notice to show (an older gateway, a refusal, a failure). */
export async function continueCommand(
	client: Pick<ContinueClient, "supported" | "continueRun">,
): Promise<string | undefined> {
	if (!client.supported) return t("core.unsupported.continue");
	try {
		await client.continueRun();
		return undefined;
	} catch (error) {
		return localizeError(error instanceof Error ? error.message : String(error));
	}
}
