import { expect, it } from "vitest";
import { byteLength, JOB_LIMITS, OutputBuffer, tailOf } from "../src/jobs.ts";

it("keeps appended output within the byte and line caps and reports truncation", () => {
	const buffer = new OutputBuffer();
	const line = `${"x".repeat(99)}\n`;
	for (let i = 0; i < 5000; i++) buffer.append(line);
	const tail = buffer.tail();
	expect(byteLength(tail)).toBeLessThanOrEqual(JOB_LIMITS.tailBytes);
	expect(tail.split("\n").length - 1).toBeLessThanOrEqual(JOB_LIMITS.tailLines);
	expect(buffer.totalBytes).toBe(5000 * 100);
	const read = buffer.read();
	expect(read.truncated).toBe(true);
	expect(read.dropped).toBe(buffer.totalBytes - byteLength(read.text));
	expect(read.offset).toBe(buffer.totalBytes);
});

it("resumes from an offset without gaps or repeats", () => {
	const buffer = new OutputBuffer();
	buffer.append("one\ntwo\n");
	const first = buffer.read();
	expect(first).toEqual({ text: "one\ntwo\n", offset: 8, truncated: false, dropped: 0 });
	expect(buffer.read(first.offset).text).toBe("");
	buffer.append("three\n");
	expect(buffer.read(first.offset)).toEqual({ text: "three\n", offset: 14, truncated: false, dropped: 0 });
	expect(buffer.read(100).text).toBe("");
});

it("marks a resume point that fell off the tail as truncated", () => {
	const buffer = new OutputBuffer(100, 1000);
	buffer.append("a".repeat(50));
	const seen = buffer.read().offset;
	buffer.append("b".repeat(500));
	const read = buffer.read(seen);
	expect(read.truncated).toBe(true);
	expect(read.dropped).toBeGreaterThan(0);
	expect(byteLength(read.text)).toBeLessThanOrEqual(100);
	expect(read.offset).toBe(550);
});

it("never splits a multibyte character when trimming or resuming", () => {
	const buffer = new OutputBuffer(10, 1000);
	buffer.append("你好世界你好世界");
	const read = buffer.read();
	expect(read.text).not.toContain("\uFFFD");
	expect(byteLength(read.text)).toBeLessThanOrEqual(10);
	expect(buffer.read(1).text).not.toContain("\uFFFD");
	expect(tailOf("日本語", 4, 10)).toBe("語");
});

it("reads a persisted final tail with the original offsets", () => {
	const buffer = OutputBuffer.fromTail("tail\n", 1000);
	expect(buffer.read()).toEqual({ text: "tail\n", offset: 1000, truncated: true, dropped: 995 });
	expect(buffer.read(996)).toEqual({ text: "ail\n", offset: 1000, truncated: false, dropped: 0 });
	expect(buffer.read(10)).toEqual({ text: "tail\n", offset: 1000, truncated: true, dropped: 985 });
});
