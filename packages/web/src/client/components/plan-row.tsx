import type { ChatItem } from "@neko-harness/core";
import type { PlanStatus } from "@neko-harness/core/interactions";
import { useT } from "../lib/i18n/index.ts";
import { plainText } from "../lib/interactions";
import { planStatusLabel } from "../lib/plan-ui";
import { Markdown } from "./markdown";
import { Icon } from "./primitives";

type SubmitPlan = Extract<NonNullable<Extract<ChatItem, { type: "tool" }>["interaction"]>, { kind: "submit_plan" }>;

/**
 * History line of a `submit_plan` call: the submitted title and steps from the persisted structured details.
 * The decision controls live only in the plan card above the composer; `status` is the plan's current status
 * when the viewer knows it, otherwise the row stays neutral.
 */
export function PlanRow({ interaction, status }: { interaction: SubmitPlan; status?: PlanStatus }) {
	const t = useT();
	return (
		<section
			aria-label={t("plan.row.section")}
			data-plan-row
			data-status={status}
			className="rounded-card border border-tianyi-200 bg-surface px-3 py-2 text-sm shadow-soft"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-tianyi-700 px-2 py-0.5 text-xs font-semibold text-on-accent">
					<Icon name="sparkles" size={12} />
					{t("plan.card.badge")}
				</span>
				{status !== undefined && (
					<span className="shrink-0 rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-xs font-medium text-ink-700">
						{planStatusLabel(status)}
					</span>
				)}
			</div>
			<p className="mt-1.5 whitespace-pre-wrap break-words font-semibold text-ink-900">
				{plainText(interaction.title)}
			</p>
			<ol className="mt-1 max-h-40 list-decimal space-y-0.5 overflow-y-auto pl-5 text-ink-800">
				{interaction.steps.map((step, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: steps are fixed for a version and may repeat.
					<li key={index} className="break-words pl-1">
						<Markdown text={step} />
					</li>
				))}
			</ol>
		</section>
	);
}
