import {
	JOBS_UNSUPPORTED,
	PLAN_UNSUPPORTED,
	QUESTIONS_UNSUPPORTED,
	QUEUE_UNSUPPORTED,
	TODOS_UNSUPPORTED,
} from "@neko-harness/gateway/client-session";
import { type PlainKey, t } from "./index.ts";

/**
 * Maps the English strings core and the gateway client send to the current interface language at display time.
 * The wording is pinned by `packages/core/test/fixtures/core-ui-strings.json`; unmatched text is returned as is.
 */

const STATUS: readonly { pattern: RegExp; show: (match: RegExpMatchArray) => string }[] = [
	{ pattern: /^Thinking\.\.\.$/, show: () => t("core.status.thinking") },
	{ pattern: /^Running (.+)\.\.\.$/, show: (m) => t("core.status.running", { tool: m[1] ?? "" }) },
	{ pattern: /^Retrying \(attempt (\d+)\)\.\.\.$/, show: (m) => t("core.status.retrying", { attempt: m[1] ?? "" }) },
];

const EXACT: ReadonlyMap<string, PlainKey> = new Map<string, PlainKey>([
	["[context compacted]", "core.system.compacted"],
	["[new context]", "core.system.newContext"],
	["Not run: response interrupted.", "core.note.notRun"],
	[JOBS_UNSUPPORTED, "core.unsupported.jobs"],
	[QUEUE_UNSUPPORTED, "core.unsupported.queue"],
	[TODOS_UNSUPPORTED, "core.unsupported.todos"],
	[QUESTIONS_UNSUPPORTED, "core.unsupported.questions"],
	[PLAN_UNSUPPORTED, "core.unsupported.plan"],
	["PLAN_BUSY: Wait for the current run to finish or stop it first.", "core.error.planBusy"],
]);

const ERRORS: readonly { pattern: RegExp; show: (match: RegExpMatchArray) => string }[] = [
	{
		pattern: /^PROVIDER_DISABLED: (.+) is not enabled\. Enable it in \/login or Web settings, or switch model\.$/,
		show: (m) => t("core.error.providerDisabled", { name: m[1] ?? "" }),
	},
	{
		pattern: /^PROVIDER_DISABLED: (.+) is not enabled\.$/,
		show: (m) => t("core.error.providerDisabledShort", { name: m[1] ?? "" }),
	},
	{
		pattern: /^PROVIDER_KEY_REQUIRED: Configure (an?) (.+) API key in \/login or Web settings\.$/,
		show: (m) =>
			t(m[1] === "an" ? "core.error.providerKeyRequiredAn" : "core.error.providerKeyRequired", { name: m[2] ?? "" }),
	},
];

/** Run status (`view.status`) in the current language. */
export function localizeStatus(text: string): string {
	for (const { pattern, show } of STATUS) {
		const match = text.match(pattern);
		if (match) return show(match);
	}
	return text;
}

/** Fixed core and gateway strings (system rows, tool notes, "gateway does not support" notices). */
export function localizeCoreText(text: string): string {
	const key = EXACT.get(text);
	return key === undefined ? text : t(key);
}

/** Errors that core raises with a `CODE:` prefix; any other message is returned as is. */
export function localizeError(message: string): string {
	for (const { pattern, show } of ERRORS) {
		const match = message.match(pattern);
		if (match) return show(match);
	}
	return localizeCoreText(message);
}
