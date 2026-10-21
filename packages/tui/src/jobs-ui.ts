import { matchesKey, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { JobTail, summarizeJobs } from "@neko-harness/core/job-summary";
import type { JobsClient } from "@neko-harness/gateway/client-session";
import type { WireJobSummary } from "@neko-harness/gateway/contract";
import type { PickerDetail, PickerItem, PickerPanel } from "./components/picker.ts";
import { shortcutHints } from "./components/shortcut-hints.ts";
import { t } from "./i18n/index.ts";
import { theme } from "./theme/index.ts";

export const jobsEmpty = (): string => t("jobs.empty");
const POLL_MS = 1000;
const COMMAND_LINES = 3;

const oneLine = (text: string, max = 200): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function jobItems(jobs: readonly WireJobSummary[], now = Date.now()): PickerItem[] {
	return summarizeJobs(jobs, now).rows.map(({ job, label, running, statusText, meta }) => ({
		value: job.jobId,
		label: `${job.jobId} · ${oneLine(label, 80)}`,
		description: `${oneLine(job.command)} · ${job.cwd}`,
		rightLabel: running ? `${statusText} · ${meta}` : meta === statusText ? statusText : `${statusText} · ${meta}`,
	}));
}

const isControl = (code: number): boolean => (code < 0x20 && code !== 0x0a) || code === 0x7f;

/** Output text safe for a terminal: no escape sequences, normalized line endings. */
export function sanitizeOutput(text: string): string {
	const plain = stripTerminalSequences(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
	let out = "";
	for (const char of plain) if (!isControl(char.charCodeAt(0))) out += char;
	return out;
}

/** Confirm view shared by the list and the detail; Enter stops the job, Esc keeps it running. */
export function confirmStop(
	panel: PickerPanel,
	jobs: JobsClient,
	jobId: string,
	onError: (message: string) => void,
	changed: () => void,
): void {
	let submitted = false;
	panel.showDetail({
		help: shortcutHints(["Enter", t("action.stop")], ["Esc", t("action.back")]),
		lines: () => [theme.warning(t("jobs.confirmStop", { jobId }))],
		handleKey: (key) => {
			if (!matchesKey(key, "enter")) return false;
			if (submitted) return true;
			submitted = true;
			void jobs
				.stop(jobId)
				.catch((error) => onError(error instanceof Error ? error.message : String(error)))
				.finally(() => {
					panel.popDetail();
					changed();
				});
			return true;
		},
	});
}

/** Output tail viewer for one job: incremental polling by offset, follow mode, stop. */
export class JobDetail implements PickerDetail {
	readonly jobId: string;
	#jobs: JobsClient;
	#panel: PickerPanel;
	#changed: () => void;
	readonly #tail = new JobTail();
	#scroll = 0;
	#maxScroll = 0;
	#page = 10;
	#follow = true;
	#error = "";
	#active = false;
	#epoch = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#polling = false;

	#pollMs: number;

	constructor(jobs: JobsClient, jobId: string, panel: PickerPanel, changed: () => void, pollMs: number = POLL_MS) {
		this.#pollMs = pollMs;
		this.#jobs = jobs;
		this.jobId = jobId;
		this.#panel = panel;
		this.#changed = changed;
	}

	get #job(): WireJobSummary | undefined {
		return this.#jobs.list().find((job) => job.jobId === this.jobId);
	}

	get help(): string {
		const running = this.#job?.status === "running";
		return shortcutHints(
			["←", t("action.back")],
			["↑↓/Wheel", t("action.scroll")],
			...(this.#follow ? [] : [["End", t("action.bottom")] as const]),
			...(running ? [["S", t("action.stop")] as const] : []),
		);
	}

	open(): this {
		if (this.#active) return this;
		this.#active = true;
		this.#epoch++;
		void this.#poll();
		return this;
	}

	close(): void {
		this.#active = false;
		this.#epoch++;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	async #poll(): Promise<void> {
		if (!this.#active || this.#polling) return;
		this.#polling = true;
		const epoch = this.#epoch;
		const wasRunning = this.#job?.status === "running";
		try {
			const read = await this.#jobs.output(this.jobId, this.#tail.offset);
			if (epoch !== this.#epoch) return;
			this.#error = "";
			this.#tail.apply(read, sanitizeOutput);
			this.#schedule(wasRunning);
		} catch (error) {
			if (epoch !== this.#epoch) return;
			this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			this.#polling = false;
			if (epoch === this.#epoch) this.#changed();
		}
	}

	#schedule(keepGoing: boolean): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#active || !keepGoing) return;
		this.#timer = setTimeout(() => void this.#poll(), this.#pollMs);
	}

	scroll(delta: number): void {
		this.#scroll = Math.max(0, Math.min(this.#maxScroll, this.#scroll + delta));
		this.#follow = delta > 0 && this.#scroll === this.#maxScroll;
	}

	handleKey(data: string): boolean {
		if (matchesKey(data, "left")) this.#panel.popDetail();
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.#page);
		else if (matchesKey(data, "pageDown")) this.scroll(this.#page);
		else if (matchesKey(data, "end")) {
			this.#follow = true;
			this.#scroll = this.#maxScroll;
		} else if (data.toLowerCase() === "s" && this.#job?.status === "running")
			confirmStop(
				this.#panel,
				this.#jobs,
				this.jobId,
				(message) => {
					this.#error = message;
				},
				this.#changed,
			);
		else return false;
		return true;
	}

	lines(width: number, height: number): readonly string[] {
		this.#page = Math.max(1, height - 1);
		const job = this.#job;
		const rows: string[] = [];
		if (!job) {
			rows.push(theme.dim(t("jobs.unavailable")));
		} else {
			const row = summarizeJobs([job], Date.now()).rows[0]!;
			rows.push(
				theme.accent(`${job.jobId} · ${oneLine(row.label, 120)}`),
				theme.dim(`${row.statusText} · ${row.meta}`),
			);
			const command = wrapTextWithAnsi(`$ ${job.command}`, width);
			rows.push(...command.slice(0, COMMAND_LINES).map((line) => theme.dim(line)));
			if (command.length > COMMAND_LINES) rows.push(theme.dim("…"));
			rows.push(theme.dim(job.cwd), "");
		}
		if (this.#tail.dropped > 0) rows.push(theme.warning(t("jobs.dropped", { count: this.#tail.dropped })));
		const body = this.#tail.text.replace(/\n$/, "");
		if (body === "") {
			if (this.#tail.offset !== undefined && this.#error === "") rows.push(theme.dim(t("jobs.noOutput")));
		} else for (const line of body.split("\n")) rows.push(...wrapTextWithAnsi(line, width));
		if (this.#error) rows.push(theme.error(this.#error));
		this.#maxScroll = Math.max(0, rows.length - height);
		this.#scroll = this.#follow ? this.#maxScroll : Math.min(this.#scroll, this.#maxScroll);
		return rows.slice(this.#scroll, this.#scroll + height);
	}
}
