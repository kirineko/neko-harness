import { useEffect, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import type { NekoDirectoryPage } from "../lib/contract";
import { useT } from "../lib/i18n/index.ts";
import { pathCrumbs } from "../lib/path-crumbs";
import { folderName, Icon, Modal } from "./primitives";

export function WorkspacePicker({ initialPath, onClose }: { initialPath: string; onClose: () => void }) {
	const t = useT();
	const [path, setPath] = useState(initialPath);
	const [input, setInput] = useState(initialPath);
	const [query, setQuery] = useState("");
	const [hidden, setHidden] = useState(false);
	const [page, setPage] = useState<NekoDirectoryPage | null>(null);
	const [loading, setLoading] = useState(true);
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState("");
	const [retry, setRetry] = useState(0);
	const generation = useRef(0);
	const pathInput = useRef<HTMLInputElement>(null);
	const addingRef = useRef(false);
	useEffect(() => {
		void retry; // Explicit retry reissues the current directory request.
		const current = ++generation.current;
		setLoading(true);
		setError("");
		setPage(null);
		void appActions.browse({ path, query, showHidden: hidden }).then(
			(result) => {
				if (current !== generation.current) return;
				setPage(result);
				setInput((value) => (value === path ? result.path : value));
				setLoading(false);
			},
			(e: unknown) => {
				if (current === generation.current) {
					setError(String(e));
					setLoading(false);
				}
			},
		);
		return () => {
			++generation.current;
		};
	}, [path, query, hidden, retry]);
	const navigate = (next: string) => {
		pathInput.current?.focus();
		setPath(next);
		setInput(next);
		setQuery("");
		setRetry((r) => r + 1);
	};
	const more = async () => {
		if (!page?.next || loading) return;
		const current = ++generation.current;
		setLoading(true);
		setError("");
		try {
			const result = await appActions.browse({ path, query, showHidden: hidden, cursor: page.next });
			if (current === generation.current) setPage({ ...result, entries: [...page.entries, ...result.entries] });
		} catch (e) {
			if (current === generation.current) setError(String(e));
		} finally {
			if (current === generation.current) setLoading(false);
		}
	};
	const add = async () => {
		if (!page || loading || addingRef.current) return;
		addingRef.current = true;
		setAdding(true);
		setError("");
		try {
			await appActions.addWorkspace(page.path);
			onClose();
		} catch (e) {
			setError(String(e));
		} finally {
			addingRef.current = false;
			setAdding(false);
		}
	};
	const { root, rootLabel, crumbs } = pathCrumbs(page?.path ?? path);
	return (
		<Modal title={t("sessions.addWorkspace")} onClose={onClose} locked={adding}>
			<div className="picker-controls">
				<p className="text-ink-500">{t("picker2.hint")}</p>
				<nav className="breadcrumbs" aria-label={t("picker2.pathNav")}>
					<button type="button" disabled={adding} onClick={() => navigate(root)}>
						{rootLabel}
					</button>
					{crumbs.map((crumb) => (
						<button type="button" key={crumb.path} disabled={adding} onClick={() => navigate(crumb.path)}>
							{crumb.label} /
						</button>
					))}
				</nav>
				<form
					className="path-form"
					onSubmit={(e) => {
						e.preventDefault();
						navigate(input);
					}}
				>
					<input
						ref={pathInput}
						aria-label={t("picker2.fullPath")}
						value={input}
						disabled={adding}
						onChange={(e) => setInput(e.target.value)}
					/>
					<button className="btn-outline" type="submit" disabled={adding}>
						{t("picker2.go")}
					</button>
				</form>
				<div className="filter-row">
					<input
						aria-label={t("picker2.filter")}
						placeholder={t("picker2.filterPlaceholder")}
						value={query}
						disabled={adding}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<label>
						<input type="checkbox" checked={hidden} disabled={adding} onChange={(e) => setHidden(e.target.checked)} />
						{t("picker2.hidden")}
					</label>
				</div>
			</div>
			<fieldset
				className="folder-list"
				aria-label={t("picker2.list")}
				aria-busy={loading}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
					const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
					buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
				}}
			>
				{error && (
					<div role="alert" className="error-text">
						{error}
						<button type="button" className="btn-outline" disabled={adding} onClick={() => setRetry((r) => r + 1)}>
							{t("common.retry")}
						</button>
					</div>
				)}
				{page?.parent && (
					<button
						type="button"
						className="chrome-row"
						disabled={adding || loading}
						onClick={() => navigate(page.parent!)}
					>
						<Icon name="up" />
						{t("picker2.parent")}
					</button>
				)}
				{page?.entries.map((entry) => (
					<button
						type="button"
						className="chrome-row"
						key={entry.path}
						disabled={adding || loading || !!entry.error}
						title={entry.error ?? entry.path}
						onClick={() => navigate(entry.path)}
					>
						<Icon name="folder" />
						<span className="truncate min-w-0">{entry.name}</span>
						{entry.error && <span className="text-ink-500">{t("picker2.inaccessible")}</span>}
					</button>
				))}
				{loading && <output className="empty-text">{t("picker2.loading")}</output>}
				{!loading && page?.entries.length === 0 && <p className="empty-text">{t("picker2.noMatch")}</p>}
				{page?.next && (
					<button type="button" className="btn-outline" disabled={loading || adding} onClick={() => void more()}>
						{t("picker2.more")}
					</button>
				)}
			</fieldset>
			<div className="picker-footer">
				<div>
					<strong>{folderName(page?.path ?? path)}</strong>
					<p className="path-text">{page?.path ?? path}</p>
				</div>
				<div className="actions">
					<button type="button" className="btn-outline" disabled={adding} onClick={onClose}>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						className="btn-primary px-3 py-1.5"
						disabled={!page || loading || adding || !!error}
						onClick={() => void add()}
					>
						{adding ? t("picker2.adding") : t("picker2.choose")}
					</button>
				</div>
			</div>
		</Modal>
	);
}
