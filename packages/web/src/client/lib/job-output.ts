import type { JobLike } from "@neko-harness/core/job-summary";
import { formatDuration } from "@neko-harness/core/job-summary";
import { getT, type PlainKey } from "./i18n/index.ts";

const JOB_STATUS_KEYS: Record<JobLike["status"], PlainKey> = {
	running: "job.status.running",
	exited: "job.status.exited",
	failed: "job.status.failed",
	stopped: "job.status.stopped",
	lost: "job.status.lost",
};

/** `Running · 1m 5s`, `Failed · exit code 2`, `Failed · timed out`, `Lost · gateway restarted` (in the UI language). */
export function jobStatusText(job: JobLike, now: number): string {
	const t = getT();
	const status = t(JOB_STATUS_KEYS[job.status]);
	if (job.status === "running") return `${status} · ${formatDuration(now - job.startedAt)}`;
	if (job.reason === "timeout") return `${status} · ${t("job.reason.timeout")}`;
	if (job.reason === "spawn-error") return `${status} · ${t("job.reason.spawnError")}`;
	if (job.exitCode !== null) return `${status} · ${t("job.reason.exitCode", { code: job.exitCode })}`;
	if (job.reason === "restart") return `${status} · ${t("job.reason.restart")}`;
	return `${status} · ${formatDuration((job.endedAt ?? now) - job.startedAt)}`;
}

// CSI, OSC (BEL or ST terminated) and other two-character escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: dropping C0 controls other than \n and \t
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Job output as plain text: no colors or cursor codes, `\r` handled as a line break. */
export function sanitizeJobOutput(text: string): string {
	return text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(CONTROLS, "");
}

/** True when a scroll position counts as "at the bottom" and follow mode should stay on. */
export function atBottom(
	el: { scrollTop: number; scrollHeight: number; clientHeight: number },
	threshold = 24,
): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
