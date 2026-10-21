import { splitJobReport } from "@neko-harness/core/job-summary";
import type { WireJobSummary } from "@neko-harness/gateway/contract";
import { useT } from "../lib/i18n/index.ts";
import { jobStatusText, sanitizeJobOutput } from "../lib/job-output";

/** System notice for a background job report; the output tail is folded and the status follows the live job. */
export function JobReportCard({ text, jobId, job }: { text: string; jobId: string; job?: WireJobSummary | undefined }) {
	const t = useT();
	const { head, command, output } = splitJobReport(text);
	const tail = output === undefined ? undefined : sanitizeJobOutput(output);
	const summary = (
		<>
			<span className="font-medium text-tianyi-700">{t("job.reportTitle", { id: jobId })}</span>
			<span className="min-w-0 break-words text-ink-700">{head.replace(/^\[|\]$/g, "")}</span>
			{job && (
				<span className="rounded-full bg-ink-100 px-2 text-ink-600">
					{t("job.reportCurrent", { status: jobStatusText(job, Date.now()) })}
				</span>
			)}
		</>
	);
	return (
		<div className="chat-row anim-other" data-job-report={jobId}>
			<div className="min-w-0 rounded-xl border border-sakura-200 bg-surface px-3 py-2 text-xs">
				{tail === undefined ? (
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">{summary}</div>
				) : (
					<details>
						<summary className="focus-neko flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1">
							{summary}
						</summary>
						{command !== undefined && (
							<code className="mt-2 block whitespace-pre-wrap break-all text-ink-600">$ {command}</code>
						)}
						<pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-ink-800">
							{tail}
						</pre>
					</details>
				)}
			</div>
		</div>
	);
}
