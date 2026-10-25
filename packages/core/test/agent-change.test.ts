import { expect, it } from "bun:test";
import type { Agent, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { agentChangeFor, agentSyncChange, enabledTools, onlyModeTools } from "../src/agent-change.ts";
import { CODEMODE_MODES } from "../src/codemode-mode.ts";
import { PLAN_INSTRUCTIONS } from "../src/plan-doc.ts";

const names = (list: readonly { name: string }[] | undefined) => list?.map((item) => item.name);
const tool = (name: string) => ({ name }) as ToolRegistration;
const extension = (name: string) => ({ name }) as Extension;
const fakeAgent = (input: { tools: string[]; callable?: string[]; extensions?: string[]; planning?: boolean }): Agent =>
	({
		tools: input.tools.map(tool),
		callable: (input.callable ?? input.tools).map(tool),
		extensions: (input.extensions ?? ["codemode"]).map(extension),
		deferred: [],
		sections: [],
		thinkingLevel: "high",
		...(input.planning ? { instructions: PLAN_INSTRUCTIONS } : {}),
	}) as unknown as Agent;

it("derives the agent configuration for every combination of plan mode and codemode mode", () => {
	const table = [
		{ codemode: "off", plan: "normal" },
		{ codemode: "off", plan: "plan" },
		{ codemode: "on", plan: "normal" },
		{ codemode: "on", plan: "plan" },
		{ codemode: "only", plan: "normal" },
		{ codemode: "only", plan: "plan" },
	] as const;
	for (const { codemode, plan } of table) {
		const change = agentChangeFor({ plan, codemode, role: "main" });
		const removed = names((change.tools as { remove?: ToolRegistration[] } | null)?.remove);
		expect(removed).toEqual(plan === "plan" ? ["edit", "write", "job"] : undefined);
		expect(change.instructions).toBe(plan === "plan" ? PLAN_INSTRUCTIONS : null);
		const extensions = change.extensions as { add?: Extension[]; remove?: Extension[] };
		expect(names(extensions.remove)).toEqual(codemode === "off" ? ["codemode"] : undefined);
		expect(names(extensions.add)).toEqual(codemode === "off" ? undefined : ["codemode"]);
		const modelTools = change.modelTools;
		if (codemode === "only")
			expect(names(modelTools as ToolRegistration[])).toEqual([
				"codemode",
				"todo",
				"ask_user",
				"subagent",
				...(plan === "plan" ? ["submit_plan"] : []),
			]);
		else if (plan === "plan") expect(names((modelTools as { add: ToolRegistration[] }).add)).toEqual(["submit_plan"]);
		else expect(modelTools).toBeNull();
	}
});

it("offers a subagent in only mode just the codemode tool", () => {
	for (const plan of ["normal", "plan"] as const) expect(onlyModeTools(plan, "subagent")).toEqual(["codemode"]);
	expect(
		names(agentChangeFor({ plan: "normal", codemode: "only", role: "subagent" }).modelTools as ToolRegistration[]),
	).toEqual(["codemode"]);
	expect(CODEMODE_MODES).toHaveLength(3);
});

it("changes nothing when the agent already matches, and only the mismatched aspect otherwise", () => {
	const on = { plan: "normal", codemode: "on", role: "main" } as const;
	expect(agentSyncChange(fakeAgent({ tools: ["read", "codemode"] }), on)).toBeUndefined();
	expect(agentSyncChange(fakeAgent({ tools: ["read"], extensions: [] }), on)?.extensions).toBeDefined();
	const off = { plan: "normal", codemode: "off", role: "main" } as const;
	expect(agentSyncChange(fakeAgent({ tools: ["read"], extensions: [] }), off)).toBeUndefined();
	const fix = agentSyncChange(fakeAgent({ tools: ["read", "codemode"] }), off)!;
	expect(names((fix.extensions as { remove: Extension[] }).remove)).toEqual(["codemode"]);
	expect(fix.tools).toBeUndefined();
	expect(fix.instructions).toBeUndefined();
	const only = { plan: "normal", codemode: "only", role: "main" } as const;
	expect(
		agentSyncChange(
			fakeAgent({ tools: ["codemode", "todo", "ask_user", "subagent"], callable: ["read", "codemode"] }),
			only,
		),
	).toBeUndefined();
	expect(agentSyncChange(fakeAgent({ tools: ["codemode", "bash"] }), only)).toBeDefined();
	const planOnly = { plan: "plan", codemode: "only", role: "main" } as const;
	expect(
		agentSyncChange(fakeAgent({ tools: ["codemode", "todo", "ask_user", "subagent"] }), planOnly)?.instructions,
	).toBe(PLAN_INSTRUCTIONS);
});

it("lists every enabled tool, including those that only scripts reach", () => {
	const agent = fakeAgent({ tools: ["codemode", "todo"], callable: ["read", "bash", "todo"] });
	expect(names(enabledTools(agent))).toEqual(["codemode", "todo", "read", "bash"]);
});
