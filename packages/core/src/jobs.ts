import { defineDoc } from "@earendil-works/pi-durable";

export const JOB_LIMITS = {
	/** Running jobs per session. */
	maxRunning: 4,
	/** Terminal jobs kept in the list; older ones are pruned. */
	keepTerminal: 20,
	/** `start` waits this long for an early exit before returning. */
	startWindowMs: 2000,
	/** Retained output tail, in memory and in the final persisted record. */
	tailBytes: 64 * 1024,
	tailLines: 1000,
	/** Output tail included in the completion report. */
	reportBytes: 4 * 1024,
	reportLines: 40,
	/** One `output` read, for tools and frontends. */
	readBytes: 64 * 1024,
	titleChars: 200,
	commandBytes: 32 * 1024,
	/** The longest timeout a job may request. */
	maxTimeoutSeconds: 7 * 24 * 3600,
} as const;

export type JobStatus = "running" | "exited" | "failed" | "stopped" | "lost";
export type JobReason = "timeout" | "spawn-error" | "restart" | "aborted";
/** Who asked for the stop; decides whether the session is told. Only `user` is reported. */
export type JobStopOrigin = "model" | "user" | "archive";

export type JobRecord = {
	jobId: string;
	title: string;
	command: string;
	cwd: string;
	status: JobStatus;
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	reason?: JobReason;
	timeoutSeconds?: number;
	stopOrigin?: JobStopOrigin;
	runnerId: number;
	/** The final output tail, kept when the job reaches a terminal state. */
	tail?: string;
	/** Cumulative UTF-8 bytes the job ever wrote; `tail` ends at this offset. */
	totalBytes?: number;
	reporterId?: number;
};
export type JobsState = { next: number; items: JobRecord[] };

/** Session-level job list; forks start empty, as a process does not belong to a copy of the transcript. */
export const JobsDoc = defineDoc<JobsState>({
	kind: "app.neko.jobs",
	checkpointWhen: () => false,
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ next: 1, items: [] }),
});

/** What frontends see in lists: no output body and no internal task ids. */
export type JobSummary = Omit<JobRecord, "tail" | "totalBytes" | "runnerId" | "reporterId" | "stopOrigin"> & {
	/** Cumulative output bytes known so far; running jobs report it as of the last read. */
	outputBytes: number;
};

export const summarizeJobRecord = (job: JobRecord, outputBytes = job.totalBytes ?? 0): JobSummary => {
	const {
		tail: _tail,
		totalBytes: _total,
		runnerId: _runner,
		reporterId: _reporter,
		stopOrigin: _origin,
		...rest
	} = job;
	return { ...rest, outputBytes };
};

export const isTerminalJob = (status: JobStatus) => status !== "running";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const byteLength = (text: string) => encoder.encode(text).length;

/** Cut `text` to its last `maxBytes` bytes without splitting a character, and to its last `maxLines` lines. */
export function tailOf(text: string, maxBytes: number, maxLines: number): string {
	let bytes = encoder.encode(text);
	if (bytes.length > maxBytes) {
		let start = bytes.length - maxBytes;
		while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
		bytes = bytes.subarray(start);
		text = decoder.decode(bytes);
	}
	let index = text.length;
	let seen = 0;
	// A trailing newline ends the last line; it does not start another one.
	if (text.endsWith("\n")) index--;
	while (index > 0) {
		const found = text.lastIndexOf("\n", index - 1);
		if (found < 0) break;
		if (++seen >= maxLines) return text.slice(found + 1);
		index = found;
	}
	return text;
}

export type JobOutputRead = {
	text: string;
	/** Pass this as `since` next time. */
	offset: number;
	/** Earlier output in range was dropped; `dropped` bytes were skipped before `text`. */
	truncated: boolean;
	dropped: number;
};

/** Output tail of one job with cumulative byte offsets, so readers resume without gaps or repeats. */
export class OutputBuffer {
	#chunks: string[] = [];
	#bytes = 0;
	#total = 0;
	readonly #maxBytes: number;
	readonly #maxLines: number;

	constructor(maxBytes: number = JOB_LIMITS.tailBytes, maxLines: number = JOB_LIMITS.tailLines) {
		this.#maxBytes = maxBytes;
		this.#maxLines = maxLines;
	}

	static fromTail(tail: string, totalBytes: number): OutputBuffer {
		const buffer = new OutputBuffer();
		buffer.#chunks = [tail];
		buffer.#bytes = byteLength(tail);
		buffer.#total = totalBytes;
		return buffer;
	}

	get totalBytes() {
		return this.#total;
	}

	append(text: string) {
		if (!text) return;
		const size = byteLength(text);
		this.#total += size;
		this.#bytes += size;
		this.#chunks.push(text);
		// Trimming is lazy so a chatty process does not recopy the tail per chunk; reads always trim first.
		if (this.#bytes > this.#maxBytes * 2) this.#trim();
	}

	#trim() {
		const text = tailOf(this.#chunks.join(""), this.#maxBytes, this.#maxLines);
		this.#chunks = [text];
		this.#bytes = byteLength(text);
		return text;
	}

	/** The retained tail. */
	tail(): string {
		return this.#trim();
	}

	read(since?: number, maxBytes: number = JOB_LIMITS.readBytes): JobOutputRead {
		const tail = this.#trim();
		const start = this.#total - this.#bytes;
		const all = encoder.encode(tail);
		let begin = since === undefined ? start : Math.min(Math.max(since, start), this.#total);
		let bytes = all.subarray(begin - start);
		// Over the per-read cap, or a resume point inside a character: keep the newest whole characters.
		let cut = Math.max(0, bytes.length - maxBytes);
		while (cut < bytes.length && (bytes[cut]! & 0xc0) === 0x80) cut++;
		begin += cut;
		bytes = bytes.subarray(cut);
		const dropped = Math.max(0, begin - (since ?? 0));
		return { text: decoder.decode(bytes), offset: this.#total, truncated: dropped > 0, dropped };
	}
}

/** The lines of a report-sized tail. */
export const reportTail = (text: string) => tailOf(text, JOB_LIMITS.reportBytes, JOB_LIMITS.reportLines);
