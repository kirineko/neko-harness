import type { ChatItem } from "@neko-harness/core";
import { interactionAnswer, plainText, QUESTION_STATUS_LABEL } from "../lib/interactions";
import { Icon } from "./primitives";

type AskUser = Extract<NonNullable<Extract<ChatItem, { type: "tool" }>["interaction"]>, { kind: "ask_user" }>;

const STATUS_STYLE: Record<AskUser["status"], string> = {
	pending: "border-tianyi-300 bg-tianyi-100 text-tianyi-900",
	answered: "border-ink-200 bg-ink-50 text-ink-700",
	skipped: "border-ink-200 bg-ink-50 text-ink-700",
	cancelled: "border-sakura-300 bg-sakura-50 text-sakura-800",
};

function outcome(interaction: AskUser): string | null {
	if (interaction.status === "answered") return `回答：${plainText(interactionAnswer(interaction))}`;
	if (interaction.status === "skipped") return "已跳过，未提供答案";
	if (interaction.status === "cancelled") return "问题已取消，没有收到回答";
	return null;
}

/**
 * History line of an `ask_user` call: status, question and the final answer, all from the persisted
 * structured details. It has no answer controls; those live only in the question card above the composer.
 */
export function AskUserRow({ interaction, onLocate }: { interaction: AskUser; onLocate?: () => void }) {
	const result = outcome(interaction);
	return (
		<section
			aria-label="助手提问记录"
			data-ask-user-row
			data-status={interaction.status}
			className="rounded-card border border-tianyi-200 bg-surface px-3 py-2 text-sm shadow-soft"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-tianyi-700 px-2 py-0.5 text-xs font-semibold text-on-accent">
					<Icon name="sparkles" size={12} />
					助手提问
				</span>
				<span
					className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[interaction.status]}`}
				>
					{QUESTION_STATUS_LABEL[interaction.status]}
				</span>
				{onLocate && (
					<button
						type="button"
						className="focus-neko ml-auto shrink-0 rounded-full border border-tianyi-300 px-3 py-1 text-xs text-tianyi-900 hover:bg-tianyi-50"
						onClick={onLocate}
					>
						定位到问题
					</button>
				)}
			</div>
			<p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-ink-900">
				{plainText(interaction.question)}
			</p>
			{result !== null && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-700">{result}</p>}
		</section>
	);
}
