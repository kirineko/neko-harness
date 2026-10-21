import { type FileCandidate, type FileCandidates, type Mention, mentionAt } from "@neko-harness/core/file-mentions";
import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { getT } from "../lib/i18n/index.ts";
import { ComposerSuggestions } from "./composer-suggestions";

export function useFileMentions(
	textarea: RefObject<HTMLTextAreaElement | null>,
	anchor: RefObject<HTMLElement | null>,
	workspace: string,
	enabled: boolean,
	choose: (item: FileCandidate, token: Mention) => void,
) {
	const [token, setToken] = useState<Mention | null>(null);
	const [result, setResult] = useState<FileCandidates>({ entries: [], limited: false, incomplete: false });
	const [message, setMessage] = useState("");
	const [selected, setSelected] = useState(0);
	const [failed, setFailed] = useState(false);
	const request = useRef(0);
	const id = useId();
	const close = () => {
		request.current++;
		setToken(null);
		setResult({ entries: [], limited: false, incomplete: false });
		setSelected(0);
	};
	const refresh = () => {
		const el = textarea.current;
		if (!el || !enabled) return close();
		const next = mentionAt(el.value, el.selectionStart);
		if (!next) return close();
		if (token && next.start === token.start && next.end === token.end && next.query === token.query) return;
		request.current++;
		setResult({ entries: [], limited: false, incomplete: false });
		setMessage(getT()("mention.searching"));
		setFailed(false);
		setToken(next);
		setSelected(0);
	};
	useEffect(() => {
		if (!token || !enabled) {
			setToken(null);
			return;
		}
		const controller = new AbortController();
		const version = ++request.current;
		const timer = setTimeout(() => {
			void appActions
				.searchFiles(token.query, workspace, controller.signal)
				.then((value) => {
					if (controller.signal.aborted || version !== request.current) return;
					setResult(value);
					const t = getT();
					setMessage(
						value.incomplete
							? t("mention.incomplete")
							: value.entries.length
								? value.limited
									? t("mention.limited")
									: ""
								: t("mention.empty"),
					);
				})
				.catch((error) => {
					if (!controller.signal.aborted && version === request.current) {
						setFailed(true);
						const t = getT();
						setMessage(error instanceof Error ? t("mention.errorWith", { error: error.message }) : t("mention.error"));
					}
				});
		}, 120);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [token, workspace, enabled]);
	const accept = (item: FileCandidate) => {
		if (!token) return;
		choose(item, token);
		close();
	};
	const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (!token || event.nativeEvent.isComposing) return false;
		if (event.key === "Escape" || (event.key === "Tab" && (event.shiftKey || !result.entries.length))) {
			close();
			if (event.key === "Escape") event.preventDefault();
			return event.key === "Escape";
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setSelected((n) => Math.max(0, Math.min(result.entries.length - 1, n + (event.key === "ArrowDown" ? 1 : -1))));
			return true;
		}
		if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
			event.preventDefault();
			const item = result.entries[selected];
			if (item) accept(item);
			return true;
		}
		return false;
	};
	const panel =
		token && enabled ? (
			<ComposerSuggestions
				anchor={anchor}
				id={id}
				title={getT()("mention.title")}
				selected={selected}
				onSelect={setSelected}
				onAccept={(index) => {
					const item = result.entries[index];
					if (item) accept(item);
				}}
				items={result.entries.map((item) => ({
					key: item.path,
					label: `${item.kind === "directory" ? "▸" : "▤"} ${item.name}${item.kind === "directory" ? "/" : ""}`,
					description: item.path,
				}))}
				message={message}
				onRetry={
					failed
						? () => {
								request.current++;
								setFailed(false);
								setMessage(getT()("mention.searching"));
								setToken((current) => (current ? { ...current } : null));
							}
						: undefined
				}
			/>
		) : null;
	return {
		refresh,
		close,
		keyDown,
		panel,
		open: !!token,
		controls: token ? id : undefined,
		active: token && result.entries[selected] ? `${id}-${selected}` : undefined,
	};
}
