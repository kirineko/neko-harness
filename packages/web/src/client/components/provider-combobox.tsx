import { useEffect, useId, useState } from "react";
import { useT } from "../lib/i18n/index.ts";
import { filterProviderOptions, type ProviderOption } from "../lib/providers";
import { Icon } from "./primitives";

const TONE = { on: "text-tianyi-800", warn: "text-sakura-800", off: "text-ink-400" } as const;

/** ARIA list-autocomplete combobox: type to filter, arrows to move, Enter to pick, Escape to close. */
export function ProviderCombobox(props: {
	label: string;
	options: readonly ProviderOption[];
	value: string | null;
	onChange: (id: string) => void;
	disabled?: boolean;
}) {
	const { options, value } = props;
	const t = useT();
	const base = useId();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	const selected = options.find((option) => option.id === value);
	const shown = open ? filterProviderOptions(options, query ?? "") : [];
	const activeId = open && shown[active] ? `${base}-${active}` : undefined;
	const listId = `${base}-list`;

	useEffect(() => {
		if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
	}, [activeId]);

	function show(from = 0) {
		const index = options.findIndex((option) => option.id === value);
		setActive(query === null && index >= 0 ? index : from);
		setOpen(true);
	}
	function close() {
		setOpen(false);
		setQuery(null);
	}
	function pick(option: ProviderOption) {
		props.onChange(option.id);
		close();
	}
	function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		const last = shown.length - 1;
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp": {
				event.preventDefault();
				if (!open) return show();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActive(last < 0 ? 0 : (active + step + shown.length) % shown.length);
				return;
			}
			case "Home":
			case "End":
				if (!open || query !== null) return;
				event.preventDefault();
				setActive(event.key === "Home" ? 0 : Math.max(last, 0));
				return;
			case "Enter": {
				if (!open) return;
				event.preventDefault();
				const option = shown[active];
				if (option) pick(option);
				return;
			}
			case "Escape":
				if (!open) return;
				// 只关闭下拉，不让外层对话框也被取消。
				event.preventDefault();
				event.stopPropagation();
				close();
		}
	}

	return (
		<div className="relative min-w-0">
			<div className="relative">
				<input
					type="text"
					role="combobox"
					aria-label={props.label}
					aria-expanded={open}
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={activeId}
					autoComplete="off"
					spellCheck={false}
					disabled={props.disabled}
					value={query ?? selected?.name ?? ""}
					placeholder={t("providerCombo.placeholder")}
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
						setOpen(true);
					}}
					onFocus={(event) => event.currentTarget.select()}
					onClick={(event) => {
						if (open) return close();
						show();
						event.currentTarget.select();
					}}
					onKeyDown={onKeyDown}
					onBlur={close}
					className="focus-neko w-full min-w-0 cursor-pointer rounded-xl border border-sakura-200 bg-base py-2 pr-9 pl-3 text-sm font-semibold text-ink-900"
				/>
				<span
					aria-hidden="true"
					className={`pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-500 transition-transform ${open ? "rotate-180" : ""}`}
				>
					<Icon name="chevron" size={16} />
				</span>
			</div>
			{/* 键盘操作都在 combobox 输入框上完成（aria-activedescendant），列表本身不取得焦点。 */}
			<div
				id={listId}
				role="listbox"
				tabIndex={-1}
				aria-label={props.label}
				hidden={!open}
				onMouseDown={(event) => event.preventDefault()}
				className="absolute top-full right-0 left-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-xl border border-sakura-200 bg-surface p-1 shadow-soft"
			>
				{shown.map((option, index) => (
					// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input
					<div
						key={option.id}
						id={`${base}-${index}`}
						role="option"
						tabIndex={-1}
						aria-selected={option.id === value}
						onMouseEnter={() => setActive(index)}
						onClick={() => pick(option)}
						className={`flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${index === active ? "bg-sakura-50" : ""} ${option.id === value ? "font-semibold text-sakura-800" : "text-ink-700"}`}
					>
						<span className="min-w-0 flex-1 truncate">{option.name}</span>
						{option.detail && <span className={`shrink-0 text-xs ${TONE[option.tone ?? "off"]}`}>{option.detail}</span>}
					</div>
				))}
				{open && shown.length === 0 && <p className="px-2.5 py-2 text-xs text-ink-500">{t("providerCombo.empty")}</p>}
			</div>
		</div>
	);
}
