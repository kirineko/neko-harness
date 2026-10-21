import type { ChatItem, ChatView, DefaultImagePrompt, StreamingView } from "@neko-harness/core";
import { copyText } from "@neko-harness/core/conversation-export";
import type { PlanRecord, QuestionSummary } from "@neko-harness/core/interactions";
import type { SkillInvocation } from "@neko-harness/core/skill-invocation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { questionUi } from "../lib/question-ui";
import { getState } from "../lib/store";
import { AskUserRow } from "./ask-user-row";
import { CopyButton } from "./copy-button";
import { ImageGallery } from "./image-gallery";
import { JobReportCard } from "./job-report-card";
import { Markdown } from "./markdown";
import { PlanRow } from "./plan-row";
import { SkillInvocationCard } from "./skill-card";
import { ThinkingBlock } from "./thinking";
import { ToolCard } from "./tool-card";

const BOTTOM_THRESHOLD = 48;

/** 空会话占位：内联 SVG 小猫（无外部资源），颜色取自主题 tokens。 */
function WelcomeCat() {
	const sakura200 = "var(--color-sakura-200)";
	const sakura300 = "var(--color-sakura-300)";
	const tianyi800 = "var(--color-tianyi-800)";
	const sakura800 = "var(--color-sakura-800)";
	return (
		<svg width="132" height="112" viewBox="0 0 132 112" fill="none" aria-hidden="true">
			<title>neko 小猫</title>
			<path d="M30 46 L24 14 L54 30 Z" fill={sakura200} stroke={sakura300} strokeWidth="2.5" strokeLinejoin="round" />
			<path d="M102 46 L108 14 L78 30 Z" fill={sakura200} stroke={sakura300} strokeWidth="2.5" strokeLinejoin="round" />
			<path d="M32 39 L29 23 L46 32 Z" fill={sakura300} opacity="0.55" />
			<path d="M100 39 L103 23 L86 32 Z" fill={sakura300} opacity="0.55" />
			<ellipse cx="66" cy="66" rx="44" ry="38" fill="var(--color-surface)" stroke={sakura200} strokeWidth="2.5" />
			<circle cx="50" cy="62" r="5" fill={tianyi800} />
			<circle cx="82" cy="62" r="5" fill={tianyi800} />
			<circle cx="51.8" cy="60" r="1.6" fill="var(--color-surface)" />
			<circle cx="83.8" cy="60" r="1.6" fill="var(--color-surface)" />
			<ellipse cx="40" cy="74" rx="6.5" ry="3.6" fill={sakura300} opacity="0.65" />
			<ellipse cx="92" cy="74" rx="6.5" ry="3.6" fill={sakura300} opacity="0.65" />
			<path d="M62 71 q4 4.5 4 1 q0 -3.5 4 -1" stroke={sakura800} strokeWidth="2" fill="none" strokeLinecap="round" />
			<path d="M18 64 L32 66 M19 72 L32 70" stroke={sakura200} strokeWidth="2" strokeLinecap="round" />
			<path d="M114 64 L100 66 M113 72 L100 70" stroke={sakura200} strokeWidth="2" strokeLinecap="round" />
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
	// /skill: 展开块渲染为折叠卡片；参数仍以用户气泡显示，未命中时原样渲染。
	if (invocation !== undefined) {
		return (
			<div className="chat-row anim-user flex flex-col items-end">
				<div className="chat-bubble flex min-w-0 flex-col items-stretch gap-1.5">
					<SkillInvocationCard invocation={invocation} />
					{invocation.args !== "" && (
						<div className="bubble-user px-4 py-2.5 whitespace-pre-wrap">{invocation.args}</div>
					)}
				</div>
				<CopyButton text={copy} />
			</div>
		);
	}
	return (
		<div className="chat-row anim-user flex flex-col items-end">
			<div
				className={`bubble-user chat-bubble px-4 py-2.5 whitespace-pre-wrap${defaultImagePrompt ? " [&>div]:mt-0" : ""}`}
			>
				{text}
				{defaultImagePrompt && (
					<details className="min-w-0 text-sm">
						<summary className="cursor-pointer min-h-8 py-1 text-ink-500 focus-visible:outline-2 focus-visible:outline-sakura-500">
							默认图片提示
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
	// 只有工具调用、没有文本/thinking/提示时不渲染气泡（工具卡片独立成行）；
	// 流式期间文本从无到有，出现时再渲染，不会闪烁。
	if (item.text.trim() === "" && item.thinking.trim() === "" && item.note === null) return null;
	return (
		<div className="chat-row anim-other flex flex-col items-start">
			<div className="bubble-assistant space-y-1.5 px-4 py-2.5">
				<AssistantBody thinking={item.thinking} text={item.text} />
				{item.note !== null && <div className="text-xs text-sakura-800 italic">⚠ {item.note}</div>}
			</div>
			<CopyButton text={copyText(item)} label="复制回答" />
		</div>
	);
}

function SystemRow({ text, decision }: { text: string; decision?: boolean }) {
	return (
		<div className="chat-row anim-other flex justify-center" data-plan-decision={decision ? "" : undefined}>
			<span className="rounded-full bg-ink-100 px-3 py-1 text-xs text-ink-600">{text}</span>
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
			<ToolCard
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
					<div className="bubble-assistant space-y-1.5 px-4 py-2.5">
						<AssistantBody thinking={streaming.thinking} text={streaming.text} />
						{busy && <span className="stream-caret" aria-hidden />}
					</div>
				</div>
			)}
			{streaming.toolCalls.map((call) => (
				<div key={`st${call.callId}`} className="chat-row anim-other">
					<ToolCard
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
							<div className="mt-[14vh] flex flex-col items-center gap-4 text-center">
								<div className="welcome-cat">
									<WelcomeCat />
								</div>
								<div className="text-4xl font-extrabold tracking-tight">
									<span className="logo-gradient">neko</span>
									<span className="text-tianyi-600">.</span>
									<span className="logo-gradient">harness</span>
								</div>
								<p className="max-w-sm text-sm text-ink-600">输入消息开始吧 ✦</p>
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
													任务 {round.round ?? ""} · {round.title} ·{" "}
													{
														{
															queued: "排队中",
															running: "运行中",
															completed: "已完成",
															failed: "失败",
															cancelled: "已停止",
														}[round.status]
													}
												</summary>
												<p className="pt-1">
													{round.roundUsage
														? `本轮 ↑${round.roundUsage.input} ↓${round.roundUsage.output} · 缓存 ${round.roundUsage.cacheRead}/${round.roundUsage.cacheWrite} · $${round.roundUsage.cost.toFixed(4)}`
														: "本轮用量未记录"}
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
											{child.status === "completed"
												? "已完成"
												: child.status === "cancelled"
													? "已停止"
													: child.status === "failed"
														? "失败"
														: child.status === "queued"
															? "排队中"
															: "运行中"}{" "}
											{child.approvalCount ? `· 待审批 ${child.approvalCount}` : "· 查看完整过程"}
										</span>
									</button>
								) : (
									<div key={item.key}>
										<ToolRow item={item} pending={view?.questions?.pending} plan={view?.plan?.current} />
										{view?.approvals
											?.filter((a) => a.callId === item.callId && a.status !== "pending")
											.map((a) => (
												<p key={a.id} className="chat-row text-xs text-ink-500">
													审批 ·{" "}
													{
														{ allowed: "已允许本次", denied: "已拒绝", cancelled: "已取消" }[
															a.status as "allowed" | "denied" | "cancelled"
														]
													}
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
							回到底部 ↓
						</button>
					)}
				</div>
			)}
		</div>
	);
}
