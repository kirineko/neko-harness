import { autoUpdate, FloatingPortal, flip, offset, shift, size, useFloating } from "@floating-ui/react";
import { type RefObject, useEffect } from "react";
import { useT } from "../lib/i18n/index.ts";

export type Suggestion = { key: string; label: string; description: string; badge?: string };

export function ComposerSuggestions({
	anchor,
	id,
	title,
	items,
	selected,
	onSelect,
	onAccept,
	message,
	onRetry,
}: {
	/** 定位参照（输入卡片容器），面板宽度与之对齐 */
	anchor: RefObject<HTMLElement | null>;
	id: string;
	title: string;
	items: Suggestion[];
	selected: number;
	onSelect: (index: number) => void;
	onAccept: (index: number) => void;
	message?: string;
	onRetry?: () => void;
}) {
	const t = useT();
	const { refs, floatingStyles, isPositioned } = useFloating({
		elements: { reference: anchor.current },
		placement: "top-start",
		whileElementsMounted: autoUpdate,
		middleware: [
			offset(8),
			flip(),
			shift({ padding: 12 }),
			size({
				padding: 12,
				apply({ availableHeight, availableWidth, rects, elements }) {
					Object.assign(elements.floating.style, {
						maxHeight: `${Math.max(0, Math.min(320, availableHeight))}px`,
						width: `${Math.min(rects.reference.width, availableWidth)}px`,
					});
				},
			}),
		],
	});
	useEffect(() => {
		document.getElementById(`${id}-${selected}`)?.scrollIntoView({ block: "nearest" });
	}, [id, selected]);
	return (
		<FloatingPortal>
			<div
				ref={refs.setFloating}
				style={{ ...floatingStyles, visibility: isPositioned ? "visible" : "hidden" }}
				className="z-50 overflow-y-auto rounded-xl border border-sakura-200 bg-base p-1.5 shadow-soft"
			>
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs text-ink-500">
					<span>{title}</span>
					<span>{t("suggest.hint")}</span>
				</div>
				<div id={id} role="listbox" tabIndex={-1} aria-label={title}>
					{items.map((item, index) => (
						<button
							key={item.key}
							type="button"
							role="option"
							id={`${id}-${index}`}
							aria-selected={index === selected}
							tabIndex={-1}
							title={item.description}
							onMouseDown={(e) => e.preventDefault()}
							onPointerMove={(e) => {
								// Do not select a row moved beneath a stationary pointer.
								if (e.pointerType === "mouse" && (e.movementX !== 0 || e.movementY !== 0)) onSelect(index);
							}}
							onClick={() => onAccept(index)}
							className={`block w-full rounded-lg px-3 py-2 text-left ${index === selected ? "bg-sakura-100" : ""}`}
						>
							<span className="flex min-w-0 items-center gap-1.5">
								<span className="truncate text-sm text-ink-900">{item.label}</span>
								{item.badge && (
									<span className="shrink-0 rounded-md bg-ink-100 px-1.5 py-0.5 text-xs text-ink-600">
										{item.badge}
									</span>
								)}
							</span>
							<span className="block truncate text-xs text-ink-500">{item.description}</span>
						</button>
					))}
				</div>
				{message && <output className="block break-words px-3 py-2 text-sm text-ink-500">{message}</output>}
				{onRetry && (
					<button
						type="button"
						className="px-3 py-2 text-sm text-ink-900 underline"
						onMouseDown={(event) => event.preventDefault()}
						onClick={onRetry}
					>
						{t("suggest.retryFiles")}
					</button>
				)}
			</div>
		</FloatingPortal>
	);
}
