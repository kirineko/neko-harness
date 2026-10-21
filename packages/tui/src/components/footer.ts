import { basename } from "node:path";
import { type Component, type TuiMouseEvent, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens, modelDisplayName } from "../format.ts";
import { labels } from "../labels.ts";
import { theme } from "../theme/index.ts";

export type FooterStats = {
	readonly contextUsage?: { tokens: number | null; window: number; percent: number | null };
	readonly subagentCount?: number;
	readonly approvalCount?: number;
	/** Running background jobs; omitted or 0 shows nothing. */
	readonly jobCount?: number;
	/** Questions waiting for the user's answer; omitted or 0 shows nothing. */
	readonly questionCount?: number;
	/** The question panel is open, so Esc closes it rather than stopping the run. */
	readonly questionOpen?: boolean;
	/** The session is in plan mode (read-only planning); shown first in the identity so narrow rows keep it. */
	readonly planMode?: boolean;
	/** A submitted plan waits for the user's decision. */
	readonly planAwaiting?: boolean;
	/** The plan panel is open, so Esc closes it rather than stopping the run. */
	readonly planOpen?: boolean;
	/** Compact todo progress such as `Todos 2/5`; omitted while the list is empty or unsupported. */
	readonly todoProgress?: string;
	readonly model: string;
	readonly thinkingLevel: string | null;
	readonly busy: string | undefined;
	readonly compaction?: string;
	readonly canAbort?: boolean;
	readonly usageText: string;
	readonly cwd: string;
};

/** 主行右侧状态词的语义色:就绪 ok / 忙碌 accent / 压缩进行 warning / 失败 error。 */
type StatusTone = "ok" | "accent" | "warning" | "error";

/**
 * 状态栏两行(design D8):主行身份(工作区 · 模型 · Think 档)+ 右对齐状态词,
 * 副行度量(Ctx/In/Out/Cache/成本)+ 键位提示。窄屏按候选列表逐级退化。
 */
export class StatusFooter implements Component {
	panelOpen = false;
	onOpenAgents?: () => void;
	#stats: FooterStats | undefined;
	setStats(stats: FooterStats): void {
		this.#stats = stats;
	}
	invalidate(): void {}
	handleMouse(event: TuiMouseEvent) {
		if (
			!this.#stats?.subagentCount ||
			this.panelOpen ||
			event.y !== 1 ||
			event.type !== "click" ||
			event.button !== "left"
		)
			return;
		this.onOpenAgents?.();
		return { handled: true };
	}

	#tone(): StatusTone {
		const s = this.#stats;
		if (!s) return "ok";
		if (s.compaction !== undefined) {
			if (s.compaction.startsWith("Compaction failed")) return "error";
			if (["Compacting", "Waiting", "Retrying", "Applying"].some((w) => s.compaction!.includes(w))) return "warning";
			return "ok";
		}
		return s.busy ? (s.questionCount ? "warning" : "accent") : "ok";
	}

	render(width: number): string[] {
		const s = this.#stats;
		if (!s) return [labels.connecting, ""].map((x) => truncateToWidth(x, width));
		const space = Math.max(1, width - 2);

		// —— 主行:身份(左)+ 状态词(右)——
		const statusText = truncateToWidth(s.compaction ?? s.busy ?? labels.ready, Math.min(28, Math.floor(space / 2)));
		const tone = this.#tone();
		const statusStyled =
			tone === "error"
				? theme.error(statusText)
				: tone === "warning"
					? theme.warning(statusText)
					: tone === "accent"
						? theme.accent(statusText)
						: theme.ok(statusText);
		const modelShort = modelDisplayName(s.model);
		const identity: Array<{ text: string; slot: (t: string) => string }> = [
			...(s.planMode ? [{ text: "PLAN", slot: theme.warning }] : []),
			{ text: basename(s.cwd) || s.cwd, slot: theme.muted },
			{ text: modelShort, slot: theme.model },
			...(s.thinkingLevel ? [{ text: `Think ${s.thinkingLevel}`, slot: theme.dim }] : []),
		];
		const statusWidth = visibleWidth(statusText);
		// 逐级丢弃最右身份段,直到左段与状态词可容纳(至少留 1 格间隔)。
		const leftBudget = Math.max(1, space - statusWidth - 1);
		let left = "";
		let leftWidth = 0;
		for (let count = identity.length; count >= 1 && left === ""; count--) {
			const parts = identity.slice(0, count).map((p) => p.text);
			if (parts.join(" · ").length <= leftBudget) {
				left = parts.map((text, i) => identity[i]!.slot(text)).join(theme.dim(" · "));
				leftWidth = parts.join(" · ").length;
			}
		}
		if (left === "") {
			left = theme.muted(truncateToWidth(identity[0]!.text, leftBudget));
			leftWidth = Math.min(visibleWidth(identity[0]!.text), leftBudget);
		}
		const gap = Math.max(1, space - leftWidth - statusWidth);
		const first = ` ${left}${" ".repeat(gap)}${statusStyled}`;

		// —— 副行:度量 + 键位(候选逐级退化)——
		const agentHint = s.subagentCount
			? this.panelOpen
				? ""
				: `→ Agents ${s.subagentCount}${s.approvalCount ? ` · Approval ${s.approvalCount}` : ""}`
			: "";
		const jobHint = s.jobCount && !this.panelOpen ? `Jobs ${s.jobCount}` : "";
		const questionHint = s.questionCount ? `${s.questionCount} question${s.questionCount > 1 ? "s" : ""} waiting` : "";
		const todoHint = s.todoProgress ?? "";
		const planHint = s.planAwaiting ? "Plan awaiting approval, /plan to view" : "";
		const dockOpen = s.questionOpen || s.planOpen;
		const hints = this.panelOpen
			? ""
			: dockOpen
				? "Esc Close · Ctrl+C Stop"
				: s.canAbort && !s.busy
					? "Esc Stop"
					: s.busy
						? labels.busyHints
						: labels.idleHints;
		const compactHints = dockOpen
			? "Esc Close · Ctrl+C Stop"
			: s.canAbort && !s.busy
				? "Esc Stop"
				: s.busy
					? labels.busyCompact
					: labels.idleCompact;
		const context = s.contextUsage;
		const contextText =
			context && context.window > 0
				? `Ctx ${context.percent === null ? "?" : `${context.percent.toFixed(1)}%`}/${formatTokens(context.window)}`
				: "";
		const usage = [contextText, s.usageText].filter(Boolean).join(" · ");
		const cost = s.usageText.match(/\$[\d.]+/)?.[0] ?? "";
		const essentials = [contextText, cost].filter(Boolean).join(" · ");
		const shortContext = contextText.split("/")[0] ?? "";
		const shortEssentials = [shortContext, cost].filter(Boolean).join(" · ");
		const minimalHints = this.panelOpen
			? ""
			: dockOpen
				? "Esc Close"
				: s.canAbort || s.busy
					? "Esc Stop"
					: "/help Keys";
		// A waiting question or plan is blocking, so it outlives every other hint when the row is short.
		const joinHints = (metric: string, hint: string, todo = true) =>
			[metric, questionHint, planHint, todo ? todoHint : "", agentHint, jobHint, hint].filter(Boolean).join(" · ");
		const candidates = this.panelOpen
			? [joinHints(essentials, hints), joinHints(shortEssentials, hints), joinHints("", hints, false)]
			: [
					joinHints(usage, compactHints),
					joinHints(essentials, compactHints),
					joinHints(essentials, minimalHints),
					joinHints(shortEssentials, minimalHints, false),
					joinHints("", minimalHints, false),
				];
		const second =
			candidates.find((line) => visibleWidth(line) <= space) ??
			([questionHint, planHint, agentHint, jobHint].filter(Boolean).join(" · ") || minimalHints);
		// Ctx 占比阈值配色:>90% error、>75% warning,否则随副行弱化。
		// 分段着色,而非 dim 包裹后字符串替换(SGR [39m 会截断外层的 dim)。
		const shownContext = second.includes(contextText) ? contextText : shortContext;
		const percent = context?.percent ?? null;
		const contextLabel =
			percent !== null && percent > 90
				? theme.error(shownContext)
				: percent !== null && percent > 75
					? theme.warning(shownContext)
					: theme.muted(shownContext);
		let secondLine: string;
		const contextAt = shownContext !== "" ? second.indexOf(shownContext) : -1;
		if (contextAt >= 0) {
			const dimSeg = (text: string) => (text === "" ? "" : theme.dim(text));
			secondLine =
				dimSeg(second.slice(0, contextAt)) + contextLabel + dimSeg(second.slice(contextAt + shownContext.length));
		} else {
			secondLine = theme.dim(second);
		}
		return [first, ` ${secondLine}`].map((line) => truncateToWidth(line, width));
	}
}

export function usageText(input: number, output: number, cacheRead: number, costTotal: number): string {
	return `In: ${formatTokens(input)} Out: ${formatTokens(output)} Cache: ${formatTokens(cacheRead)} $${costTotal.toFixed(4)}`;
}
