import type { ChatItem, ChatView, DefaultImagePrompt, StreamingView } from "@neko-harness/core";
import { copyText } from "@neko-harness/core/conversation-export";
import type { PlanRecord, QuestionSummary } from "@neko-harness/core/interactions";
import type { SkillInvocation } from "@neko-harness/core/skill-invocation";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { localizeCoreText } from "../lib/i18n/core-text.ts";
import { type Translate, useT } from "../lib/i18n/index.ts";
import { questionUi } from "../lib/question-ui";
import { getState } from "../lib/store";
import { AskUserRow } from "./ask-user-row";
import { ToolOrCodemodeCard } from "./codemode-card";
import { CopyButton } from "./copy-button";
import { ImageGallery } from "./image-gallery";
import { JobReportCard } from "./job-report-card";
import { Markdown } from "./markdown";
import { PlanRow } from "./plan-row";
import { SkillInvocationCard } from "./skill-card";
import { ThinkingBlock } from "./thinking";

const BOTTOM_THRESHOLD = 48;

type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
const taskStatus = (t: Translate, status: TaskStatus): string => t(`task.status.${status}`);

const WHALE_GRID = [
	".......MM...MM..............",
	"........M...M.....KK........",
	"..........M.......KBK....KK.",
	"..................KBBK..KBBK",
	".....KKKKKKKK.....KBBBK.KBBK",
	"...KKBBBBBBBBKK....KBBBKBBK.",
	"..KBBHHHBBBBBBBK....KBBBBK..",
	".KBBHHBBBBBBBBBBK...KBBBK...",
	".KBBHBBBBBBBBBBBBK.KBBBBK...",
	"KBBBBBBBBBBBBBBBBBKBBBBK....",
	"KBBBBBBBBBBBBBBBBBBBBBBK....",
	"KBBBBBEBBBBBEBBBBBBBBBK.....",
	"KBBBBBEBBBBBEBBBBBBBBBK.....",
	"KBBPPBBBBBBBBBPPBBBBBBK.....",
	"KBBBBWWWWWWWWWBBBBKBBBK.....",
	"KBBBWWWWWWWWWWWBBBBKBBBK....",
	".KBWWWWWWWWWWWWWBBBBKBBBK...",
	".KBWWWWWWWWWWWWWBBBBBKBBBK..",
	"..KSSSSSSSSSSSSSBBBBBBBBBK..",
	"...KSSSSSSSSSSSSKBBBBBBBBK..",
	"....KKKKKKKKKKKK.KKKKKKKK...",
] as const;

const WHALE_FILLS: Readonly<Record<string, string>> = {
	K: "var(--whale-outline)",
	E: "var(--whale-eye)",
	B: "var(--whale-body)",
	H: "var(--whale-shine)",
	M: "var(--whale-spout)",
	W: "var(--whale-belly)",
	S: "var(--whale-belly-shade)",
	P: "var(--whale-cheek)",
};

const WHALE_RECTS = (() => {
	const rects: { key: string; x: number; y: number; w: number; fill: string }[] = [];
	WHALE_GRID.forEach((row, y) => {
		let x = 0;
		while (x < row.length) {
			const code = row[x] ?? ".";
			const fill = WHALE_FILLS[code];
			if (!fill) {
				x++;
				continue;
			}
			let end = x + 1;
			while (end < row.length && row[end] === code) end++;
			rects.push({ key: `${x}-${y}`, x, y, w: end - x, fill });
			x = end;
		}
	});
	return rects;
})();

const WORDMARK_GLYPHS: Readonly<Record<string, readonly string[]>> = {
	N: ["##..##", "###.##", "###.##", "###.##", "##.###", "##.###", "##.###", "##..##", "##..##", "##..##"],
	E: ["######", "######", "##....", "##....", "#####.", "#####.", "##....", "##....", "######", "######"],
	K: ["##..##", "##..##", "##.##.", "####..", "###...", "####..", "##.##.", "##..##", "##..##", "##..##"],
	O: [".####.", "######", "##..##", "##..##", "##..##", "##..##", "##..##", "##..##", "######", ".####."],
	H: ["##..##", "##..##", "##..##", "##..##", "######", "######", "##..##", "##..##", "##..##", "##..##"],
	A: [".####.", "######", "##..##", "##..##", "######", "######", "##..##", "##..##", "##..##", "##..##"],
	R: ["#####.", "######", "##..##", "##..##", "#####.", "####..", "##.##.", "##..##", "##..##", "##..##"],
	S: [".#####", "######", "##....", "##....", "#####.", ".#####", "....##", "....##", "######", "#####."],
};

function buildWordRects(
	word: string,
	offsetX: number,
	offsetY: number,
): { key: string; x: number; y: number; w: number }[] {
	const rows = Array.from({ length: 10 }, () => "");
	[...word].forEach((ch, idx) => {
		const glyph = WORDMARK_GLYPHS[ch];
		if (!glyph) return;
		for (let r = 0; r < 10; r++) {
			rows[r] = `${rows[r] ?? ""}${idx > 0 ? ".." : ""}${glyph[r] ?? ""}`;
		}
	});
	const rects: { key: string; x: number; y: number; w: number }[] = [];
	rows.forEach((row, y) => {
		let x = 0;
		while (x < row.length) {
			if (row[x] !== "#") {
				x++;
				continue;
			}
			let end = x + 1;
			while (end < row.length && row[end] === "#") end++;
			rects.push({ key: `${offsetX + x}-${offsetY + y}`, x: offsetX + x, y: offsetY + y, w: end - x });
			x = end;
		}
	});
	return rects;
}

const WORDMARK_LAYOUT = (() => {
	const topWidth = 4 * 6 + 3 * 2;
	const bottomWidth = 7 * 6 + 6 * 2;
	const topOffset = Math.floor((bottomWidth - topWidth) / 2);
	return {
		width: bottomWidth,
		height: 23,
		topRects: buildWordRects("NEKO", topOffset, 0),
		bottomRects: buildWordRects("HARNESS", 0, 13),
	};
})();

/** 空会话占位：内联像素 SVG 萌系小鲸鱼（无外部资源），配色取自主题 tokens。 */
function WelcomeWhale() {
	const t = useT();
	return (
		<svg
			width="154"
			height="115"
			viewBox="0 0 28 21"
			shapeRendering="crispEdges"
			aria-hidden="true"
			className="h-auto max-w-full"
		>
			<title>{t("message.whale")}</title>
			{WHALE_RECTS.map((rect) => (
				<rect key={rect.key} x={rect.x} y={rect.y} width={rect.w} height={1} fill={rect.fill} />
			))}
		</svg>
	);
}

/** 像素大字标题：上排 NEKO 纯色强调、下排 HARNESS 左至右流光渐变。 */
function WelcomeWordmark() {
	const gradId = useId();
	return (
		<svg
			width={WORDMARK_LAYOUT.width * 4}
			height={WORDMARK_LAYOUT.height * 4}
			viewBox={`0 0 ${WORDMARK_LAYOUT.width} ${WORDMARK_LAYOUT.height}`}
			shapeRendering="crispEdges"
			role="img"
			aria-label="neko.harness"
			className="h-auto max-w-full"
		>
			<defs>
				<linearGradient id={gradId} x1="0" y1="0" x2={WORDMARK_LAYOUT.width} y2="0" gradientUnits="userSpaceOnUse">
					<stop offset="0%" stopColor="var(--wordmark-start)" />
					<stop offset="55%" stopColor="var(--wordmark-mid)" />
					<stop offset="100%" stopColor="var(--wordmark-end)" />
				</linearGradient>
			</defs>
			<g fill="var(--wordmark-top)">
				{WORDMARK_LAYOUT.topRects.map((rect) => (
					<rect key={rect.key} x={rect.x} y={rect.y} width={rect.w} height={1} />
				))}
			</g>
			<g fill={`url(#${gradId})`}>
				{WORDMARK_LAYOUT.bottomRects.map((rect) => (
					<rect key={rect.key} x={rect.x} y={rect.y} width={rect.w} height={1} />
				))}
			</g>
		</svg>
	);
}

function UserRow({
	text,
	images,
	skill: invocation,
	defaultImagePrompt,
	copy,
}: {
	text: string;
	copy: string;
	images?: import("@neko-harness/core").ChatImage[];
	skill?: SkillInvocation;
	defaultImagePrompt?: DefaultImagePrompt;
}) {
	const t = useT();
	// /skill: 展开块渲染为折叠卡片；参数仍以用户气泡显示，未命中时原样渲染。
	if (invocation !== undefined) {
		return (
			<div className="chat-row anim-user flex flex-col items-end">
				<div className="chat-bubble flex min-w-0 flex-col items-stretch gap-1.5">
					<SkillInvocationCard invocation={invocation} />
					{invocation.args !== "" && (
						<div className="bubble-user px-4 py-2.5 whitespace-pre-wrap break-words">{invocation.args}</div>
					)}
				</div>
				<CopyButton text={copy} />
			</div>
		);
	}
	return (
		<div className="chat-row anim-user flex flex-col items-end">
			<div
				className={`bubble-user chat-bubble px-4 py-2.5 whitespace-pre-wrap break-words${defaultImagePrompt ? " [&>div]:mt-0" : ""}`}
			>
				{text}
				{defaultImagePrompt && (
					<details className="min-w-0 text-sm">
						<summary className="cursor-pointer min-h-8 py-1 text-ink-500 focus-visible:outline-2 focus-visible:outline-sakura-500">
							{t("message.defaultImagePrompt")}
						</summary>
						<p className="pt-2 whitespace-pre-wrap break-words">{defaultImagePrompt.text}</p>
					</details>
				)}
				{images && <ImageGallery images={images} />}
			</div>
			<CopyButton text={copy} />
		</div>
	);
}

function AssistantBody({ thinking, text }: { thinking: string; text: string }) {
	return (
		<>
			<ThinkingBlock text={thinking} />
			{text.trim() !== "" && <Markdown text={text} />}
		</>
	);
}

function AssistantRow({ item }: { item: Extract<ChatItem, { type: "assistant" }> }) {
	const t = useT();
	// 只有工具调用、没有文本/thinking/提示时不渲染气泡（工具卡片独立成行）；
	// 流式期间文本从无到有，出现时再渲染，不会闪烁。
	if (item.text.trim() === "" && item.thinking.trim() === "" && item.note === null) return null;
	return (
		<div className="chat-row anim-other flex flex-col items-start">
			<div className="bubble-assistant min-w-0 max-w-full space-y-1.5 px-4 py-2.5">
				<AssistantBody thinking={item.thinking} text={item.text} />
				{item.note !== null && (
					<div className="break-words text-xs text-sakura-800 italic">⚠ {localizeCoreText(item.note, t)}</div>
				)}
			</div>
			<CopyButton text={copyText(item)} label={t("message.copyAnswer")} />
		</div>
	);
}

function SystemRow({ text, decision }: { text: string; decision?: boolean }) {
	const t = useT();
	return (
		<div className="chat-row anim-other flex justify-center" data-plan-decision={decision ? "" : undefined}>
			<span className="rounded-full bg-ink-100 px-3 py-1 text-xs text-ink-600">{localizeCoreText(text, t)}</span>
		</div>
	);
}

function ToolRow({
	item,
	pending,
	plan,
}: {
	item: Extract<ChatItem, { type: "tool" }>;
	pending?: readonly QuestionSummary[];
	plan?: PlanRecord | null;
}) {
	const interaction = item.interaction;
	if (interaction?.kind === "ask_user") {
		const waiting = interaction.status === "pending" ? pending?.find((q) => q.id === interaction.id) : undefined;
		return (
			<div className="chat-row anim-other">
				<AskUserRow
					interaction={interaction}
					onLocate={
						waiting
							? () => {
									const sessionId = getState().currentSessionId;
									if (sessionId) questionUi.open(sessionId, waiting);
								}
							: undefined
					}
				/>
			</div>
		);
	}
	if (interaction?.kind === "submit_plan") {
		return (
			<div className="chat-row anim-other">
				<PlanRow interaction={interaction} status={plan?.version === interaction.version ? plan.status : undefined} />
			</div>
		);
	}
	return (
		<div className="chat-row anim-other">
			<ToolOrCodemodeCard
				codemode={item.codemode}
				name={item.name}
				summary={item.summary}
				detail={item.detail}
				phase={item.phase}
				isError={item.isError}
				output={item.output}
				result={item.result}
				durationMs={item.durationMs}
				note={item.note}
				diff={item.diff}
				diffAdded={item.diffAdded}
				diffRemoved={item.diffRemoved}
				diffTruncated={item.diffTruncated}
			/>
			{item.images && <ImageGallery images={item.images} />}
		</div>
	);
}

function StreamingRow({ streaming, busy }: { streaming: StreamingView; busy: boolean }) {
	const hasContent = streaming.text.trim() !== "" || streaming.thinking.trim() !== "";
	return (
		<>
			{hasContent && (
				<div className="chat-row stream-block flex justify-start">
					<div className="bubble-assistant min-w-0 max-w-full space-y-1.5 px-4 py-2.5">
						<AssistantBody thinking={streaming.thinking} text={streaming.text} />
						{busy && <span className="stream-caret" aria-hidden />}
					</div>
				</div>
			)}
			{streaming.toolCalls.map((call) => (
				<div key={`st${call.callId}`} className="chat-row anim-other">
					<ToolOrCodemodeCard
						codemode={call.codemode}
						name={call.name}
						summary={call.summary}
						detail={call.detail}
						phase={call.phase}
						output={call.output}
						diff={call.diff}
						diffAdded={call.diffAdded}
						diffRemoved={call.diffRemoved}
						diffTruncated={call.diffTruncated}
					/>
				</div>
			))}
		</>
	);
}

/** 消息列表：已提交条目 + 流式块；贴底跟随滚动，离开底部时出现"回到底部"。 */
export function MessageList({
	view,
	busy,
	onSubagent,
	emptyLabel,
	onLoadEarlier,
	tray,
	focusEntry,
}: {
	view: ChatView | null;
	busy: boolean;
	onSubagent?: (taskId: number) => void;
	focusEntry?: { id: number; nonce: number };
	emptyLabel?: string;
	onLoadEarlier?: () => Promise<void>;
	tray?: ReactNode;
}) {
	const t = useT();
	const containerRef = useRef<HTMLDivElement>(null);
	const focusedEntry = useRef("");
	const stickRef = useRef(true);
	const loadingEarlier = useRef(false);
	const [showJump, setShowJump] = useState(false);

	const items = view?.items ?? [];
	const streaming = view?.streaming ?? null;

	const scrollToBottom = (smooth: boolean): void => {
		const el = containerRef.current;
		if (el === null) return;
		el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	};

	// 每次渲染后若贴底则跟随（渲染本身由快照更新驱动）。
	useEffect(() => {
		if (!stickRef.current) return;
		const el = containerRef.current;
		if (el !== null) el.scrollTo({ top: el.scrollHeight });
	});

	useEffect(() => {
		if (!focusEntry || !items.some((i) => i.type === "user" && i.id === focusEntry.id)) return;
		const key = `${focusEntry.id}:${focusEntry.nonce}`;
		if (focusedEntry.current === key) return;
		const el = containerRef.current;
		const row = el?.querySelector<HTMLElement>(`[data-entry-id="${focusEntry.id}"]`);
		if (!el || !row) return;
		focusedEntry.current = key;
		stickRef.current = false;
		el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top;
		setShowJump(true);
	}, [focusEntry, items]);

	const onScroll = (): void => {
		const el = containerRef.current;
		if (el === null) return;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
		stickRef.current = nearBottom;
		setShowJump(!nearBottom);
		if (el.scrollTop <= 24 && onLoadEarlier && !loadingEarlier.current) {
			loadingEarlier.current = true;
			stickRef.current = false;
			const top = el.scrollTop;
			const height = el.scrollHeight;
			void onLoadEarlier().finally(() => {
				requestAnimationFrame(() => {
					if (containerRef.current === el) el.scrollTop = top + el.scrollHeight - height;
					loadingEarlier.current = false;
				});
			});
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
				<div className="chat-column flex flex-col gap-3 px-4 py-5">
					{items.length === 0 &&
						streaming === null &&
						(emptyLabel ? (
							<p className="p-4 text-sm text-ink-500">{emptyLabel}</p>
						) : (
							<div className="mt-[12vh] flex flex-col items-center gap-4 text-center">
								<div className="welcome-whale">
									<WelcomeWhale />
								</div>
								<WelcomeWordmark />
								<p className="max-w-sm text-sm text-ink-600">{t("message.welcome")}</p>
							</div>
						))}
					{items.map((item) => {
						switch (item.type) {
							case "user": {
								const round = view?.rounds?.find(
									(r) => r.inputEntryId === item.id || r.taskId === item.subagentRoundId,
								);
								return (
									<div key={item.key} data-entry-id={item.id}>
										{round && (
											<details className="chat-row border-t border-sakura-200 pt-2 text-xs text-ink-500">
												<summary className="cursor-pointer">
													{t("message.round", {
														round: round.round ?? "",
														title: round.title,
														status: taskStatus(t, round.status),
													})}
												</summary>
												<p className="pt-1">
													{round.roundUsage
														? t("message.roundUsage", {
																input: round.roundUsage.input,
																output: round.roundUsage.output,
																cacheRead: round.roundUsage.cacheRead,
																cacheWrite: round.roundUsage.cacheWrite,
																cost: round.roundUsage.cost.toFixed(4),
															})
														: t("message.roundUsageMissing")}
												</p>
											</details>
										)}
										<UserRow
											text={item.text}
											copy={copyText(item)}
											images={item.images}
											skill={item.skill}
											defaultImagePrompt={item.defaultImagePrompt}
										/>
									</div>
								);
							}
							case "assistant":
								return <AssistantRow key={item.key} item={item} />;
							case "tool": {
								const child = view?.subagents?.find((d) => d.callId === item.callId);
								return child && onSubagent ? (
									<button
										type="button"
										key={item.key}
										onClick={() => onSubagent(child.taskId)}
										className="focus-neko rounded-2xl border border-sakura-200 bg-surface p-4 text-left"
									>
										<span className="text-tianyi-700">{child.role}</span> · {child.title}
										<span className="block text-xs text-ink-500">
											{taskStatus(t, child.status)}{" "}
											{child.approvalCount
												? t("message.approvalsPending", { count: child.approvalCount })
												: t("message.viewProcess")}
										</span>
									</button>
								) : (
									<div key={item.key}>
										<ToolRow item={item} pending={view?.questions?.pending} plan={view?.plan?.current} />
										{view?.approvals
											?.filter((a) => a.callId === item.callId && a.status !== "pending")
											.map((a) => (
												<p key={a.id} className="chat-row text-xs text-ink-500">
													{t("message.approvalLine", {
														status: t(`approval.status.${a.status as "allowed" | "denied" | "cancelled"}`),
													})}
												</p>
											))}
									</div>
								);
							}
							case "system":
								return item.jobId !== undefined ? (
									<JobReportCard
										key={item.key}
										text={item.text}
										jobId={item.jobId}
										job={view?.jobs?.find((job) => job.jobId === item.jobId)}
									/>
								) : (
									<SystemRow key={item.key} text={item.text} decision={item.planDecision !== undefined} />
								);
							default:
								return null;
						}
					})}
					{streaming !== null && <StreamingRow streaming={streaming} busy={busy} />}
				</div>
			</div>
			{(showJump || tray) && (
				<div className="discrete-in flex shrink-0 items-center justify-center gap-2 border-t border-sakura-100 bg-base/70 py-1.5">
					{tray}
					{showJump && (
						<button
							type="button"
							onClick={() => {
								stickRef.current = true;
								setShowJump(false);
								scrollToBottom(true);
							}}
							className="focus-neko rounded-full border border-sakura-300 bg-surface px-3.5 py-1 text-xs font-medium text-sakura-800 hover:bg-sakura-50"
						>
							{t("message.toBottom")}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
