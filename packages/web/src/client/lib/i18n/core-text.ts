import { getT, type Translate } from "./index.ts";

/**
 * Maps the English strings core sends (projection status, system rows, tool-card notes and `CODE:` errors) to the
 * current UI language at display time. Core and the gateway stay untouched; unmatched text comes back unchanged.
 * The templates are pinned by test/core-text.test.ts against packages/core/test/fixtures/core-ui-strings.json.
 */

type Rule = { pattern: RegExp; render: (t: Translate, match: RegExpExecArray) => string };

const TEXT_RULES: readonly Rule[] = [
	{ pattern: /^Thinking\.\.\.$/, render: (t) => t("core.status.thinking") },
	{ pattern: /^Running (.+)\.\.\.$/, render: (t, m) => t("core.status.running", { tool: m[1] ?? "" }) },
	{
		pattern: /^Retrying \(attempt (\d+)\)\.\.\.$/,
		render: (t, m) => t("core.status.retrying", { attempt: m[1] ?? "" }),
	},
	{ pattern: /^\[context compacted\]$/, render: (t) => t("core.row.compacted") },
	{ pattern: /^\[new context\]$/, render: (t) => t("core.row.newContext") },
	{ pattern: /^Not run: response interrupted\.$/, render: (t) => t("core.note.notRun") },
];

/** Status line, system row or tool-card note → current language; anything else is returned as is. */
export function localizeCoreText(text: string, t: Translate = getT()): string {
	for (const rule of TEXT_RULES) {
		const match = rule.pattern.exec(text);
		if (match) return rule.render(t, match);
	}
	return text;
}

const ERROR_RULES: Record<string, Rule> = {
	PROVIDER_DISABLED: {
		pattern: /^(.+?) is not enabled\./,
		render: (t, m) => t("core.error.providerDisabled", { provider: m[1] ?? "" }),
	},
	PROVIDER_KEY_REQUIRED: {
		pattern: /^Configure an? (.+?) API key\b/,
		render: (t, m) => t("core.error.providerKeyRequired", { provider: m[1] ?? "" }),
	},
	PLAN_BUSY: { pattern: /^/, render: (t) => t("core.error.planBusy") },
	WORKSPACE_UNKNOWN: { pattern: /^/, render: (t) => t("core.error.workspaceUnknown") },
	WORKSPACE_LAST: { pattern: /^/, render: (t) => t("core.error.workspaceLast") },
	WORKSPACE_BUSY: { pattern: /^/, render: (t) => t("core.error.workspaceBusy") },
};

const CODE_PREFIX = /^([A-Z][A-Z_]+): ([\s\S]*)$/;

/** `CODE: English text` errors → current language, keyed by the code; unknown codes or unparsable text stay as is. */
export function localizeCoreError(message: string, t: Translate = getT()): string {
	const prefix = CODE_PREFIX.exec(message);
	const rule = prefix?.[1] !== undefined ? ERROR_RULES[prefix[1]] : undefined;
	if (!prefix || !rule) return message;
	const match = rule.pattern.exec(prefix[2] ?? "");
	return match ? rule.render(t, match) : message;
}
