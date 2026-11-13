import type { UsageState } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { subagentUsageTotals, subtractSubagentUsage } from "../src/subagent-usage.ts";

it("subtracts native model and tool buckets including optional counters and partial failures", () => {
	const usage = (n: number, cost: number) => ({
		input: n,
		output: n / 2,
		cacheRead: n * 2,
		cacheWrite: n * 3,
		cacheWrite1h: n,
		reasoning: n / 4,
		totalTokens: n * 6.5,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	});
	const start: UsageState = { models: { "model/a": usage(100, 0.03) }, tools: { bash: usage(10, 0) } };
	const end: UsageState = {
		models: { "model/a": usage(150, 0.05), "model/b": usage(20, 0.04) },
		tools: { bash: usage(15, 0) },
	};
	const delta = subtractSubagentUsage(end, start);
	expect(delta.models["model/a"]!.reasoning).toBe(12.5);
	expect(delta.models["model/a"]!.cacheWrite1h).toBe(50);
	expect(delta.tools.bash!.input).toBe(5);
	const { cost, ...counts } = subagentUsageTotals(delta);
	expect(counts).toEqual({ input: 75, output: 37.5, cacheRead: 150, cacheWrite: 225 });
	expect(cost).toBeCloseTo(0.06, 10);
	expect(start.models["model/a"]!.input).toBe(100);
});
