import { expect, it } from "vitest";
import { type JobLike, JobTail, splitJobReport, summarizeJobs } from "../src/job-summary.ts";

const job = (jobId: string, extra: Partial<JobLike> = {}): JobLike => ({
	jobId,
	title: jobId,
	command: `run ${jobId}`,
	status: "running",
	startedAt: 1000,
	endedAt: null,
	exitCode: null,
	...extra,
});

it("orders newest started first with a stable tie-break and counts running jobs", () => {
	const { rows, running } = summarizeJobs(
		[
			job("job-1", { startedAt: 1000, status: "exited", endedAt: 2000, exitCode: 0 }),
			job("job-2", { startedAt: 3000 }),
			job("job-10", { startedAt: 3000 }),
			job("job-3", { startedAt: 2000 }),
		],
		10_000,
	);
	expect(rows.map((r) => r.job.jobId)).toEqual(["job-10", "job-2", "job-3", "job-1"]);
	expect(running).toBe(3);
});

it("shows elapsed time for running jobs and exit code or reason for ended ones", () => {
	const { rows } = summarizeJobs(
		[
			job("a", { startedAt: 9_000 }),
			job("b", { status: "exited", exitCode: 0, endedAt: 2000, startedAt: 8_000 }),
			job("c", { status: "failed", exitCode: 2, endedAt: 2000, startedAt: 7_000 }),
			job("d", { status: "failed", reason: "timeout", endedAt: 5000, startedAt: 6_000 }),
			job("e", { status: "stopped", endedAt: 65_000, startedAt: 5_000 }),
			job("f", { status: "lost", reason: "restart", endedAt: 5000, startedAt: 4_000 }),
		],
		70_000,
	);
	const meta = Object.fromEntries(rows.map((r) => [r.job.jobId, [r.statusText, r.meta, r.running]]));
	expect(meta).toEqual({
		a: ["running", "1m 1s", true],
		b: ["exited", "exit 0", false],
		c: ["failed", "exit 2", false],
		d: ["failed", "timeout", false],
		e: ["stopped", "1m 0s", false],
		f: ["lost", "restart", false],
	});
});

it("splits a report into head, command and folded output", () => {
	const text = `[Background job j1 "web" failed, exit code 1]\nCommand: npm run dev\nLast output (use the job tool's output action with jobId "j1" for more):\nboom\nline2`;
	expect(splitJobReport(text)).toEqual({
		head: `[Background job j1 "web" failed, exit code 1]`,
		command: "npm run dev",
		output: "boom\nline2",
	});
	expect(splitJobReport(`[Background job j2 "x" exited, exit code 0]\nCommand: true\nIt produced no output.`)).toEqual({
		head: `[Background job j2 "x" exited, exit code 0]`,
		command: "true",
		output: undefined,
	});
	expect(splitJobReport("plain")).toEqual({ head: "plain", command: undefined, output: undefined });
});

it("JobTail resumes by offset and counts dropped bytes", () => {
	const tail = new JobTail(10);
	expect(tail.offset).toBeUndefined();
	tail.apply({ text: "abc", offset: 103, truncated: true, dropped: 100 });
	expect([tail.text, tail.dropped, tail.offset]).toEqual(["abc", 100, 103]);
	tail.apply({ text: "def", offset: 106, truncated: false, dropped: 0 });
	expect([tail.text, tail.dropped, tail.offset]).toEqual(["abcdef", 100, 106]);
	tail.apply({ text: "x", offset: 207, truncated: true, dropped: 100 });
	expect([tail.text, tail.dropped]).toEqual(["abcdefx", 200]);
	tail.apply({ text: "ghijkl", offset: 213, truncated: false, dropped: 0 });
	expect([tail.text, tail.dropped, tail.offset]).toEqual(["defxghijkl", 203, 213]);
	tail.apply({ text: "mm", offset: 215, truncated: false, dropped: 0 }, (text) => text.toUpperCase());
	expect(tail.text.endsWith("MM")).toBe(true);
});
