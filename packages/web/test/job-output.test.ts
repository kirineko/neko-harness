import { JobTail } from "@neko-harness/core/job-summary";
import { expect, it } from "vitest";
import { atBottom, jobStatusText, sanitizeJobOutput } from "../src/client/lib/job-output.ts";

const base = {
	jobId: "j1",
	title: "web",
	command: "npm run dev",
	startedAt: 1000,
	endedAt: null,
	exitCode: null,
} as const;

it("maps statuses to Chinese labels with elapsed time, exit code or reason", () => {
	expect(jobStatusText({ ...base, status: "running" }, 66_000)).toBe("运行中 · 1m 5s");
	expect(jobStatusText({ ...base, status: "exited", exitCode: 0, endedAt: 2000 }, 9000)).toBe("已退出 · 退出码 0");
	expect(jobStatusText({ ...base, status: "failed", exitCode: 2, endedAt: 2000 }, 9000)).toBe("失败 · 退出码 2");
	expect(jobStatusText({ ...base, status: "failed", reason: "timeout", endedAt: 2000 }, 9000)).toBe("失败 · 超时");
	expect(jobStatusText({ ...base, status: "failed", reason: "spawn-error", endedAt: 2000 }, 9000)).toBe(
		"失败 · 无法启动",
	);
	expect(jobStatusText({ ...base, status: "stopped", endedAt: 6000 }, 9000)).toBe("已停止 · 5s");
	expect(jobStatusText({ ...base, status: "lost", reason: "restart", endedAt: 2000 }, 9000)).toBe("已丢失 · 网关重启");
});

it("strips terminal escapes and control characters from output", () => {
	expect(sanitizeJobOutput("\u001b[31mred\u001b[0m ok\r\nnext\rlast\u0007\u0000")).toBe("red ok\nnext\nlast");
	expect(sanitizeJobOutput("\u001b]0;title\u0007body\ttab")).toBe("body\ttab");
	expect(sanitizeJobOutput("\u001b[2K\u001b[1Gprogress")).toBe("progress");
});

it("keeps following only near the bottom", () => {
	expect(atBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
	expect(atBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
	expect(atBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
});

it("resumes polling from the offset and shows the truncation count once", () => {
	const tail = new JobTail();
	tail.apply({ text: "tail", offset: 5000, truncated: true, dropped: 4996 }, sanitizeJobOutput);
	tail.apply({ text: "\u001b[1m+more\u001b[0m", offset: 5006, truncated: false, dropped: 0 }, sanitizeJobOutput);
	expect([tail.text, tail.offset, tail.dropped]).toEqual(["tail+more", 5006, 4996]);
});
