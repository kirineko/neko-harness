import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { CodemodeDoc } from "../src/codemode.ts";
import type { CodemodeMode } from "../src/codemode-mode.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";
import { listDelegations } from "../src/subagents.ts";
import type { ToolApproval } from "../src/tool-approvals.ts";

const model = { provider: "faux", modelId: "faux-1" };
const dirs: string[] = [];
const directory = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-codemode-")));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

const open = (
	faux: ReturnType<typeof fauxProvider>,
	mode: CodemodeMode | undefined,
	extra: Record<string, unknown> = {},
) =>
	createNekoRuntime({
		storage: "memory",
		providers: [faux.provider],
		model,
		cwd: directory(),
		...(mode ? { codemodeSettings: { mode } } : {}),
		...extra,
	});
const toolNames = async (runtime: NekoRuntime, id?: number) => {
	const target =
		id === undefined ? runtime.conversation : (await runtime.harness.conversation(id as never, runtime.context))!;
	return (await target.agent(runtime.context)).tools.map((t) => t.name);
};
const extensionNames = async (runtime: NekoRuntime) =>
	(await runtime.conversation.agent(runtime.context)).extensions.map((e) => e.name);
type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const toolResults = async (runtime: NekoRuntime) =>
	(await runtime.conversation.entries({ order: "ascending" }, 500, undefined, runtime.context)).items
		.flatMap((entry) => entry.model ?? [])
		.flatMap((m) => (m.role === "toolResult" ? [m] : []));
const resultText = (m: { content: { type: string; text?: string }[] }) => m.content.map((c) => c.text ?? "").join("");

it("is off by default: no codemode tool or extension", async () => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hi")]);
	const runtime = await open(faux, undefined);
	try {
		await runtime.waitAnswer(await runtime.submit("hello"));
		expect(await toolNames(runtime)).not.toContain("codemode");
		expect(await extensionNames(runtime)).not.toContain("codemode");
		expect(await runtime.codemodeSettings()).toEqual({ effective: { mode: "off" }, source: "default" });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("runs a script that reads a file in on mode and hands back only its output", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "on");
	const cwd = (await runtime.conversation.agent(runtime.context)).cwd!;
	writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\n");
	faux.setResponses([
		call("codemode", {
			code: `const text = await tools.read({ path: ${JSON.stringify(join(cwd, "a.txt"))} });\nreturn "chars=" + text.length;`,
		}),
		fauxAssistantMessage("done"),
	]);
	try {
		const names = await toolNames(runtime);
		expect(names).toContain("codemode");
		expect(names).toContain("bash");
		await runtime.waitAnswer(await runtime.submit("count"));
		const [result] = await toolResults(runtime);
		expect(result!.isError).toBe(false);
		expect(resultText(result as never)).toContain("chars=");
		expect(resultText(result as never)).not.toContain("three");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("in only mode offers codemode and main-only tools; other tools are reachable from scripts only", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "only");
	const cwd = (await runtime.conversation.agent(runtime.context)).cwd!;
	faux.setResponses([
		call("bash", { command: "echo direct" }),
		call("codemode", { code: `const out = await tools.bash({ command: "echo scripted" });\nreturn out.output;` }),
		fauxAssistantMessage("done"),
	]);
	try {
		expect(await toolNames(runtime)).toEqual(["codemode", "todo", "ask_user", "subagent"]);
		const agent = await runtime.conversation.agent(runtime.context);
		expect(agent.callable.map((t) => t.name)).toEqual(expect.arrayContaining(["bash", "read", "edit", "write"]));
		expect(agent.callable.map((t) => t.name)).not.toContain("subagent");
		expect(agent.callable.map((t) => t.name)).not.toContain("codemode");
		expect(agent.callable.map((t) => t.name)).not.toContain("todo");
		await runtime.waitAnswer(await runtime.submit("go"));
		const [direct, scripted] = await toolResults(runtime);
		expect(direct!.isError).toBe(true);
		expect(scripted!.isError).toBe(false);
		expect(resultText(scripted as never)).toContain("scripted");
		expect(cwd).toBeTruthy();
	} finally {
		await runtime.close();
	}
}, 30_000);

it("does not let scripts start subagents or ask the user", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "on");
	faux.setResponses([
		call("codemode", {
			code: [
				`const failures = [];`,
				`for (const name of ["subagent", "ask_user", "todo", "codemode"]) {`,
				`  try { await tools[name]({}); failures.push(name + ":called"); } catch (error) { failures.push(name + ":missing"); }`,
				`}`,
				`return failures.join(",");`,
			].join("\n"),
		}),
		fauxAssistantMessage("done"),
	]);
	try {
		await runtime.waitAnswer(await runtime.submit("go"));
		const [result] = await toolResults(runtime);
		expect(resultText(result as never)).toContain("subagent:missing,ask_user:missing,todo:missing,codemode:missing");
		expect(await runtime.root.questions()).toEqual({ revision: 0, pending: [] });
	} finally {
		await runtime.close();
	}
}, 30_000);

const modeOf = async (runtime: NekoRuntime, id: number) =>
	(await runtime.harness.snapshot(CodemodeDoc, id as never, runtime.context))?.mode;
const sessionTools = async (runtime: NekoRuntime, id: number) => toolNames(runtime, id);

it("resolves saved > config > off, validates, and survives a reopen", async () => {
	const dir = directory();
	const faux = fauxProvider();
	const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], model, cwd: dir };
	let runtime = await createNekoRuntime({ ...options, codemodeSettings: { mode: "on" } });
	try {
		expect(await runtime.codemodeSettings()).toEqual({ effective: { mode: "on" }, source: "config" });
		expect(await runtime.setCodemodeMode("only")).toEqual({ effective: { mode: "only" }, source: "saved" });
		await expect(runtime.setCodemodeMode("auto" as never)).rejects.toThrow(/off, on, only/);
		expect((await runtime.codemodeSettings()).effective.mode).toBe("only");
		await runtime.close();
		runtime = await createNekoRuntime({ ...options, codemodeSettings: { mode: "on" } });
		expect(await runtime.codemodeSettings()).toEqual({ effective: { mode: "only" }, source: "saved" });
		expect(await runtime.resetCodemodeMode()).toEqual({ effective: { mode: "on" }, source: "config" });
		expect(await runtime.setCodemodeMode("off")).toEqual({ effective: { mode: "off" }, source: "saved" });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("fixes the mode at creation: later changes leave sessions alone, forks inherit, restarts keep it", async () => {
	const dir = directory();
	const faux = fauxProvider();
	const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], model, cwd: dir };
	let runtime = await createNekoRuntime(options);
	try {
		const first = runtime.root.id;
		expect(await modeOf(runtime, first)).toBe("off");
		await runtime.setCodemodeMode("on");
		const second = await runtime.createConversation();
		await runtime.setCodemodeMode("only");
		const third = await runtime.createConversation();
		const fork = await runtime.forkConversation(second.id);
		await runtime.setCodemodeMode("off");
		const check = async () => {
			expect(await modeOf(runtime, first)).toBe("off");
			expect(await modeOf(runtime, second.id)).toBe("on");
			expect(await modeOf(runtime, third.id)).toBe("only");
			expect(await modeOf(runtime, fork.id)).toBe("on");
			expect(await sessionTools(runtime, first)).not.toContain("codemode");
			expect(await sessionTools(runtime, second.id)).toContain("codemode");
			expect(await sessionTools(runtime, second.id)).toContain("bash");
			expect(await sessionTools(runtime, third.id)).toEqual(["codemode", "todo", "ask_user", "subagent"]);
		};
		await check();
		await runtime.close();
		runtime = await createNekoRuntime(options);
		await check();
		// A fork gets its tools reconciled before its first input.
		faux.setResponses([fauxAssistantMessage("hi")]);
		await runtime.waitAnswer(await (await runtime.getConversation(fork.id))!.submit("hello"));
		expect(await sessionTools(runtime, fork.id)).toContain("codemode");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("treats a session without a mode record as off, even though the extension is selected by default", async () => {
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hi")]);
	const runtime = await open(faux, "only");
	try {
		const legacy = await runtime.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model, cwd: (await runtime.conversation.agent(runtime.context)).cwd! },
			},
			runtime.context,
		);
		const before = await legacy.agent(runtime.context);
		// New extensions apply to every session that does not name its extensions.
		expect(before.extensions.map((e) => e.name)).toContain("codemode");
		expect(before.tools.map((t) => t.name)).toContain("codemode");
		expect(await modeOf(runtime, legacy.id)).toBeUndefined();
		const session = await runtime.getConversation(legacy.id);
		expect(session).toBeDefined();
		await runtime.waitAnswer(await session!.submit("hello"));
		const after = await legacy.agent(runtime.context);
		expect(after.extensions.map((e) => e.name)).not.toContain("codemode");
		expect(after.tools.map((t) => t.name)).not.toContain("codemode");
		expect(after.tools.map((t) => t.name)).toContain("bash");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("repairs the configuration on restart when the record was written but the configuration was not applied", async () => {
	const dir = directory();
	const faux = fauxProvider();
	const options = { storagePath: join(dir, "state.sqlite"), providers: [faux.provider], model, cwd: dir };
	let runtime = await createNekoRuntime(options);
	try {
		const created = await runtime.createConversation();
		expect(await sessionTools(runtime, created.id)).not.toContain("codemode");
		await runtime.harness.commit(async (tx) => {
			(await tx.doc(CodemodeDoc, created.id)).mode = "only";
		}, runtime.context);
		await runtime.close();
		runtime = await createNekoRuntime(options);
		expect(await sessionTools(runtime, created.id)).toEqual(["codemode", "todo", "ask_user", "subagent"]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("keeps both records in effect when an only-mode session enters and leaves plan mode", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "only");
	try {
		const normal = ["codemode", "todo", "ask_user", "subagent"];
		expect(await toolNames(runtime)).toEqual(normal);
		await runtime.root.setPlanMode("plan");
		expect(await toolNames(runtime)).toEqual([...normal, "submit_plan"]);
		await runtime.root.setPlanMode("normal");
		expect(await toolNames(runtime)).toEqual(normal);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("keeps codemode when an on-mode session leaves plan mode, and a plan-mode script cannot write", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "on");
	const cwd = (await runtime.conversation.agent(runtime.context)).cwd!;
	const target = join(cwd, "guarded.txt");
	writeFileSync(target, "original");
	faux.setResponses([
		call("codemode", {
			code: [
				`const outcomes = [];`,
				`try { await tools.edit({ path: ${JSON.stringify(target)}, edits: [{ oldText: "original", newText: "changed" }] }); outcomes.push("edit:ran"); } catch (error) { outcomes.push("edit:rejected"); }`,
				`try { await tools.bash({ command: "rm -rf build && echo hi > guarded.txt" }); outcomes.push("bash:ran"); } catch (error) { outcomes.push("bash:rejected"); }`,
				`const ok = await tools.bash({ command: "echo safe" });`,
				`outcomes.push("safe:" + ok.output.trim());`,
				`return outcomes.join(",");`,
			].join("\n"),
		}),
		fauxAssistantMessage("done"),
	]);
	try {
		await runtime.root.setPlanMode("plan");
		const planTools = await toolNames(runtime);
		expect(planTools).toContain("codemode");
		expect(planTools).toContain("submit_plan");
		await runtime.waitAnswer(await runtime.submit("go"));
		const [result] = await toolResults(runtime);
		expect(resultText(result as never)).toContain("edit:rejected,bash:rejected,safe:safe");
		expect(await Bun.file(target).text()).toBe("original");
		await runtime.root.setPlanMode("normal");
		expect(await toolNames(runtime)).toContain("codemode");
		expect(await toolNames(runtime)).not.toContain("submit_plan");
		expect(await toolNames(runtime)).toContain("edit");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("gives subagents the parent's mode and gates an explore script's bash behind approval", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "only");
	const cwd = (await runtime.conversation.agent(runtime.context)).cwd!;
	faux.setResponses([
		call("subagent", { type: "explore", title: "Inspect", task: "Inspect" }),
		call("codemode", {
			code: [
				`try { await tools.bash({ command: "printf approved > result.txt" }); return "ran"; }`,
				`catch (error) { return "blocked: " + error.message; }`,
			].join("\n"),
		}),
		fauxAssistantMessage("Child report"),
		fauxAssistantMessage("Main report"),
	]);
	try {
		const job = await runtime.submit("Investigate");
		let approval: ToolApproval | undefined;
		for (let i = 0; i < 500 && !approval; i++) {
			approval = (await runtime.approvals.list(runtime.root.id, runtime.context)).find((a) => a.status === "pending");
			if (!approval) await Bun.sleep(10);
		}
		expect(approval).toBeDefined();
		expect(await Bun.file(join(cwd, "result.txt")).exists()).toBe(false);
		await runtime.approvals.decide(
			runtime.root.id,
			approval!.delegationTaskId,
			approval!.id,
			approval!.version,
			"denied",
			runtime.context,
		);
		await runtime.waitAnswer(job);
		expect(await Bun.file(join(cwd, "result.txt")).exists()).toBe(false);
		const [round] = await listDelegations(runtime.harness, runtime.conversation.id, runtime.context);
		expect(await modeOf(runtime, round!.childId)).toBe("only");
		expect(await toolNames(runtime, round!.childId)).toEqual(["codemode"]);
		const child = await (await runtime.harness.conversation(round!.childId as never, runtime.context))!.agent(
			runtime.context,
		);
		const callable = child.callable.map((t) => t.name);
		expect(callable).toEqual(expect.arrayContaining(["read", "bash"]));
		for (const name of ["edit", "write", "job", "subagent", "todo"]) expect(callable).not.toContain(name);
		const results = (
			await (await runtime.harness.conversation(round!.childId as never, runtime.context))!.entries(
				{ order: "ascending" },
				100,
				undefined,
				runtime.context,
			)
		).items
			.flatMap((entry) => entry.model ?? [])
			.flatMap((m) => (m.role === "toolResult" ? [resultText(m as never)] : []));
		expect(results.join("\n")).toContain("blocked:");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("lets a second script wait for a free worker and fails it as busy after the wait limit", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "on", { codemodeLimits: { maxWorkers: 1, waitMs: 300 } });
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", { code: `await tools.bash({ command: "sleep 1.2" });\nreturn "first done";` }),
				fauxToolCall("codemode", { code: `return "second done";` }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	try {
		await runtime.waitAnswer(await runtime.submit("go"));
		const texts = (await toolResults(runtime)).map((m) => resultText(m as never));
		expect(texts.some((t) => t.includes("first done"))).toBe(true);
		expect(texts.some((t) => t.includes("Codemode sandbox is busy"))).toBe(true);
		expect(texts.some((t) => t.includes("second done"))).toBe(false);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("stops a script when the runtime closes while it is running, and closes promptly", async () => {
	const faux = fauxProvider();
	const runtime = await open(faux, "on");
	faux.setResponses([call("codemode", { code: `await tools.bash({ command: "sleep 30" });\nreturn "never";` })]);
	const job = await runtime.submit("go");
	await Bun.sleep(300);
	const started = Date.now();
	await runtime.close();
	expect(Date.now() - started).toBeLessThan(10_000);
	void job;
}, 30_000);
