import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { configure } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync, rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/index.ts";
import { listDelegations } from "../src/subagents.ts";
import { createTodoExtension } from "../src/todos.ts";
import { createQuestionExtension } from "../src/user-questions.ts";

const model = { provider: "faux", modelId: "faux-1" };
const dirs: string[] = [];
const directory = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-interaction-tools-")));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});
const toolNames = async (runtime: NekoRuntime, id: number) =>
	(await (await runtime.harness.conversation(id as never, runtime.context))!.agent(runtime.context)).tools.map(
		(t) => t.name,
	);

it("keeps todo and ask_user away from explore, plan and coder subagents and from nested use", async () => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			(["explore", "plan", "coder"] as const).map((type) =>
				fauxToolCall("subagent", { type, title: type, task: `do ${type}` }),
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("ask_user", { question: "child asks?" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("todo", { action: "list" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("ask_user", { question: "coder asks?" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("report one"),
		fauxAssistantMessage("report two"),
		fauxAssistantMessage("report three"),
		fauxAssistantMessage("main done"),
	]);
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		await runtime.waitAnswer(await runtime.submit("delegate"));
		const rounds = await listDelegations(runtime.harness, runtime.conversation.id, runtime.context);
		expect(rounds.map((r) => r.role).sort()).toEqual(["coder", "explore", "plan"]);
		for (const round of rounds) {
			const names = await toolNames(runtime, round.childId);
			expect(names).not.toContain("todo");
			expect(names).not.toContain("ask_user");
		}
		expect(await runtime.root.questions()).toEqual({ revision: 0, pending: [] });
		expect(await runtime.root.todos()).toEqual({ revision: 0, items: [] });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("removes main-only tools from a subagent that has them, on reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-interaction-repair-"));
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "coder", title: "Work", task: "Work" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("child"),
		fauxAssistantMessage("main"),
	]);
	const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], model };
	let runtime = await createNekoRuntime(options);
	try {
		await runtime.waitAnswer(await runtime.submit("delegate"));
		const [round] = await listDelegations(runtime.harness, runtime.conversation.id, runtime.context);
		const rootTools = (await runtime.conversation.agent(runtime.context)).tools;
		const mainOnly = rootTools.filter((t) => t.name === "todo" || t.name === "ask_user");
		expect(mainOnly).toHaveLength(2);
		const child = (await runtime.harness.conversation(round!.childId as never, runtime.context))!;
		const childTools = (await child.agent(runtime.context)).tools;
		await runtime.harness.commit(
			(tx) =>
				configure(tx, round!.childId as never, {
					tools: [...childTools, ...mainOnly],
					extensions: { add: [createTodoExtension(), createQuestionExtension(() => runtime.questions)] },
				}),
			runtime.context,
		);
		expect(await toolNames(runtime, round!.childId)).toContain("todo");
		await runtime.close();
		runtime = await createNekoRuntime(options);
		const names = await toolNames(runtime, round!.childId);
		expect(names).not.toContain("todo");
		expect(names).not.toContain("ask_user");
		expect(names).toContain("bash");
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

it("respects a main session that explicitly disabled the tools", async () => {
	const faux = fauxProvider();
	const contexts: TranscriptContext[] = [];
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("todo", { action: "list" })], { stopReason: "toolUse" });
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage("fine");
		},
	]);
	const runtime = await createNekoRuntime({ storage: "memory", providers: [faux.provider], model });
	try {
		const tools = (await runtime.conversation.agent(runtime.context)).tools;
		await runtime.harness.commit(
			(tx) =>
				configure(tx, runtime.conversation.id, {
					tools: tools.filter((t) => t.name !== "todo" && t.name !== "ask_user"),
				}),
			runtime.context,
		);
		await runtime.waitAnswer(await runtime.submit("go"));
		const rules = getCurrentSystemMessage(contexts[0]!.messages)?.sections?.rules ?? "";
		expect(rules).not.toContain("ask_user");
		expect(rules).not.toContain("Use todo for multi-step work");
		const page = await runtime.conversation.entries({ order: "ascending" }, 100, undefined, runtime.context);
		const result = page.items.flatMap((e) => e.model ?? []).find((m) => m.role === "toolResult");
		expect(result).toMatchObject({ isError: true });
		expect(await runtime.root.todos()).toEqual({ revision: 0, items: [] });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("keeps the active resource snapshot while a question is pending and refreshes it on the next input", async () => {
	const home = directory();
	const workspace = directory();
	const agents = join(workspace, "AGENTS.md");
	writeFileSync(agents, "project rules v1");
	const contexts: TranscriptContext[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("ask_user", { question: "Which?" })], { stopReason: "toolUse" });
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage("answered flow");
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage("next input");
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model,
		cwd: workspace,
		promptHome: home,
	});
	try {
		const first = await runtime.submit("ask me");
		let pending: { id: number; version: string } | undefined;
		for (let i = 0; i < 500 && !pending; i++) {
			pending = (await runtime.root.questions()).pending[0];
			if (!pending) await sleep(10);
		}
		writeFileSync(agents, "project rules v2");
		await runtime.root.respondQuestion(pending!.id, pending!.version, { kind: "answer", text: "anything" });
		expect((await runtime.waitAnswer(first)).status).toBe("done");
		const initial = getCurrentSystemMessage(contexts[0]!.messages)!;
		const continued = getCurrentSystemMessage(contexts[1]!.messages)!;
		expect(initial.sections?.project_context).toContain("project rules v1");
		expect(continued.sections).toEqual(initial.sections);
		await runtime.waitAnswer(await runtime.submit("new input"));
		const next = getCurrentSystemMessage(contexts[2]!.messages)!.sections!;
		expect(next.project_context).toContain("project rules v2");
	} finally {
		await runtime.close();
	}
}, 30_000);
