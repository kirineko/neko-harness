import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { ConversationChanges, MAIN_AGENT } from "../src/file-changes.ts";
import { addNestedChange, type NestedChange, type NestedChangesState } from "../src/nested-changes.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { listDelegations } from "../src/subagents.ts";

const model = { provider: "faux", modelId: "faux-1" };
const dirs: string[] = [];
const directory = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-codemode-changes-")));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});
type Args = Parameters<typeof fauxToolCall>[1];
const call = (name: string, args: Args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const open = (faux: ReturnType<typeof fauxProvider>, cwd: string, mode: "on" | "only" = "on") =>
	createNekoRuntime({ storage: "memory", providers: [faux.provider], model, cwd, codemodeSettings: { mode } });

const assistant = (id: number, callId: string, name: string) =>
	({
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: {} }] }],
	}) as never;
const toolResult = (id: number, callId: string) =>
	({
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [{ role: "toolResult", toolCallId: callId, toolName: "codemode", content: [], isError: false }],
	}) as never;
const nestedState = (...changes: Partial<NestedChange>[]): NestedChangesState => {
	const state: NestedChangesState = { total: 0, dropped: false, items: [] };
	for (const [index, change] of changes.entries())
		addNestedChange(state, {
			id: `s1/${index + 1}`,
			parentCallId: "s1",
			tool: "write",
			path: `f${index}.txt`,
			diff: "+ x",
			added: 1,
			removed: 0,
			truncated: false,
			...change,
		});
	return state;
};

it("overlays only the records whose script call is in the entries, at the script's position", () => {
	const state = new ConversationChanges(MAIN_AGENT, "/w", "/w");
	state.feed(assistant(2, "s1", "codemode"));
	const running = state.withNested(nestedState({ path: "a.txt" }, { parentCallId: "gone", path: "b.txt" }));
	expect([...running.files.keys()]).toEqual(["a.txt"]);
	expect(running.files.get("a.txt")).toMatchObject({ ops: 1, lastSeq: 2, added: 1 });
	state.feed(toolResult(3, "s1"));
	const done = state.withNested(nestedState({ path: "a.txt" }));
	expect(done.files.get("a.txt")!.lastSeq).toBe(3);
	// The cached index is not touched.
	expect(state.files.size).toBe(0);
	expect(state.total).toBe(0);
});

it("counts the edits and writes a script made, with the right diff and agent", async () => {
	const dir = directory();
	writeFileSync(join(dir, "keep.txt"), "alpha\nbeta\n");
	const faux = fauxProvider();
	const runtime = await open(faux, dir);
	faux.setResponses([
		call("codemode", {
			code: [
				`await tools.edit({ path: "keep.txt", edits: [{ oldText: "beta", newText: "gamma" }] });`,
				`try { await tools.edit({ path: "keep.txt", edits: [{ oldText: "missing text", newText: "x" }] }); } catch (error) {}`,
				`await tools.write({ path: "new.txt", content: "one\\ntwo\\n" });`,
				`return "ok";`,
			].join("\n"),
		}),
		fauxAssistantMessage("done"),
	]);
	try {
		const before = await runtime.root.changes();
		await runtime.waitAnswer(await runtime.submit("go"));
		const list = await runtime.root.changes();
		expect(list.revision).toBeGreaterThan(before.revision);
		expect(list.files.map((f) => f.path).sort()).toEqual(["keep.txt", "new.txt"]);
		const keep = list.files.find((f) => f.path === "keep.txt")!;
		expect(keep).toMatchObject({ ops: 1, added: 1, removed: 1, agents: ["main"] });
		const detail = await runtime.root.change("keep.txt");
		expect(detail!.ops[0]!.diff).toContain("gamma");
		expect(readFileSync(join(dir, "keep.txt"), "utf8")).toContain("gamma");
		const written = await runtime.root.change("new.txt");
		expect(written!.ops[0]).toMatchObject({ tool: "write", added: 2 });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("keeps a script's earlier writes in the list when the script then fails", async () => {
	const dir = directory();
	const faux = fauxProvider();
	const runtime = await open(faux, dir);
	faux.setResponses([
		call("codemode", { code: `await tools.write({ path: "kept.txt", content: "x\\n" });\nthrow new Error("boom");` }),
		fauxAssistantMessage("done"),
	]);
	try {
		await runtime.waitAnswer(await runtime.submit("go"));
		const [file] = (await runtime.root.changes()).files;
		expect(file).toMatchObject({ path: "kept.txt", ops: 1 });
		expect(readFileSync(join(dir, "kept.txt"), "utf8")).toBe("x\n");
	} finally {
		await runtime.close();
	}
}, 30_000);

it("shows a script's changes in a fork made after it, and none in a fork made before it", async () => {
	const dir = directory();
	const faux = fauxProvider();
	const runtime = await open(faux, dir);
	faux.setResponses([
		fauxAssistantMessage("first"),
		call("codemode", { code: `await tools.write({ path: "later.txt", content: "x\\n" });\nreturn "ok";` }),
		fauxAssistantMessage("second"),
	]);
	try {
		await runtime.waitAnswer(await runtime.submit("one"));
		const entries = (await runtime.conversation.entries({ order: "ascending" }, 100, undefined, runtime.context)).items;
		const before = entries.at(-1)!.id;
		await runtime.waitAnswer(await runtime.submit("two"));
		expect((await runtime.root.changes()).files.map((f) => f.path)).toEqual(["later.txt"]);
		const after = await runtime.forkConversation(runtime.root.id);
		expect((await after.changes()).files.map((f) => f.path)).toEqual(["later.txt"]);
		const earlier = await runtime.harness.commit(
			(tx) => tx.forkConversation(runtime.root.id, before, { ownership: { kind: "ownerless" } }),
			runtime.context,
		);
		const earlierSession = (await runtime.getConversation(earlier.id))!;
		expect((await earlierSession.changes()).files).toEqual([]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("attributes a subagent script's changes to that subagent", async () => {
	const dir = directory();
	const faux = fauxProvider();
	const runtime = await open(faux, dir, "only");
	faux.setResponses([
		call("subagent", { type: "coder", title: "Writer", task: "write a file" }),
		call("codemode", { code: `await tools.write({ path: "child.txt", content: "x\\n" });\nreturn "ok";` }),
		fauxAssistantMessage("Child report"),
		fauxAssistantMessage("Main report"),
	]);
	try {
		await runtime.waitAnswer(await runtime.submit("delegate"));
		const [round] = await listDelegations(runtime.harness, runtime.conversation.id, runtime.context);
		expect(round).toBeDefined();
		const list = await runtime.root.changes();
		expect(list.files).toHaveLength(1);
		expect(list.files[0]).toMatchObject({ path: "child.txt", agents: ["Writer"] });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("evicts the oldest script records past the bounds and says so", () => {
	const state: NestedChangesState = { total: 0, dropped: false, items: [] };
	for (let i = 0; i < 1005; i++)
		addNestedChange(state, {
			id: `s/${i}`,
			parentCallId: "s",
			tool: "write",
			path: "f.txt",
			diff: "",
			added: 0,
			removed: 0,
			truncated: false,
		});
	expect(state.items).toHaveLength(1000);
	expect(state.total).toBe(1005);
	expect(state.dropped).toBe(true);
	addNestedChange(state, { ...state.items[5]!, added: 9 });
	expect(state.total).toBe(1005);
	expect(state.items.at(-1)!.added).toBe(9);
});
