import type { ConversationView } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { contextTokens } from "../src/projection.ts";

function answer(id: number, totalTokens: number, stopReason = "stop") {
	return {
		id,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				stopReason,
				usage: {
					totalTokens,
					input: 100,
					output: 20,
					cacheRead: 30,
					cacheWrite: 10,
				},
			},
		],
	};
}
const entries = (items: unknown[]) => items as ConversationView["entries"];
it("measures the latest successful answer, not cumulative session usage", () => {
	expect(contextTokens(entries([]))).toBeNull();
	expect(contextTokens(entries([answer(1, 1000), answer(2, 200), answer(3, 5000, "error")]))).toBe(200);
	expect(contextTokens(entries([answer(1, 0), answer(2, 5000, "aborted")]))).toBe(160);
});
it("does not reuse retained pre-compaction usage even if it follows the summary in display order", () => {
	const compact = { id: 10, kind: "pi.compaction" };
	expect(contextTokens(entries([compact, answer(2, 8000)]))).toBeNull();
	expect(contextTokens(entries([compact, answer(2, 8000), answer(11, 700)]))).toBe(700);
});
