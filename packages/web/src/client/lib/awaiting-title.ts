import { useEffect } from "react";
import { useLanguage } from "./language.ts";
import { attentionTitle } from "./plan-ui.ts";

/**
 * While the tab is hidden and the session waits for an answer or a plan decision, prefix the page title; restore it
 * once that settles or the tab is visible again. Passive only: no sound and no Notification permission.
 */
export function useAwaitingTitle(pending: number, plan = false): void {
	const language = useLanguage();
	// biome-ignore lint/correctness/useExhaustiveDependencies: a language change must re-derive the title prefix
	useEffect(() => {
		let applied: { base: string; title: string } | null = null;
		const sync = () => {
			const current = document.title;
			// A title that changed in the meantime is not ours to overwrite or restore.
			const base = applied !== null && current === applied.title ? applied.base : current;
			if (!(document.hidden && (pending > 0 || plan))) {
				if (applied !== null && current === applied.title) document.title = base;
				applied = null;
				return;
			}
			const title = attentionTitle(base, pending, plan);
			document.title = title;
			applied = { base, title };
		};
		sync();
		document.addEventListener("visibilitychange", sync);
		return () => {
			document.removeEventListener("visibilitychange", sync);
			if (applied !== null && document.title === applied.title) document.title = applied.base;
		};
	}, [pending, plan, language]);
}
