import type { Agent, AgentChange, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { CODEMODE_NAME, type CodemodeMode } from "./codemode-mode.ts";
import type { PlanMode } from "./interactions.ts";
import { PLAN_INSTRUCTIONS, PLAN_REMOVED_TOOLS } from "./plan-doc.ts";

export type AgentRole = "main" | "subagent";

export type AgentState = { plan: PlanMode; codemode: CodemodeMode; role: AgentRole };

/** Tools the model keeps seeing directly in `only` mode on a main agent; everything else is reached through scripts. */
const ONLY_MODE_MAIN_TOOLS = ["todo", "ask_user", "subagent"] as const;

/** Tools are matched by name, so a name-only registration is enough and the change stays idempotent. */
const named = (name: string) => ({ name }) as ToolRegistration;

/** Names the model is offered in `only` mode. */
export function onlyModeTools(plan: PlanMode, role: AgentRole): string[] {
	return [
		CODEMODE_NAME,
		...(role === "main" ? [...ONLY_MODE_MAIN_TOOLS, ...(plan === "plan" ? ["submit_plan"] : [])] : []),
	];
}

/**
 * The agent configuration that realizes the two per-session records (plan mode and codemode mode). Off removes the
 * `codemode` extension, which takes its tool and prompt section with it.
 */
export function agentChangeFor({ plan, codemode, role }: AgentState): AgentChange {
	const planning = plan === "plan";
	return {
		tools: planning ? { remove: PLAN_REMOVED_TOOLS.map(named) } : null,
		modelTools:
			codemode === "only" ? onlyModeTools(plan, role).map(named) : planning ? { add: [named("submit_plan")] } : null,
		extensions:
			codemode === "off"
				? { remove: [{ name: CODEMODE_NAME } as Extension] }
				: { add: [{ name: CODEMODE_NAME } as Extension] },
		instructions: planning ? PLAN_INSTRUCTIONS : null,
	};
}

/**
 * Every tool the session has enabled and that something can call: the offered tools plus those only scripts reach.
 * Code that rebuilds a tool list from a resolved agent must start from this, not from `agent.tools`, which `only`
 * mode narrows to a few tools.
 */
export function enabledTools(agent: Pick<Agent, "tools" | "callable">): ToolRegistration[] {
	const offered = new Set(agent.tools.map((tool) => tool.name));
	return [...agent.tools, ...agent.callable.filter((tool) => !offered.has(tool.name))];
}

/** Whether a resolved agent is configured for plan mode (the instructions are the marker). */
export const agentInPlanMode = (agent: { instructions?: string | undefined }): boolean =>
	agent.instructions === PLAN_INSTRUCTIONS;

/**
 * The smallest idempotent change that brings a resolved agent in line with the records, or `undefined` when it
 * already matches. Aspects that already match are left alone, so an explicit configuration of the session survives.
 */
export function agentSyncChange(agent: Agent, state: AgentState): AgentChange | undefined {
	const desired = agentChangeFor(state);
	const planMismatch = agentInPlanMode(agent) !== (state.plan === "plan");
	const hasExtension = agent.extensions.some((extension) => extension.name === CODEMODE_NAME);
	const callable = new Set(agent.callable.map((tool) => tool.name));
	const offered = agent.tools.map((tool) => tool.name);
	let codemodeMismatch: boolean;
	if (state.codemode === "off") codemodeMismatch = hasExtension || callable.has(CODEMODE_NAME);
	else {
		codemodeMismatch = !hasExtension || !offered.includes(CODEMODE_NAME);
		if (state.codemode === "only") {
			const allowed = new Set(onlyModeTools(state.plan, state.role));
			codemodeMismatch ||= offered.some((name) => !allowed.has(name));
		}
	}
	if (!planMismatch && !codemodeMismatch) return undefined;
	return {
		...(planMismatch ? { tools: desired.tools, instructions: desired.instructions } : {}),
		modelTools: desired.modelTools,
		...(codemodeMismatch ? { extensions: desired.extensions } : {}),
	};
}
