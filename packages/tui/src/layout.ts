import { type Component, Text, VStack } from "@earendil-works/pi-tui";
import { t } from "./i18n/index.ts";
import { PLAN_MAX_ROWS } from "./plan-dock.ts";
import { QUESTION_MAX_ROWS } from "./question-dock.ts";

export const usableSize = (width: number, height: number): boolean => width >= 40 && height >= 10;

/** Only the transcript grows. Bottom rows have an explicit, bounded budget. */
export function createAppLayout(parts: {
	transcript: Component;
	panel: Component & { height: number };
	editor: Component & { maxRows?: number };
	footer: Component & { panelOpen?: boolean };
	notices: Component;
	panelOpen: () => boolean;
	/** 忙碌行(Loader,自带前导空行);仅在 busyVisible() 时占位。 */
	approval?: Component & { height: number };
	approvalVisible?: () => boolean;
	busy?: Component;
	busyVisible?: () => boolean;
	/** Queued messages above the editor; only while there are any. */
	queue?: Component;
	queueVisible?: () => boolean;
	/** The assistant's question: a one-line bar, or the answer panel limited to the rows that are left over. */
	question?: Component & { height: number };
	questionVisible?: () => boolean;
	/** The plan awaiting a decision; only rendered while its panel is open. */
	plan?: Component & { height: number };
	planVisible?: () => boolean;
}): VStack {
	const normal = (v: { width: number; height: number }) => {
		if (parts.approval) parts.approval.height = Math.min(10, Math.max(7, Math.floor(v.height / 2)));
		parts.footer.panelOpen = parts.panelOpen();
		parts.editor.maxRows = parts.panelOpen() ? 3 : v.height >= 24 ? 7 : 5;
		const approvalRows = parts.approvalVisible?.() ? (parts.approval?.height ?? 0) : 0;
		const editorRows = Math.min(7, Math.max(3, parts.editor.render(v.width).length));
		const noticeRows = Math.min(1, parts.notices.render(v.width).length);
		const busyRows = parts.busyVisible?.() ? Math.min(2, parts.busy?.render(v.width).length ?? 0) : 0;
		const queueRows = parts.queueVisible?.() ? Math.min(3, parts.queue?.render(v.width).length ?? 0) : 0;
		// The question gets what is left after the fixed rows and one transcript row, so footer and editor survive.
		if (parts.question)
			parts.question.height = Math.max(
				0,
				Math.min(QUESTION_MAX_ROWS, v.height - approvalRows - editorRows - 2 - noticeRows - busyRows - queueRows - 1),
			);
		const questionRows =
			parts.questionVisible?.() && parts.question
				? Math.min(parts.question.height, parts.question.render(v.width).length)
				: 0;
		if (parts.plan)
			parts.plan.height = Math.max(
				0,
				Math.min(
					PLAN_MAX_ROWS,
					v.height - approvalRows - editorRows - 2 - noticeRows - busyRows - queueRows - questionRows - 1,
				),
			);
		const planRows =
			parts.planVisible?.() && parts.plan ? Math.min(parts.plan.height, parts.plan.render(v.width).length) : 0;
		parts.panel.height = Math.max(
			1,
			v.height - approvalRows - editorRows - 2 - noticeRows - busyRows - queueRows - questionRows - planRows,
		);
		return usableSize(v.width, v.height);
	};
	return new VStack([
		{
			component: { invalidate() {}, render: (width: number) => new Text(t("layout.tooSmall"), 0, 0).render(width) },
			visible: (v) => !normal(v),
			grow: 1,
		},
		{ component: parts.transcript, grow: 1, shrink: 1, minSize: 1, visible: (v) => normal(v) && !parts.panelOpen() },
		{ component: parts.panel, basis: 0, grow: 1, minSize: 1, visible: (v) => normal(v) && parts.panelOpen() },
		{ component: parts.notices, maxSize: 1, shrink: 0, visible: normal },
		{
			component: parts.busy ?? new Text("", 0, 0),
			maxSize: 2,
			shrink: 0,
			visible: (v) => normal(v) && (parts.busyVisible?.() ?? false),
		},
		{
			component: parts.queue ?? new Text("", 0, 0),
			maxSize: 3,
			shrink: 0,
			visible: (v) => normal(v) && (parts.queueVisible?.() ?? false),
		},
		{
			component: parts.approval ?? new Text("", 0, 0),
			shrink: 0,
			visible: (v) => normal(v) && (parts.approvalVisible?.() ?? false),
		},
		{
			component: parts.question ?? new Text("", 0, 0),
			shrink: 0,
			visible: (v) => normal(v) && (parts.questionVisible?.() ?? false) && (parts.question?.height ?? 0) > 0,
		},
		{
			component: parts.plan ?? new Text("", 0, 0),
			shrink: 0,
			visible: (v) => normal(v) && (parts.planVisible?.() ?? false) && (parts.plan?.height ?? 0) > 0,
		},
		{ component: parts.editor, minSize: 3, maxSize: 7, shrink: 0, visible: normal },
		{ component: parts.footer, basis: 2, minSize: 2, shrink: 0, visible: normal },
	]);
}
