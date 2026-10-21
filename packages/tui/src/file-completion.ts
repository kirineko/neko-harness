import { type AutocompleteProvider, CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import { type FileCandidates, mentionAt, mentionValue } from "@neko-harness/core/file-mentions";
import { t } from "./i18n/index.ts";
/** Native editor insertion/quoting, with gateway-backed @ enumeration. */
export function fileCompletion(
	commands: SlashCommand[],
	root: string,
	notice: (text: string) => void,
	search: (query: string, signal: AbortSignal) => Promise<FileCandidates>,
): AutocompleteProvider {
	const native = new CombinedAutocompleteProvider(commands, root, null);
	let lastNotice = "";
	const notify = (text: string) => {
		if (text !== lastNotice) {
			lastNotice = text;
			notice(text);
		}
	};
	return {
		triggerCharacters: ["@"],
		applyCompletion: native.applyCompletion.bind(native),
		shouldTriggerFileCompletion: native.shouldTriggerFileCompletion.bind(native),
		async getSuggestions(lines, line, col, options) {
			const token = mentionAt(lines[line] ?? "", col);
			if (!token) return native.getSuggestions(lines, line, col, options);
			try {
				const value = await search(token.query, options.signal);
				if (options.signal.aborted) return null;
				if (value.incomplete) notify(t("files.incomplete"));
				else if (value.limited) notify(t("files.limited"));
				else if (!value.entries.length) notify(t("files.none"));
				else lastNotice = "";
				return value.entries.length
					? {
							prefix: (lines[line] ?? "").slice(token.start, col),
							items: value.entries.map((item) => ({
								value: mentionValue(item.path, item.kind === "directory"),
								label: item.name + (item.kind === "directory" ? "/" : ""),
								description: item.path,
							})),
						}
					: null;
			} catch (error) {
				if (!options.signal.aborted)
					notify(error instanceof Error ? t("files.retrySearch", { message: error.message }) : t("files.failed"));
				return null;
			}
		},
	};
}
