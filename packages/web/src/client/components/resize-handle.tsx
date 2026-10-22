import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n/index.ts";
import { clampSidePanelWidth, SIDE_PANEL_MAX_VIEWPORT, SIDE_PANEL_WIDTH } from "../lib/layout.ts";

const RESIZING_CLASS = "is-resizing-panel";

/**
 * 右侧面板左边缘的宽度调整柄（只在桌面端显示）。面板根元素必须是定位元素（`relative`）且贴右缘：
 * 拖拽宽度 = 视口宽度 − 指针 x。拖拽中只调用 `onChange`，结束（松手 / 取消 / 丢失捕获 / 卸载）才 `onCommit`。
 */
export function ResizeHandle({
	width,
	onChange,
	onCommit,
	onReset,
}: {
	width: number;
	onChange: (width: number) => void;
	onCommit: () => void;
	onReset: () => void;
}) {
	const t = useT();
	const drag = useRef<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const commit = useRef(onCommit);
	commit.current = onCommit;

	const end = () => {
		if (drag.current === null) return;
		drag.current = null;
		document.body.classList.remove(RESIZING_CLASS);
		setDragging(false);
		commit.current();
	};
	const endRef = useRef(end);
	endRef.current = end;
	useEffect(() => () => endRef.current(), []);

	const onKeyDown = (event: KeyboardEvent) => {
		const next =
			event.key === "ArrowLeft"
				? width + SIDE_PANEL_WIDTH.step
				: event.key === "ArrowRight"
					? width - SIDE_PANEL_WIDTH.step
					: event.key === "Home"
						? SIDE_PANEL_WIDTH.min
						: event.key === "End"
							? SIDE_PANEL_WIDTH.max
							: null;
		if (next === null) return;
		event.preventDefault();
		event.stopPropagation();
		onChange(clampSidePanelWidth(next));
		onCommit();
	};
	const onPointerDown = (event: PointerEvent) => {
		if (event.button !== 0 || drag.current !== null) return;
		drag.current = event.pointerId;
		event.currentTarget.setPointerCapture?.(event.pointerId);
		document.body.classList.add(RESIZING_CLASS);
		setDragging(true);
	};
	const onPointerMove = (event: PointerEvent) => {
		if (drag.current !== event.pointerId) return;
		const available = window.innerWidth * SIDE_PANEL_MAX_VIEWPORT;
		onChange(clampSidePanelWidth(Math.min(window.innerWidth - event.clientX, available)));
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: A focusable window splitter is the ARIA pattern for a resize handle.
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={t("panel.resize")}
			aria-valuemin={SIDE_PANEL_WIDTH.min}
			aria-valuemax={SIDE_PANEL_WIDTH.max}
			aria-valuenow={width}
			tabIndex={0}
			data-dragging={dragging}
			className="resize-handle hidden lg:block"
			onKeyDown={onKeyDown}
			onDoubleClick={onReset}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={end}
			onPointerCancel={end}
			onLostPointerCapture={end}
		/>
	);
}
