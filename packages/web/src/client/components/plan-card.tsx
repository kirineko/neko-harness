import { PLAN_LIMITS, type PlanRecord } from "@neko-harness/core/interactions";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { appActions } from "../lib/bootstrap";
import { plainText } from "../lib/interactions";
import { decisionStatus, PLAN_STATUS_LABEL, planErrorText, planSettlementText, planState } from "../lib/plan-ui";
import { useNekoState } from "../lib/store";
import { Markdown } from "./markdown";
import { DismissButton, Icon } from "./primitives";

type Decision = { kind: "approve" } | { kind: "revise"; feedback: string };

const focusComposer = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息输入"]')?.focus();

/** The plan the assistant submitted and waits on, between the questions and the composer. Not modal and never a chat submit. */
export function PlanDock() {
	const { currentSessionId } = useNekoState();
	return currentSessionId ? <SessionPlan key={currentSessionId} sessionId={currentSessionId} /> : null;
}

function SessionPlan({ sessionId }: { sessionId: string }) {
	const app = useNekoState();
	const info = planState(app);
	const awaiting = info?.awaiting ?? null;
	const online = info?.online ?? false;
	const [notice, setNotice] = useState<string | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	// Versions this tab is deciding; their disappearance from the waiting state is reported by the response itself.
	const deciding = useRef(new Set<string>());
	const seen = useRef<PlanRecord | null>(null);
	const current = info?.current ?? null;
	useEffect(() => {
		const previous = seen.current;
		seen.current = awaiting;
		if (previous === null || previous.version === awaiting?.version || deciding.current.has(previous.version)) return;
		setNotice(
			current !== null && current.version === previous.version
				? `该计划已不在等待批准：${PLAN_STATUS_LABEL[current.status]}`
				: "该计划已不在等待批准，可能已在其他端处理或已被新的计划取代。",
		);
	}, [awaiting, current]);

	const settle = (record: PlanRecord, mine: boolean) => {
		if (alive.current) setNotice(planSettlementText(record, mine));
	};

	if (awaiting === null && notice === null) return null;
	return (
		<section aria-label="计划审批" data-plan-dock className="flex shrink-0 flex-col px-3 pt-0.5 pb-1 sm:px-4">
			<div className="chat-column flex flex-col gap-1.5">
				{notice !== null && (
					<output
						data-plan-notice
						className="flex items-start gap-2 rounded-xl border border-tianyi-200 bg-surface px-3 py-2 text-sm text-ink-800"
					>
						<span className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words">{notice}</span>
						<DismissButton label="关闭结果提示" onClick={() => setNotice(null)} />
					</output>
				)}
				{awaiting !== null && (
					<PlanCard
						key={awaiting.version}
						sessionId={sessionId}
						plan={awaiting}
						online={online}
						deciding={deciding.current}
						onSettled={settle}
					/>
				)}
			</div>
		</section>
	);
}

function PlanCard(props: {
	sessionId: string;
	plan: PlanRecord;
	online: boolean;
	deciding: Set<string>;
	onSettled: (record: PlanRecord, mine: boolean) => void;
}) {
	const { plan, online } = props;
	const [busy, setBusy] = useState<Decision["kind"] | "exit" | null>(null);
	const [revising, setRevising] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [error, setError] = useState("");
	const sending = useRef(false);
	const card = useRef<HTMLElement>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const base = useId();

	// If the card disappears (decided here or elsewhere) while focus is inside it, hand focus back to the composer.
	useLayoutEffect(
		() => () => {
			if (card.current?.contains(document.activeElement)) focusComposer();
		},
		[],
	);
	useEffect(() => {
		if (revising) area.current?.focus();
	}, [revising]);

	const trimmed = feedback.trim();
	const disabled = !online || busy !== null;
	const decide = async (decision: Decision) => {
		if (sending.current || !online) return;
		sending.current = true;
		props.deciding.add(plan.version);
		setBusy(decision.kind);
		setError("");
		try {
			const saved = await appActions.planRespond(props.sessionId, { version: plan.version, decision });
			if (saved.status === "awaiting_approval") throw new Error("决定尚未保存，请重试");
			const mine =
				saved.status === decisionStatus(decision.kind) &&
				(decision.kind === "approve" || saved.feedback === decision.feedback);
			props.onSettled(saved, mine);
		} catch (e) {
			setError(`提交失败：${planErrorText(e)}${decision.kind === "revise" ? "（反馈草稿已保留，请手动重试）" : ""}`);
		} finally {
			props.deciding.delete(plan.version);
			sending.current = false;
			setBusy(null);
		}
	};

	// Leaving plan mode cancels the waiting plan on the server; the card goes away through the normal view update.
	const exit = async () => {
		if (sending.current || !online) return;
		sending.current = true;
		props.deciding.add(plan.version);
		setBusy("exit");
		setError("");
		try {
			await appActions.planMode(props.sessionId, "normal");
		} catch (e) {
			setError(`退出失败：${planErrorText(e)}`);
		} finally {
			props.deciding.delete(plan.version);
			sending.current = false;
			setBusy(null);
		}
	};

	return (
		<section
			ref={card}
			aria-label="待批准计划"
			data-plan-card
			data-version={plan.version}
			className="flex max-h-[min(50dvh,32rem)] flex-col rounded-xl border border-tianyi-300 bg-tianyi-50 text-sm shadow-soft"
		>
			<div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
				<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-tianyi-700 px-2 py-0.5 text-xs font-semibold text-on-accent">
					<Icon name="sparkles" size={12} />
					计划
				</span>
				<span className="shrink-0 text-xs font-medium text-tianyi-900">
					{PLAN_STATUS_LABEL.awaiting_approval}
					{online ? "" : " · 离线"}
				</span>
			</div>
			<div
				data-plan-body
				className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain border-t border-tianyi-200 px-3 py-2"
			>
				<h2 data-plan-title className="whitespace-pre-wrap break-words font-semibold text-ink-900">
					{plainText(plan.title)}
				</h2>
				<ol data-plan-steps className="list-decimal space-y-1 pl-5 text-ink-900">
					{plan.steps.map((step, index) => (
						// Steps carry no ids; their position is their identity within one immutable plan version.
						// biome-ignore lint/suspicious/noArrayIndexKey: steps are fixed for a version and may repeat.
						<li key={index} className="break-words pl-1">
							<Markdown text={step} />
						</li>
					))}
				</ol>
				{plan.note !== "" && (
					<div data-plan-note className="break-words text-xs text-ink-700">
						<Markdown text={plan.note} />
					</div>
				)}
				{revising && (
					<div>
						<label htmlFor={`${base}-feedback`} className="mb-1 block text-xs font-medium text-ink-600">
							修改意见
						</label>
						<textarea
							ref={area}
							id={`${base}-feedback`}
							rows={3}
							value={feedback}
							maxLength={PLAN_LIMITS.feedbackChars}
							disabled={disabled}
							className="focus-neko max-h-40 w-full resize-y rounded-lg border border-sakura-200 bg-surface px-2 py-1.5 text-base text-ink-900 disabled:opacity-60 sm:text-sm"
							onChange={(e) => setFeedback(e.target.value)}
						/>
					</div>
				)}
			</div>
			<div className="shrink-0 space-y-1 border-t border-tianyi-200 px-3 py-2">
				{!online && (
					<output className="block text-xs text-sakura-800">
						离线：批准、修改与退出已停用，重新连接后需要手动操作。
					</output>
				)}
				{error && (
					<p role="alert" className="break-words text-xs text-sakura-800">
						{error}
					</p>
				)}
				<div className="flex flex-wrap items-center gap-2">
					{revising ? (
						<>
							<button
								type="button"
								disabled={disabled || trimmed === ""}
								className="btn-primary focus-neko h-9 rounded-full px-4 text-sm disabled:opacity-50"
								onClick={() => void decide({ kind: "revise", feedback: trimmed })}
							>
								{busy === "revise" ? "提交中…" : "提交修改意见"}
							</button>
							<button
								type="button"
								disabled={disabled}
								className="focus-neko h-9 rounded-full border border-ink-300 bg-surface px-3 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-50"
								onClick={() => {
									setRevising(false);
									setError("");
								}}
							>
								取消
							</button>
							<span className="min-w-0 text-xs text-ink-500">
								{trimmed === "" ? "请填写修改意见" : `${feedback.length}/${PLAN_LIMITS.feedbackChars}`}
							</span>
						</>
					) : (
						<>
							<button
								type="button"
								disabled={disabled}
								className="btn-primary focus-neko h-9 rounded-full px-4 text-sm disabled:opacity-50"
								onClick={() => void decide({ kind: "approve" })}
							>
								{busy === "approve" ? "提交中…" : "批准并执行"}
							</button>
							<button
								type="button"
								disabled={disabled}
								className="focus-neko h-9 rounded-full border border-ink-300 bg-surface px-3 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-50"
								onClick={() => setRevising(true)}
							>
								要求修改
							</button>
							<button
								type="button"
								disabled={disabled}
								className="focus-neko h-9 rounded-full border border-sakura-300 bg-surface px-3 text-sm text-sakura-800 hover:bg-sakura-50 disabled:opacity-50"
								onClick={() => void exit()}
							>
								{busy === "exit" ? "处理中…" : "取消并退出计划模式"}
							</button>
							<span className="min-w-0 text-xs text-ink-500">不决定也可继续输入，新的消息会取代这份计划。</span>
						</>
					)}
				</div>
			</div>
		</section>
	);
}
