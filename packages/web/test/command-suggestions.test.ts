import { expect, it } from "bun:test";
import { commandSuggestions, isCommandQuery } from "../src/client/lib/command-suggestions.ts";

const skills = [
	{ name: "alpha", description: "First", location: "/a/SKILL.md", level: "user" as const },
	{ name: "beta", description: "Second", location: "/b/SKILL.md", level: "project" as const },
	{ name: "plugin:task", description: "Namespaced", location: "/c/SKILL.md", level: "builtin" as const },
];
it("discovers skills before the colon and filters command prefixes", () => {
	expect(commandSuggestions("/", skills).map((s) => s.label)).toEqual([
		"/compact",
		"/skill:alpha",
		"/skill:beta",
		"/skill:plugin:task",
	]);
	for (const text of ["/s", "/skill", "/skill:"]) expect(commandSuggestions(text, skills)).toHaveLength(3);
	expect(commandSuggestions("/skill:b", skills).map((s) => s.label)).toEqual(["/skill:beta"]);
	expect(commandSuggestions("/co", skills).map((s) => s.label)).toEqual(["/compact"]);
	expect(commandSuggestions("/unknown", skills)).toEqual([]);
	expect(commandSuggestions("/skill:", [])).toEqual([]);
});
it("lists /plan only when the gateway supports plan mode", () => {
	expect(commandSuggestions("/", skills).map((s) => s.label)).not.toContain("/plan");
	expect(commandSuggestions("/pl", skills, { plan: false })).toEqual([]);
	const withPlan = commandSuggestions("/", skills, { plan: true }).map((s) => s.label);
	expect(withPlan).toEqual(["/compact", "/plan", "/skill:alpha", "/skill:beta", "/skill:plugin:task"]);
	expect(commandSuggestions("/pl", skills, { plan: true }).map((s) => s.label)).toEqual(["/plan"]);
	expect(commandSuggestions("/plan", [], { plan: true })[0]?.description).toBeTruthy();
});
it("allows discoverable skill names and stops completion at arguments", () => {
	expect(isCommandQuery("/skill:plugin:task")).toBe(true);
	expect(isCommandQuery("/skill:alpha args")).toBe(false);
	expect(isCommandQuery("/skill:alpha\nargs")).toBe(false);
	expect(isCommandQuery("email@example.com")).toBe(false);
});
it("marks builtin skills with a badge and leaves other levels unmarked", () => {
	const byLabel = new Map(commandSuggestions("/", skills).map((s) => [s.label, s]));
	expect(byLabel.get("/skill:plugin:task")?.badge).toBe("内置");
	expect(byLabel.get("/skill:alpha")).not.toHaveProperty("badge");
	expect(byLabel.get("/skill:beta")).not.toHaveProperty("badge");
	expect(byLabel.get("/compact")).not.toHaveProperty("badge");
});
