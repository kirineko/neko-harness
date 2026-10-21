import type { ChatView } from "@neko-harness/core";
import {
	draftProblem,
	draftResponse,
	QUESTION_LIMITS,
	type QuestionRecord,
	type QuestionResponse,
	type QuestionSummary,
	toggleDraftOption,
} from "@neko-harness/core/interactions";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { isSameDecision, plainText, questionState, settlementText } from "../lib/interactions";
import { questionKey, questionUi, useQuestionUi } from "../lib/question-ui";
import { useNekoState } from "../lib/store";
import { composerEngaged } from "./composer";
import { DismissButton, Icon } from "./primitives";

type Slot = { state: "loading" } | { state: "ready"; record: QuestionRecord } | { state: "error"; message: string };

const NONE: readonly QuestionSummary[] = [];
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const focusComposer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入"]')?.focus();

/** Another dialog or a pending Bash approval already holds the user's attention. */
function otherPanelBusy(view: ChatView | null): boolean {
	return (
		document.querySelector("dialog[open]") !== null ||
		(view?.subagents ?? []).some((d) => (d.approvalCount ?? 0) > 0 && d.historyThrough === undefined)
	);
}

function noticeText(record: QuestionRecord, mine: boolean): string {
	if (mine) return settlementText(record);
	if (record.status === "cancelled") return "该问题已取消（运行已停止或会话已归档），没有保存新的回答。";
	return `该问题已由其他端先处理，以已保存的结果为准：${settlementText(record)}`;
}

/** Questions the assistant is waiting on, between the approvals and the composer. Not modal and never a chat submit. */
export function QuestionDock() {
	const { currentSessionId } = useNekoState();
	return currentSessionId ? <SessionQuestions key={currentSessionId} sessionId={currentSessionId} /> : null;
}

function SessionQuestions({ sessionId }: { sessionId: string }) {
	const app = useNekoState();
	const ui = useQuestionUi();
	const info = questionState(app);
	const online = info?.online ?? false;
	const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
	const [slots, setSlots] = useState<Readonly<Record<string, Slot>>>({});
	const [notice, setNotice] = useState<string | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const pending = info?.pending ?? NONE;
	const visible = pending
		.map((summary) => ({ summary, key: questionKey(sessionId, summary.id, summary.version) }))
		.filter(({ key }) => !settled.has(key));
	const active = visible.find(({ summary }) => summary.id === ui.active[sessionId]) ?? visible[0];
	const activeOpen = active !== undefined && ui.fold[active.key] === "open";
	const activeSlot = active === undefined ? undefined : slots[active.key];

	// First appearance decides once whether the card opens; a later fold or unfold is the user's.
	useLayoutEffect(() => {
		let opened = visible.some(({ key }) => questionUi.state.fold[key] === "open");
		for (const { summary, key } of visible) {
			if (questionUi.state.fold[key] !== undefined) continue;
			const free =
				summary.id === active?.summary.id && !opened && !composerEngaged(sessionId) && !otherPanelBusy(app.view);
			questionUi.setFold(key, free ? "open" : "folded");
			if (free) opened = true;
		}
	});

	const settle = useCallback((key: string, record: QuestionRecord, mine: boolean) => {
		questionUi.clearDraft(key);
		setSettled((previous) => new Set(previous).add(key));
		setNotice(noticeText(record, mine));
	}, []);

	// A question that leaves the list without this tab settling it was decided elsewhere (or cancelled).
	const supported = info !== null;
	const seen = useRef(new Map<string, QuestionSummary>());
	useEffect(() => {
		if (!supported) return;
		const current = new Map(pending.map((summary) => [questionKey(sessionId, summary.id, summary.version), summary]));
		for (const [key, summary] of seen.current) {
			if (current.has(key) || settled.has(key) || pending.some((q) => q.id === summary.id)) continue;
			questionUi.clearDraft(key);
			void appActions
				.questionGet(sessionId, summary.id)
				.then((record) => {
					if (!alive.current) return;
					setNotice(
						record !== null && record.status !== "pending"
							? noticeText(record, false)
							: "该问题已不在等待列表中，可能已在其他端处理或已取消。",
					);
				})
				.catch(() => {
					if (alive.current) setNotice("该问题已不在等待列表中，可能已在其他端处理或已取消。");
				});
		}
		seen.current = current;
	}, [supported, pending, sessionId, settled]);

	// The full question is read on demand, only for the one that is open; a failed read is retried on reconnect.
	useEffect(() => {
		if (online) setSlots((previous) => dropErrors(previous));
	}, [online]);
	const activeKey = active?.key;
	const activeSummary = active?.summary;
	const needsLoad = activeSlot === undefined;
	useEffect(() => {
		if (activeKey === undefined || activeSummary === undefined || !activeOpen || !online || !needsLoad) return;
		const key = activeKey;
		setSlots((previous) => ({ ...previous, [key]: { state: "loading" } }));
		appActions
			.questionGet(sessionId, activeSummary.id)
			.then((record) => {
				if (!alive.current) return;
				if (record === null)
					setSlots((previous) => ({
						...previous,
						[key]: { state: "error", message: "找不到这个问题，它可能已结算。" },
					}));
				else if (record.status !== "pending") settle(key, record, false);
				else setSlots((previous) => ({ ...previous, [key]: { state: "ready", record } }));
			})
			.catch((error: unknown) => {
				if (alive.current)
					setSlots((previous) => ({ ...previous, [key]: { state: "error", message: errorText(error) } }));
			});
	}, [activeKey, activeSummary, activeOpen, online, needsLoad, sessionId, settle]);

	if (active === undefined && notice === null) return null;
	const index = active === undefined ? 0 : visible.indexOf(active);
	return (
		<section aria-label="待回答问题" data-question-dock className="flex shrink-0 flex-col px-3 pt-0.5 pb-1 sm:px-4">
			<div className="chat-column flex flex-col gap-1.5">
				{notice !== null && (
					<output
						data-question-notice
						className="flex items-start gap-2 rounded-xl border border-tianyi-200 bg-surface px-3 py-2 text-sm text-ink-800"
					>
						<span className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">
							{plainText(notice)}
						</span>
						<DismissButton label="关闭结果提示" onClick={() => setNotice(null)} />
					</output>
				)}
				{visible.length > 1 && (
					<div className="flex items-center gap-2 text-xs text-ink-700">
						<span>
							共 {visible.length} 个待回答问题，当前第 {index + 1} 个
						</span>
						<button
							type="button"
							className="focus-neko rounded-full border border-tianyi-300 px-2.5 py-0.5 disabled:opacity-50"
							disabled={index === 0}
							onClick={() => questionUi.setActive(sessionId, visible[index - 1]!.summary.id)}
						>
							上一个
						</button>
						<button
							type="button"
							className="focus-neko rounded-full border border-tianyi-300 px-2.5 py-0.5 disabled:opacity-50"
							disabled={index === visible.length - 1}
							onClick={() => questionUi.setActive(sessionId, visible[index + 1]!.summary.id)}
						>
							下一个
						</button>
					</div>
				)}
				{active !== undefined && (
					<QuestionCard
						key={active.key}
						sessionId={sessionId}
						summary={active.summary}
						questionKey={active.key}
						slot={activeSlot}
						online={online}
						open={activeOpen}
						onRetry={() => setSlots(({ [active.key]: _dropped, ...rest }) => rest)}
						onSettled={(record, mine) => settle(active.key, record, mine)}
					/>
				)}
			</div>
		</section>
	);
}

function dropErrors(slots: Readonly<Record<string, Slot>>): Readonly<Record<string, Slot>> {
	if (!Object.values(slots).some((slot) => slot.state === "error")) return slots;
	return Object.fromEntries(Object.entries(slots).filter(([, slot]) => slot.state !== "error"));
}

function QuestionCard(props: {
	sessionId: string;
	summary: QuestionSummary;
	questionKey: string;
	slot: Slot | undefined;
	online: boolean;
	open: boolean;
	onRetry: () => void;
	onSettled: (record: QuestionRecord, mine: boolean) => void;
}) {
	const { summary, questionKey: key, open, online } = props;
	const ui = useQuestionUi();
	const draft = questionUi.draft(key);
	const [busy, setBusy] = useState<"answer" | "skip" | null>(null);
	const [error, setError] = useState("");
	const sending = useRef(false);
	const card = useRef<HTMLElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const toggle = useRef<HTMLButtonElement>(null);
	const base = useId();
	const record = props.slot?.state === "ready" ? props.slot.record : null;
	const hasOptions = (record?.options.length ?? summary.optionCount) > 0;

	// If the card disappears (settled elsewhere) while focus is inside it, hand focus back to the composer.
	useLayoutEffect(
		() => () => {
			if (card.current?.contains(document.activeElement)) focusComposer();
		},
		[],
	);

	// "Open question" from the composer or the transcript brings the card in view and focuses its first useful control.
	const request = ui.focus?.key === key ? ui.focus : null;
	const slotState = props.slot?.state;
	useEffect(() => {
		if (request === null || !open) return;
		if (slotState === undefined || slotState === "loading") {
			if (online) return;
		}
		const root = body.current;
		const target =
			root?.querySelector<HTMLElement>("[data-recommended] input:not(:disabled)") ??
			root?.querySelector<HTMLElement>("input:not(:disabled)") ??
			root?.querySelector<HTMLElement>("textarea:not(:disabled)") ??
			toggle.current;
		target?.focus();
		card.current?.scrollIntoView?.({ block: "nearest" });
		questionUi.consumeFocus(request.nonce);
	}, [request, open, online, slotState]);

	const disabled = !online || busy !== null || record === null;
	const incomplete = record !== null && draftProblem(record, draft) !== null;
	const canSubmit = !disabled && record !== null && !incomplete;
	const decide = async (response: QuestionResponse) => {
		if (sending.current || !online || record === null) return;
		sending.current = true;
		setBusy(response.kind === "skip" ? "skip" : "answer");
		setError("");
		try {
			const saved = await appActions.questionRespond(props.sessionId, {
				id: summary.id,
				version: summary.version,
				response,
			});
			if (saved.status === "pending") throw new Error("回答尚未保存，请重试");
			props.onSettled(saved, isSameDecision(saved, response));
		} catch (e) {
			setError(`提交失败：${errorText(e)}（答案草稿已保留，请手动重试）`);
		} finally {
			sending.current = false;
			setBusy(null);
		}
	};
	const submit = () => {
		const response = draftResponse(draft);
		if (response !== null && canSubmit) void decide(response);
	};
	const preview = plainText(summary.preview).replace(/\s+/g, " ");
	const bodyId = `${base}-body`;

	return (
		<section
			ref={card}
			aria-label="助手提问"
			data-question-card
			data-open={open}
			className="flex max-h-[min(42dvh,28rem)] flex-col rounded-xl border border-tianyi-300 bg-tianyi-50 text-sm shadow-soft"
		>
			<div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
				<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-tianyi-700 px-2 py-0.5 text-xs font-semibold text-on-accent">
					<Icon name="sparkles" size={12} />
					助手提问
				</span>
				<span className="shrink-0 text-xs font-medium text-tianyi-900">等待回答{online ? "" : " · 离线"}</span>
				{open ? (
					<span className="min-w-0 flex-1" />
				) : (
					<span className="min-w-0 flex-1 truncate text-ink-700" title={preview}>
						{preview}
						{summary.preview.length >= QUESTION_LIMITS.previewChars ? "…" : ""}
					</span>
				)}
				{!open && (draft.optionIds.length > 0 || draft.text !== "") && (
					<span className="shrink-0 text-xs text-ink-500">草稿已保留</span>
				)}
				<button
					ref={toggle}
					type="button"
					className="focus-neko h-9 shrink-0 rounded-full border border-tianyi-300 bg-surface px-3 text-xs text-tianyi-900 hover:bg-tianyi-100"
					aria-expanded={open}
					aria-controls={bodyId}
					aria-label={open ? "折叠提问（不会跳过）" : "展开提问"}
					onClick={() => questionUi.setFold(key, open ? "folded" : "open")}
				>
					{open ? "折叠" : "展开"}
				</button>
			</div>
			{open && (
				<>
					<div
						ref={body}
						id={bodyId}
						data-question-body
						className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain border-t border-tianyi-200 px-3 py-2"
					>
						{record === null ? (
							<>
								<p className="whitespace-pre-wrap break-words text-ink-900">{plainText(summary.preview)}</p>
								{props.slot?.state === "error" ? (
									<div className="flex flex-wrap items-center gap-2">
										<p role="alert" className="min-w-0 break-words text-sm text-sakura-800">
											无法读取完整问题：{props.slot.message}
										</p>
										{online && (
											<button
												type="button"
												className="focus-neko rounded-full border border-tianyi-300 px-3 py-1 text-xs"
												onClick={props.onRetry}
											>
												重试
											</button>
										)}
									</div>
								) : (
									<output className="block text-xs text-ink-600">
										{online ? "正在读取完整问题…" : "离线，暂时无法读取完整问题。"}
									</output>
								)}
							</>
						) : (
							<>
								<p className="whitespace-pre-wrap break-words text-ink-900" data-question-text>
									{plainText(record.question)}
								</p>
								{record.options.length > 0 && (
									<fieldset className="min-w-0 space-y-1.5" data-question-options>
										<legend className="mb-1 text-xs font-medium text-ink-600">
											{record.multiple ? "选择一个或多个选项" : "选择一个选项"}
										</legend>
										{record.options.map((option, i) => {
											const id = `${base}-option-${i}`;
											const describedBy = option.description ? `${id}-description` : undefined;
											return (
												<div
													key={option.id}
													data-option-id={option.id}
													data-recommended={option.recommended ? "" : undefined}
													className="flex min-w-0 items-start gap-2 rounded-lg border border-tianyi-200 bg-surface px-2 py-1.5 has-[:checked]:border-tianyi-500 has-[:checked]:bg-tianyi-100"
												>
													<input
														id={id}
														type={record.multiple ? "checkbox" : "radio"}
														name={`${base}-choice`}
														value={option.id}
														checked={draft.optionIds.includes(option.id)}
														disabled={disabled}
														aria-describedby={describedBy}
														className="mt-1 h-4 w-4 shrink-0 accent-tianyi-600"
														onChange={() => questionUi.setDraft(key, toggleDraftOption(record, draft, option.id))}
													/>
													<div className="min-w-0 flex-1">
														<label htmlFor={id} className="block cursor-pointer whitespace-pre-wrap break-words">
															{plainText(option.label)}
															{option.recommended && (
																<>
																	{" "}
																	<span className="rounded-full border border-sakura-300 bg-sakura-50 px-1.5 py-0.5 text-xs text-sakura-800">
																		推荐
																	</span>
																</>
															)}
														</label>
														{option.description && (
															<p id={describedBy} className="whitespace-pre-wrap break-words text-xs text-ink-600">
																{plainText(option.description)}
															</p>
														)}
													</div>
												</div>
											);
										})}
										{!record.multiple && draft.optionIds.length > 0 && (
											<button
												type="button"
												disabled={disabled}
												className="focus-neko rounded-full px-2 py-0.5 text-xs text-tianyi-800 underline disabled:opacity-50"
												onClick={() => questionUi.setDraft(key, { ...draft, optionIds: [] })}
											>
												清除选择
											</button>
										)}
									</fieldset>
								)}
								<div>
									<label htmlFor={`${base}-text`} className="mb-1 block text-xs font-medium text-ink-600">
										{hasOptions ? "补充说明（可选）" : "你的回答"}
									</label>
									<textarea
										id={`${base}-text`}
										rows={hasOptions ? 2 : 3}
										value={draft.text}
										maxLength={QUESTION_LIMITS.textChars}
										disabled={disabled}
										className="focus-neko max-h-40 w-full resize-y rounded-lg border border-sakura-200 bg-surface px-2 py-1.5 text-base text-ink-900 disabled:opacity-60 sm:text-sm"
										onChange={(e) => questionUi.setDraft(key, { ...draft, text: e.target.value })}
									/>
								</div>
							</>
						)}
					</div>
					<div className="shrink-0 space-y-1 border-t border-tianyi-200 px-3 py-2">
						{!online && (
							<output className="block text-xs text-sakura-800">
								离线：回答与跳过已停用，草稿已保留；重新连接后需要手动提交，不会自动发送。
							</output>
						)}
						{error && (
							<p role="alert" className="break-words text-xs text-sakura-800">
								{error}
							</p>
						)}
						<div className="flex flex-wrap items-center gap-2">
							<button
								type="button"
								disabled={!canSubmit}
								className="btn-primary focus-neko h-9 rounded-full px-4 text-sm disabled:opacity-50"
								onClick={submit}
							>
								{busy === "answer" ? "提交中…" : "提交回答"}
							</button>
							<button
								type="button"
								disabled={disabled}
								title="跳过：不提供答案，助手会自行判断并继续；不会停止运行"
								className="focus-neko h-9 rounded-full border border-ink-300 bg-surface px-3 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-50"
								onClick={() => void decide({ kind: "skip" })}
							>
								{busy === "skip" ? "跳过中…" : "跳过"}
							</button>
							<span className="min-w-0 text-xs text-ink-500">
								{incomplete && busy === null
									? "选择选项或填写文字后才能提交；选择只保存为草稿。"
									: "折叠或关闭不会跳过，运行仍可随时停止。"}
							</span>
						</div>
					</div>
				</>
			)}
		</section>
	);
}
