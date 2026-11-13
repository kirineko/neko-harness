import { expect, it } from "vitest";
import { silenceSqliteWarning } from "../src/runtime-warnings.ts";

it("drops only the experimental SQLite warning and forwards every other warning unchanged", () => {
	const seen: unknown[][] = [];
	const target = { emitWarning: (...args: unknown[]) => void seen.push(args) };
	silenceSqliteWarning(target);
	const sqlite = "SQLite is an experimental feature and might change at any time";
	target.emitWarning(sqlite, "ExperimentalWarning");
	target.emitWarning(sqlite, { type: "ExperimentalWarning" });
	target.emitWarning(Object.assign(new Error(sqlite), { name: "ExperimentalWarning" }));
	expect(seen).toEqual([]);

	const other = new Error("boom");
	target.emitWarning("Fetch is an experimental feature", "ExperimentalWarning");
	target.emitWarning("SQLite is deprecated", "DeprecationWarning", "DEP0000");
	target.emitWarning(other);
	expect(seen).toEqual([
		["Fetch is an experimental feature", "ExperimentalWarning"],
		["SQLite is deprecated", "DeprecationWarning", "DEP0000"],
		[other],
	]);
});
