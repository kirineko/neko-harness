import type { NekoSkillInfo } from "@neko-harness/core";
import { replaceMention } from "@neko-harness/core/file-mentions";
import { compactInstructions, type ImageFile } from "@neko-harness/core/image-transfer";
import { promptHistory } from "@neko-harness/core/input-history";
import type { WireQueuedInput } from "@neko-harness/gateway/contract";
import { Link } from "@tanstack/react-router";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { appActions } from "../lib/bootstrap";
import { commandSuggestions, isCommandQuery } from "../lib/command-suggestions";
import { fitHeight } from "../lib/composer-height";
import { type HistoryBrowse, stepHistory } from "../lib/input-history";
import { PLAN_MODE_LABEL, PLAN_UNSUPPORTED_TEXT, planCommandArgs, planErrorText, planState } from "../lib/plan-ui";
import { providerIssue, providerName } from "../lib/providers";
import { questionUi } from "../lib/question-ui";
import { getState, storeActions, useNekoState } from "../lib/store";
import { readUpgradeDraft, removeUpgradeDraft, saveUpgradeDraft } from "../lib/upgrade-draft";
import { ComposerSuggestions } from "./composer-suggestions";
import { useFileMentions } from "./file-mentions";
import { ModelPicker } from "./model-picker";
import { Icon } from "./primitives";
import { QueueBar } from "./queue-bar";

type Attachment = { id: string; file: File; error?: string; processing?: boolean };
type Draft = { text: string; files: Attachment[]; requestId: string };
const drafts = new Map<string, Draft>();
const draftListeners = new Set<() => void>();
const submitting = new Set<string>();
/** Whether the user is composing here (a non-empty draft or the input has focus); a question card then stays folded. */
export function composerEngaged(sessionId: string): boolean {
	const draft = drafts.get(sessionId);
	if (draft && (draft.text.trim() !== "" || draft.files.length > 0)) return true;
	const active = document.activeElement;
	return active?.tagName === "TEXTAREA" && active.getAttribute("aria-label") === "消息输入";
}
export function reloadForUpgrade(): void {
	const state = getState(),
		session = state.currentSessionId,
		key = session ?? `none:${state.workspaceRoot}`;
	const draft = drafts.get(key);
	if (submitting.size || state.operating) {
		storeActions.notice({ level: "info", text: "发送中，请稍后刷新" });
		return;
	}
	if ([...drafts.values()].some((d) => d.files.length)) {
		storeActions.notice({ level: "info", text: "先发送或移除附件，再刷新" });
		return;
	}
	if (!state.webInfo) {
		storeActions.notice({ level: "error", text: "连接未就绪，请稍后重试" });
		return;
	}
	// Preserve other sessions' drafts by asking the user to handle them first.
	if ([...drafts.entries()].some(([id, d]) => id !== key && d.text.trim())) {
		storeActions.notice({ level: "info", text: "其他会话有草稿，请先发送或清空" });
		return;
	}
	try {
		saveUpgradeDraft({
			version: 1,
			serverId: state.webInfo.serverId,
			workspace: state.workspaceRoot,
			session,
			text: draft?.text ?? "",
			requestId: draft?.requestId ?? crypto.randomUUID(),
		});
	} catch {
		storeActions.notice({ level: "error", text: "草稿保存失败，请先复制文字" });
		return;
	}
	window.location.reload();
}

const subscribeDrafts = (listener: () => void) => {
	draftListeners.add(listener);
	return () => {
		draftListeners.delete(listener);
	};
};
type Props = { busy: boolean; status: string | null; disabled?: boolean };

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`;
}
export function Composer(props: Props) {
	const { currentSessionId, workspaceRoot } = useNekoState();
	return (
		<SessionComposer
			key={currentSessionId ?? `none:${workspaceRoot}`}
			sessionId={currentSessionId ?? `none:${workspaceRoot}`}
			{...props}
		/>
	);
}
function Thumbnail({ file }: { file: File }) {
	const [url, setUrl] = useState("");
	useEffect(() => {
		const next = URL.createObjectURL(file);
		setUrl(next);
		return () => URL.revokeObjectURL(next);
	}, [file]);
	return <img src={url || undefined} alt={file.name} className="h-16 w-20 rounded-lg object-cover" />;
}
function SessionComposer(props: Props & { sessionId: string }) {
	const { credentials, view, models, workspaceRoot, phase, operating } = useNekoState();
	const active = view?.compaction?.active ?? [];
	if (!drafts.has(props.sessionId))
		drafts.set(props.sessionId, { text: "", files: [], requestId: crypto.randomUUID() });
	useEffect(() => {
		const recovery = readUpgradeDraft(),
			state = getState();
		if (
			recovery &&
			recovery.serverId === state.webInfo?.serverId &&
			recovery.workspace === workspaceRoot &&
			(recovery.session ?? `none:${workspaceRoot}`) === props.sessionId
		) {
			drafts.set(props.sessionId, { text: recovery.text, files: [], requestId: recovery.requestId });
			removeUpgradeDraft();
			for (const listener of draftListeners) listener();
		}
	}, [props.sessionId, workspaceRoot]);

	const draft = useSyncExternalStore(subscribeDrafts, () => drafts.get(props.sessionId)!);

	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [note, setNote] = useState("");
	const [withdrawing, setWithdrawing] = useState<number | null>(null);
	const [menu, setMenu] = useState(false);
	const [skills, setSkills] = useState<readonly NekoSkillInfo[]>([]);
	const [commandSelected, setCommandSelected] = useState(0);
	const [skillStatus, setSkillStatus] = useState("");
	const commandId = useId();
	const [drag, setDrag] = useState(false);
	const textarea = useRef<HTMLTextAreaElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const picker = useRef<HTMLInputElement>(null);
	const current = useRef(draft);
	current.current = draft;
	const locked = useRef(false);
	const history = useMemo(() => promptHistory(view?.items ?? []), [view?.items]);
	const browse = useRef<HistoryBrowse | null>(null);
	const recalled = useRef<"start" | "end" | null>(null);
	useLayoutEffect(() => {
		const el = textarea.current;
		if (!recalled.current || !el) return;
		const at = recalled.current === "start" ? 0 : el.value.length;
		recalled.current = null;
		el.setSelectionRange(at, at);
	});
	// 高度由草稿内容派生：任何清空/替换草稿的路径（发送、切会话、恢复、历史回填）都经此重算。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 高度只取决于文字内容、会话与宽度，这些值是重算触发条件而不在回调中读取。
	useLayoutEffect(() => {
		const el = textarea.current;
		if (el) fitHeight(el);
	}, [draft.text, props.sessionId]);
	useEffect(() => {
		const el = textarea.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let width = el.clientWidth;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			fitHeight(el);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const recallHistory = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget;
		const step = stepHistory(browse.current, history, e, el.value, { start: el.selectionStart, end: el.selectionEnd });
		if (!step) return false;
		browse.current = step.browse;
		recalled.current = step.caret;
		setMenu(false);
		edit({ text: step.text });
		return true;
	};
	const update = (next: Draft) => {
		current.current = next;
		drafts.set(props.sessionId, next);
		for (const listener of draftListeners) listener();
	};
	const edit = (next: Partial<Draft>) => update({ ...current.current, ...next, requestId: crypto.randomUUID() });
	const issue = providerIssue(credentials, view?.agent.model?.provider);
	const missingKey = issue !== null;
	const model = models.find(
		(m) => m.provider === view?.agent.model?.provider && m.modelId === view?.agent.model?.modelId,
	);
	const noVision = draft.files.length > 0 && model !== undefined && !model.input.includes("image");
	const add = (files: File[]) => {
		const next: Attachment[] = files.map((file) => ({
			id: crypto.randomUUID(),
			file,
			processing: true,
			error: !["image/png", "image/jpeg", "image/webp"].includes(file.type)
				? "仅支持 PNG、JPEG、WebP"
				: file.size > 20 * 1024 * 1024
					? "单图不能超过 20 MiB"
					: undefined,
		}));
		edit({ files: [...current.current.files, ...next] });
		for (const attachment of next) void validate(attachment);
	};
	const validate = async (attachment: Attachment) => {
		let error = attachment.error;
		if (!error) {
			try {
				const bitmap = await createImageBitmap(attachment.file);
				bitmap.close();
			} catch {
				error = "无法解码图片，请重新选择";
			}
		}
		const saved = drafts.get(props.sessionId);
		if (!saved?.files.some((a) => a.id === attachment.id)) return;
		const next = {
			...saved,
			files: saved.files.map((a) => (a.id === attachment.id ? { ...a, error, processing: false } : a)),
		};
		update(next);
	};
	const imageRequest = useRef<AbortController | null>(null);
	const creating = useRef(false);
	useEffect(
		() => () => {
			if (!creating.current) imageRequest.current?.abort();
		},
		[],
	);
	useEffect(() => {
		setSkills([]);
		setCommandSelected(0);
		if (!menu) return;
		if (props.sessionId.startsWith("none:")) {
			setSkillStatus("新建会话后可选择工作区技能");
			return;
		}
		if (phase !== "ready" || operating) {
			setSkillStatus("等待会话连接…");
			return;
		}
		const controller = new AbortController();
		setSkillStatus("正在加载技能…");
		void appActions
			.listSkills(props.sessionId, controller.signal)
			.then((list) => {
				if (controller.signal.aborted) return;
				setSkills(list);
				setSkillStatus(list.length ? "" : "当前工作区暂无可用技能");
			})
			.catch(() => {
				if (!controller.signal.aborted) setSkillStatus("技能加载失败，请关闭菜单后重试");
			});
		return () => controller.abort();
	}, [props.sessionId, phase, operating, menu]);
	const mentions = useFileMentions(textarea, card, workspaceRoot, phase === "ready" && !operating, (item, token) => {
		const before = current.current;
		if (item.kind === "file" && /\.(png|jpe?g|webp)$/i.test(item.path)) {
			if (imageRequest.current) return;
			const controller = new AbortController();
			imageRequest.current = controller;
			setError("正在读取图片…");
			void (async () => {
				let sessionId = props.sessionId;
				if (sessionId.startsWith("none:")) {
					creating.current = true;
					await appActions.createSession();
					const state = getState();
					if (state.workspaceRoot !== workspaceRoot || !state.currentSessionId) throw new Error("工作区已切换");
					sessionId = state.currentSessionId;
					drafts.set(sessionId, before);
					for (const listener of draftListeners) listener();
				}
				const file = await appActions.workspaceImage(item.path, sessionId, controller.signal);
				if (
					controller.signal.aborted ||
					getState().currentSessionId !== sessionId ||
					getState().workspaceRoot !== workspaceRoot
				)
					return;
				const saved = drafts.get(sessionId) ?? before;
				const attachment = {
					id: crypto.randomUUID(),
					file: new File([new Uint8Array(file.bytes)], file.name, { type: file.mimeType }),
				};
				const text =
					saved.text === before.text ? before.text.slice(0, token.start) + before.text.slice(token.end) : saved.text;
				drafts.set(sessionId, { ...saved, text, files: [...saved.files, attachment], requestId: crypto.randomUUID() });
				for (const listener of draftListeners) listener();
				setError("");
			})()
				.catch((error) => {
					if (!controller.signal.aborted) {
						const text = error instanceof Error ? error.message : "图片读取失败，请重试";
						setError(text);
						if (creating.current) storeActions.notice({ level: "error", text });
					}
				})
				.finally(() => {
					if (imageRequest.current === controller) imageRequest.current = null;
				});
			return;
		}
		const replacement = replaceMention(before.text, token, item.path, item.kind === "directory");
		const el = textarea.current;
		if (el) {
			el.focus();
			el.setSelectionRange(token.start, token.end);
			// Native insertion preserves the browser undo stack where supported.
			const inserted = replacement.text.slice(token.start, replacement.text.length - (before.text.length - token.end));
			if (!document.execCommand("insertText", false, inserted)) edit({ text: replacement.text });
			else edit({ text: el.value });
			requestAnimationFrame(() => {
				el.setSelectionRange(replacement.cursor, replacement.cursor);
				if (item.kind === "directory") mentions.refresh();
			});
		}
	});
	// 压缩相位（自原 status-bar 迁入）：瞬态相位（已压缩/失败等）只在短时间内展示，
	// expired 为渲染期读取的派生状态，定时器仅负责到期时翻转这个布尔值。
	const context = view?.contextUsage;
	const latest = view?.compaction?.latest;
	const transient = latest && !["summarizing", "waiting-to-apply"].includes(latest.phase);
	const expiresAt = transient ? latest.at + (latest.phase === "failed" ? 10000 : 5000) : null;
	const [expired, setExpired] = useState(expiresAt !== null && expiresAt <= Date.now());
	useEffect(() => {
		setExpired(expiresAt !== null && expiresAt <= Date.now());
		if (expiresAt === null || expiresAt <= Date.now()) return;
		const timer = setTimeout(() => setExpired(true), expiresAt - Date.now());
		return () => clearTimeout(timer);
	}, [expiresAt]);
	const compaction = active.length
		? active.some((c) => c.retry)
			? "压缩重试中"
			: active.some((c) => c.blocking)
				? "等待上下文压缩"
				: "正在压缩上下文"
		: view?.compaction?.failure
			? `压缩失败：${view.compaction.failure.error}`
			: latest && !expired
				? {
						applied: "上下文已压缩",
						nothing: "当前无需压缩",
						skipped: "已跳过过期摘要",
						cancelled: "压缩已取消",
						failed: "压缩失败，可重试",
						summarizing: "正在压缩上下文",
						"waiting-to-apply": "等待应用压缩摘要",
					}[latest.phase]
				: null;
	const compactionFailed = !active.length && (!!view?.compaction?.failure || latest?.phase === "failed");
	const usage = view?.taskUsage ?? view?.usage ?? null;
	const compact = async (instructions: string) => {
		if (locked.current || props.disabled) return;
		locked.current = true;
		setPending(true);
		submitting.add(props.sessionId);
		setError("");
		const before = current.current;
		drafts.set(props.sessionId, before);
		try {
			await appActions.compact(instructions, props.sessionId);
			if (
				current.current === before &&
				drafts.get(props.sessionId) === before &&
				compactInstructions(before.text) !== null
			)
				update({ ...before, text: "", requestId: crypto.randomUUID() });
			setMenu(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "压缩失败，请重试");
		} finally {
			locked.current = false;
			setPending(false);
			submitting.delete(props.sessionId);
		}
	};
	const plan = planState({ view, phase, operating });
	// Handled before any busy queueing: the command is never a message, never history, never sent to the model.
	const togglePlan = async (args: string) => {
		if (locked.current || props.disabled) return;
		setError("");
		setNote("");
		if (args !== "") {
			setNote("/plan 不接受参数；先切换到规划模式，再正常描述需求");
			return;
		}
		if (props.sessionId.startsWith("none:")) {
			setNote("请先开始会话，再切换规划模式");
			return;
		}
		if (plan === null) {
			setNote(PLAN_UNSUPPORTED_TEXT);
			return;
		}
		if (props.busy) {
			setNote("会话运行中，请先等待回答结束或停止后再切换规划模式");
			return;
		}
		locked.current = true;
		setPending(true);
		const before = current.current;
		try {
			await appActions.planMode(props.sessionId, plan.mode === "plan" ? "normal" : "plan");
			if (current.current === before && drafts.get(props.sessionId) === before && planCommandArgs(before.text) !== null)
				update({ ...before, text: "", requestId: crypto.randomUUID() });
			setMenu(false);
		} catch (e) {
			const text = planErrorText(e);
			(text.startsWith("会话运行中") ? setNote : setError)(text);
		} finally {
			locked.current = false;
			setPending(false);
		}
	};
	const submit = async () => {
		const instructions = compactInstructions(current.current.text);
		if (instructions !== null) {
			await compact(instructions);
			return;
		}
		const planArgs = planCommandArgs(current.current.text);
		if (planArgs !== null) {
			await togglePlan(planArgs);
			return;
		}
		const before = current.current;
		drafts.set(props.sessionId, before);
		if (locked.current || props.disabled || missingKey || noVision || (!before.text.trim() && !before.files.length))
			return;
		if (before.files.length > 4 || before.files.reduce((n, a) => n + a.file.size, 0) > 40 * 1024 * 1024) {
			setError("每条消息最多 4 张图片，总大小不超过 40 MiB");
			return;
		}
		if (before.files.some((a) => a.processing)) return;
		if (before.files.some((a) => a.error)) {
			setError("请先移除不支持的附件");
			return;
		}
		locked.current = true;
		setPending(true);
		submitting.add(props.sessionId);
		setError("");
		setNote("");
		try {
			const files: ImageFile[] = [];
			for (const a of before.files)
				files.push({ name: a.file.name, mimeType: a.file.type, bytes: new Uint8Array(await a.file.arrayBuffer()) });
			let target = props.sessionId;
			if (target.startsWith("none:")) {
				await appActions.createSession();
				const state = getState();
				if (state.workspaceRoot !== workspaceRoot || !state.currentSessionId)
					throw new Error("工作区已切换，草稿已保留");
				target = state.currentSessionId;
				drafts.set(target, before);
				for (const listener of draftListeners) listener();
			}
			await appActions.submit(before.text.trim(), files, before.requestId, target);
			if (target !== props.sessionId) {
				drafts.set(target, { text: "", files: [], requestId: crypto.randomUUID() });
				for (const listener of draftListeners) listener();
			}
			const saved = drafts.get(props.sessionId);
			if (saved)
				update({
					text: saved.text === before.text ? "" : saved.text,
					files: saved.files.filter((a) => !before.files.some((sent) => sent.id === a.id)),
					requestId: crypto.randomUUID(),
				});
		} catch (e) {
			const message = e instanceof Error ? e.message : "发送失败，请重试";
			setError(message);
			if (getState().currentSessionId !== props.sessionId) storeActions.notice({ level: "error", text: message });
		} finally {
			locked.current = false;
			setPending(false);
			submitting.delete(props.sessionId);
		}
	};
	const menuItems = commandSuggestions(draft.text, skills, { plan: plan !== null });
	const selectedCommand = Math.min(commandSelected, Math.max(0, menuItems.length - 1));
	const acceptCommand = (index = selectedCommand) => {
		const item = menuItems[index];
		if (!item) return;
		edit({ text: `${item.label} ` });
		setMenu(false);
		textarea.current?.focus();
	};
	const queued = view?.queued ?? [];
	const waitingQuestions = view?.questions?.pending ?? [];
	const openQuestion = () => {
		const active = questionUi.state.active[props.sessionId];
		const target = waitingQuestions.find((q) => q.id === active) ?? waitingQuestions[0];
		if (target) questionUi.open(props.sessionId, target);
	};
	const steerQueued = async (item: WireQueuedInput) => {
		if (withdrawing !== null) return;
		setWithdrawing(item.id);
		setError("");
		setNote("");
		try {
			const outcome = await appActions.steer(props.sessionId, item.id);
			if (outcome.result === "withdrawn") {
				const base = current.current.text;
				const text = outcome.text ?? item.preview;
				edit({ text: base.trim() ? `${base}\n${text}` : text });
				setNote("无法改为引导，消息已撤回到输入框");
			} else if (outcome.result === "unknown") setNote("该消息已不在队列中");
			else if (outcome.result !== "steered") setNote("该消息已发送，无法引导");
		} catch (e) {
			setError(e instanceof Error ? e.message : "引导失败，请重试");
		} finally {
			setWithdrawing(null);
		}
	};
	const withdraw = async (item: WireQueuedInput) => {
		if (withdrawing !== null) return;
		setWithdrawing(item.id);
		setError("");
		setNote("");
		try {
			const outcome = await appActions.withdraw(props.sessionId, item.id);
			if (outcome.result === "withdrawn") {
				const base = current.current.text;
				const text = outcome.text ?? item.preview;
				edit({ text: base.trim() ? `${base}\n${text}` : text });
				if (outcome.images) setNote("图片未恢复，请重新添加");
				textarea.current?.focus();
			} else if (outcome.result === "unknown") setNote("该消息已不在队列中");
			else setNote("该消息已发送，无法撤回");
		} catch (e) {
			setError(e instanceof Error ? e.message : "撤回失败，请重试");
		} finally {
			setWithdrawing(null);
		}
	};
	const busyCard = props.busy || active.some((c) => c.reason === "manual" || c.blocking);
	return (
		<section
			aria-label="消息输入"
			className="relative shrink-0 px-3 pt-1 pb-3 sm:px-4 sm:pb-4"
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes("Files")) {
					e.preventDefault();
					setDrag(true);
				}
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
			}}
			onDrop={(e) => {
				e.preventDefault();
				setDrag(false);
				add(Array.from(e.dataTransfer.files));
			}}
		>
			<div className="chat-column">
				<QueueBar
					queued={queued}
					busy={withdrawing !== null}
					onSteer={(item) => void steerQueued(item)}
					onWithdraw={(item) => void withdraw(item)}
				/>
				<div
					ref={card}
					className={`composer-card ${busyCard ? "is-busy" : ""} ${drag ? "ring-2 ring-sakura-300" : ""}`}
				>
					{/* 通知/错误行：固定位于卡片顶部，集中间距 */}
					<div className="flex flex-col gap-1 px-4 pt-2.5 empty:pt-0">
						{waitingQuestions.length > 0 && (
							<output
								data-question-hint
								className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug text-tianyi-900 sm:text-sm"
							>
								<span className="min-w-0 break-words">
									助手正在等待你的回答。此处发送的消息仍会排队（含引导），回答或跳过后才进入上下文，不会当作答案。
								</span>
								<button
									type="button"
									className="focus-neko shrink-0 rounded-full border border-tianyi-300 bg-tianyi-50 px-2.5 py-0.5 text-xs text-tianyi-900 hover:bg-tianyi-100"
									onClick={openQuestion}
								>
									打开问题
								</button>
							</output>
						)}
						{drag && <p className="text-sm text-sakura-700">松开以添加图片，不会自动发送</p>}
						{issue && (
							<p className="text-sm text-sakura-700">
								{issue === "disabled"
									? `模型服务 ${providerName(view?.agent.model?.provider ?? "")} 已取消启用，请重新启用或切换模型。`
									: `尚未配置 ${providerName(view?.agent.model?.provider ?? "")} Key。`}
								<Link
									to="/settings"
									hash={`credential-${view?.agent.model?.provider ?? ""}`}
									className="focus-neko underline"
								>
									前往设置
								</Link>
							</p>
						)}
						{noVision && <p className="text-sm text-sakura-700">当前模型不支持图片，请切换模型或移除附件。</p>}
						{!model?.input.includes("image") && view?.items.some((i) => i.type === "user" && i.images?.length) && (
							<p className="text-xs text-ink-500">当前模型无法查看历史原图，仍可使用已有文字分析。</p>
						)}
						{note && <output className="block break-words text-sm text-ink-600">{note}</output>}
						{error && (
							<p role="alert" className="break-words text-sm text-sakura-700">
								{error}
							</p>
						)}
					</div>
					{!!draft.files.length && (
						<ul className="flex max-h-40 flex-wrap gap-2 overflow-y-auto px-4 pt-2.5">
							{draft.files.map((a) => (
								<li key={a.id} className="relative w-28 rounded-xl border border-sakura-200 bg-base p-2">
									<Thumbnail file={a.file} />
									<span className="block truncate text-xs" title={a.file.name}>
										{a.file.name}
									</span>
									{a.processing && <span className="text-xs text-ink-500">检查图片…</span>}
									{a.error && <span className="text-xs text-sakura-700">{a.error}</span>}
									<button
										type="button"
										aria-label={`移除 ${a.file.name}`}
										className="focus-neko absolute right-0 top-0 rounded-full bg-base px-1"
										onClick={() => edit({ files: current.current.files.filter((f) => f.id !== a.id) })}
									>
										×
									</button>
								</li>
							))}
						</ul>
					)}
					<textarea
						ref={textarea}
						disabled={props.disabled}
						value={draft.text}
						rows={1}
						placeholder={
							waitingQuestions.length > 0
								? "助手在等你回答，此处消息将排队"
								: props.busy
									? "运行中：消息将在回答结束后排队，可在排队条中引导或撤回"
									: "输入消息，@ 引用文件，/ 命令"
						}
						aria-label="消息输入"
						aria-autocomplete="list"
						aria-controls={mentions.controls ?? (menu ? commandId : undefined)}
						aria-activedescendant={
							mentions.active ?? (menu && menuItems.length ? `${commandId}-${selectedCommand}` : undefined)
						}
						onClick={(e) => {
							mentions.refresh();
							setMenu(isCommandQuery(e.currentTarget.value));
						}}
						onBlur={() => {
							mentions.close();
							setMenu(false);
						}}
						onCompositionStart={() => {
							mentions.close();
							setMenu(false);
						}}
						onCompositionEnd={(e) => {
							mentions.refresh();
							setMenu(isCommandQuery(e.currentTarget.value));
						}}
						className="composer-input max-h-40 min-h-10 min-w-0 w-full resize-none bg-transparent px-4 py-2 text-ink-900 focus:outline-none"
						onChange={(e) => {
							browse.current = null;
							edit({ text: e.target.value });
							setCommandSelected(0);
							setMenu(!(e.nativeEvent as InputEvent).isComposing && isCommandQuery(e.target.value));
							if (!(e.nativeEvent as InputEvent).isComposing) mentions.refresh();
						}}
						onPaste={(e) => {
							const files = Array.from(e.clipboardData.files);
							if (files.length) {
								e.preventDefault();
								add(files);
							}
						}}
						onKeyDown={(e) => {
							if (e.nativeEvent.isComposing) return;
							if (mentions.keyDown(e)) return;
							if (e.key === "Escape" && menu) {
								e.preventDefault();
								setMenu(false);
							} else if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
								e.preventDefault();
								setCommandSelected(
									Math.max(0, Math.min(menuItems.length - 1, selectedCommand + (e.key === "ArrowDown" ? 1 : -1))),
								);
							} else if (menu && e.key === "Tab") {
								if (!e.shiftKey && menuItems.length) {
									e.preventDefault();
									acceptCommand();
								} else setMenu(false);
							} else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !menu && recallHistory(e)) {
								e.preventDefault();
							} else if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								if (menu && menuItems.length) acceptCommand();
								else {
									setMenu(false);
									void submit();
								}
							}
						}}
					/>
					{/* 工具行：附件/命令菜单/模型入口 + 瞬态状态 + 遥测 + 发送/停止 */}
					<div className="composer-toolbar flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-sakura-100 px-2 py-1.5">
						<input
							ref={picker}
							type="file"
							accept="image/png,image/jpeg,image/webp"
							multiple
							hidden
							onChange={(e) => {
								add(Array.from(e.target.files ?? []));
								e.target.value = "";
							}}
						/>
						<button
							type="button"
							aria-label="添加图片"
							title="添加图片（最多 4 张）"
							disabled={props.disabled}
							onClick={() => picker.current?.click()}
							className="focus-neko inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-600 hover:bg-sakura-50"
						>
							<Icon name="plus" />
						</button>
						<button
							type="button"
							aria-label="输入操作菜单"
							aria-expanded={menu}
							className="focus-neko inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-500 hover:bg-sakura-50"
							onClick={() => {
								mentions.close();
								setMenu(!menu);
								textarea.current?.focus();
							}}
						>
							<Icon name="more" />
						</button>
						<div className="min-w-0 max-w-64 [&>button]:max-w-full">
							<ModelPicker current={view?.agent.model ?? null} fallbackLabel={view?.model ?? "…"} />
						</div>
						{context && context.window > 0 && (
							<span
								className={`shrink-0 rounded-full bg-tianyi-50 px-2 py-1 font-mono text-xs ${context.percent !== null && context.percent > 90 ? "text-sakura-700 font-semibold" : "text-ink-600"}`}
								title={
									context.tokens === null
										? "暂无有效用量；首次回答或压缩后的新回答完成后更新"
										: `最近一次成功回答的上下文用量：${context.tokens} / ${context.window} tokens；非会话累计用量`
								}
							>
								Ctx {context.percent === null ? "?" : `${context.percent.toFixed(1)}%`}/{formatTokens(context.window)}
							</span>
						)}
						<output aria-live="polite" aria-atomic="true" className="contents">
							{compaction && (
								<span
									className={`max-w-full whitespace-nowrap rounded-full border px-2 py-1 text-xs ${compactionFailed ? "border-sakura-300 bg-sakura-50 text-sakura-700" : "border-tianyi-200 bg-tianyi-50 text-ink-600"}`}
									title={
										latest?.phase === "nothing" && !active.length
											? "保留近期上下文，暂无可压缩的旧内容；默认保留最近约 20,000 tokens"
											: undefined
									}
								>
									{compaction}
								</span>
							)}
							{plan?.mode === "plan" && (
								<span
									data-plan-mode
									className="max-w-full whitespace-nowrap rounded-full border border-sakura-300 bg-sakura-50 px-2 py-1 text-xs font-medium text-sakura-800"
									title="只读调研并提交计划；批准后自动退出并开始执行。输入 /plan 可退出"
								>
									{PLAN_MODE_LABEL}
								</span>
							)}
						</output>
						<div className="ml-auto flex items-center gap-1">
							{props.busy && props.status !== null && (
								<span
									className="inline-flex min-w-0 max-w-64 items-center gap-1.5 text-xs font-medium text-sakura-700"
									title={props.status}
								>
									<span className="dots shrink-0" aria-hidden>
										<span />
										<span />
										<span />
									</span>
									<span className="truncate">{props.status.replace(/\.\.\.$/, "")}</span>
								</span>
							)}
							{usage !== null && (
								<button
									type="button"
									className="telemetry focus-neko shrink-0 rounded-full px-1.5 py-1 font-mono text-xs text-ink-500"
									aria-label={`任务总用量：输入 ${usage.input}，输出 ${usage.output}，缓存读 ${usage.cacheRead}，成本 ${formatCost(usage.cost)}`}
								>
									↑{formatTokens(usage.input)} ↓{formatTokens(usage.output)}
									<span className="telemetry-detail" aria-hidden>
										输入 {usage.input} · 输出 {usage.output} · 缓存读 {usage.cacheRead} · {formatCost(usage.cost)}
									</span>
								</button>
							)}
							<button
								type="button"
								disabled={
									pending ||
									props.disabled ||
									(!draft.text.trim() && !draft.files.length) ||
									(compactInstructions(draft.text) === null &&
										planCommandArgs(draft.text) === null &&
										(missingKey || noVision || draft.files.some((a) => !!a.error || a.processing)))
								}
								onClick={() => void submit()}
								className="btn-primary focus-neko h-10 shrink-0 rounded-full px-3 text-sm disabled:opacity-50"
							>
								{pending ? "处理中" : props.busy ? "排队" : "发送"}
							</button>
							{busyCard && (
								<button
									type="button"
									onClick={() => appActions.abort()}
									className="btn-stop focus-neko h-10 rounded-full px-2 text-sm"
									title="中止当前会话运行及可中止任务"
								>
									停止
								</button>
							)}
						</div>
					</div>
				</div>
				{mentions.panel}
				{menu && !mentions.open && (
					<ComposerSuggestions
						anchor={card}
						id={commandId}
						title="输入命令"
						items={menuItems}
						selected={selectedCommand}
						onSelect={setCommandSelected}
						message={skillStatus || (menuItems.length ? undefined : "没有匹配的命令或技能")}
						onAccept={acceptCommand}
					/>
				)}
			</div>
		</section>
	);
}
