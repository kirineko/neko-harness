import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { ConversationChanges } from "../src/file-changes.ts";
import { CHANGE_LIMITS, createNekoRuntime, MAIN_AGENT, normalizeChangePath } from "../src/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
const dirs: string[] = [];
const directory = () => {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-changes-")));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});
const tool = (name: string, args: Record<string, string>) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

it("normalizes tool paths against the tool cwd and marks paths outside the workspace", () => {
	const root = resolve("/work/space");
	const elsewhere = resolve("/work/elsewhere/x.ts").split("\\").join("/");
	expect(normalizeChangePath("a/b.ts", root, root)).toEqual({ path: "a/b.ts", outside: false });
	expect(normalizeChangePath(join(root, "a/../c.ts"), root, root)).toEqual({ path: "c.ts", outside: false });
	expect(normalizeChangePath("../x.ts", join(root, "sub"), root)).toEqual({ path: "x.ts", outside: false });
	expect(normalizeChangePath("../../elsewhere/x.ts", join(root, "sub"), root)).toEqual({
		path: elsewhere,
		outside: true,
	});
	expect(normalizeChangePath("~/x.ts", root, root)).toEqual({ path: "~/x.ts", outside: true });
	expect(normalizeChangePath(".", root, root).outside).toBe(true);
});

it("aggregates successful edit/write calls per file, skips failures, flags outside paths and survives a restart", async () => {
	const work = directory();
	const elsewhere = directory();
	const storagePath = join(directory(), "state.sqlite");
	const faux = fauxProvider();
	const options = { storagePath, model, providers: [faux.provider], credentials: new InMemoryCredentialStore() };
	let runtime = await createNekoRuntime({ ...options, cwd: work });
	try {
		mkdirSync(join(work, "sub"));
		faux.setResponses([
			tool("write", { path: "a.txt", content: "one\ntwo\nthree\n" }),
			tool("edit", { path: "a.txt", oldText: "two", newText: "2" }),
			tool("edit", { path: "a.txt", oldText: "does not exist", newText: "x" }),
			tool("edit", { path: "a.txt", oldText: "three", newText: "3" }),
			tool("write", { path: "sub/b.txt", content: "b\n" }),
			tool("write", { path: join(elsewhere, "out.txt"), content: "out\n" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await runtime.waitAnswer(await runtime.submit("go"));
		const empty = await runtime.root.changeSummary();
		const list = await runtime.root.changes();
		expect(empty).toEqual({
			revision: 5,
			files: 3,
			added: list.files.reduce((n, f) => n + f.added, 0),
			removed: list.files.reduce((n, f) => n + f.removed, 0),
		});
		expect(list.truncated).toBe(false);
		expect(list.revision).toBe(5);
		const byPath = Object.fromEntries(list.files.map((f) => [f.path, f]));
		expect(Object.keys(byPath).sort()).toEqual(
			["a.txt", join(elsewhere, "out.txt").split("\\").join("/"), "sub/b.txt"].sort(),
		);
		expect(byPath["a.txt"]).toMatchObject({ ops: 3, agents: [MAIN_AGENT] });
		expect(byPath["a.txt"]!.outside).toBeUndefined();
		expect(byPath["a.txt"]!.added).toBeGreaterThanOrEqual(3);
		expect(byPath["a.txt"]!.removed).toBeGreaterThanOrEqual(2);
		expect(byPath["sub/b.txt"]).toMatchObject({ ops: 1, added: 1, removed: 0 });
		expect(list.files.find((f) => f.outside)?.path).toContain("out.txt");
		// Most recent change first.
		expect(list.files.at(-1)?.path).toBe("a.txt");

		const detail = (await runtime.root.change("a.txt"))!;
		expect(detail.ops.map((o) => o.tool)).toEqual(["write", "edit", "edit"]);
		expect(detail.ops[0]!.diff).toContain("+ one");
		expect(detail.ops[1]!.diff).toContain("2");
		expect(detail.ops.every((o) => o.agent === MAIN_AGENT)).toBe(true);
		expect(detail.ops.map((o) => o.seq)).toEqual([...detail.ops.map((o) => o.seq)].sort((a, b) => a - b));
		expect(await runtime.root.change("missing.txt")).toBeUndefined();

		await runtime.close();
		runtime = await createNekoRuntime({ ...options, cwd: work });
		expect(await runtime.root.changes()).toEqual(list);
		expect(await runtime.root.change("a.txt")).toEqual(detail);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("includes subagent edits with the subagent's name and keeps sessions apart", async () => {
	const work = directory();
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		model,
		providers: [faux.provider],
		credentials: new InMemoryCredentialStore(),
		cwd: work,
	});
	try {
		faux.setResponses([
			tool("subagent", { type: "coder", title: "Writer", task: "write c.txt" }),
			tool("write", { path: "c.txt", content: "from child\n" }),
			fauxAssistantMessage([fauxText("child done")]),
			tool("write", { path: "m.txt", content: "from main\n" }),
			fauxAssistantMessage([fauxText("main done")]),
		]);
		await runtime.waitAnswer(await runtime.submit("delegate"));
		const list = await runtime.root.changes();
		const child = list.files.find((f) => f.path === "c.txt");
		expect(child?.agents).toHaveLength(1);
		expect(child?.agents[0]).not.toBe(MAIN_AGENT);
		expect(list.files.find((f) => f.path === "m.txt")?.agents).toEqual([MAIN_AGENT]);
		expect((await runtime.root.change("c.txt"))!.ops[0]!.agent).toBe(child!.agents[0]!);
		expect((await runtime.root.changeSummary()).files).toBe(2);

		const other = await runtime.createConversation({ cwd: directory() });
		expect(await other.changes()).toEqual({ revision: 0, files: [], truncated: false });
		expect(await other.changeSummary()).toEqual({ revision: 0, files: 0, added: 0, removed: 0 });
	} finally {
		await runtime.close();
	}
}, 30_000);

it("does not count calls that were rejected as errors", async () => {
	const work = directory();
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		model,
		providers: [faux.provider],
		credentials: new InMemoryCredentialStore(),
		cwd: work,
	});
	try {
		writeFileSync(join(work, "keep.txt"), "keep");
		faux.setResponses([
			tool("edit", { path: "keep.txt", oldText: "absent", newText: "x" }),
			tool("edit", { path: "missing.txt", oldText: "a", newText: "b" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await runtime.waitAnswer(await runtime.submit("fail"));
		expect(await runtime.root.changes()).toEqual({ revision: 0, files: [], truncated: false });
	} finally {
		await runtime.close();
	}
}, 30_000);

const call = (id: number, tool: string, args: unknown) =>
	({
		id,
		conversationId: 1,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "toolCall", id: `c${id}`, name: tool, arguments: args }] }],
	}) as never;
const result = (id: number, callId: string, details: unknown, isError = false) =>
	({
		id,
		conversationId: 1,
		kind: "pi.tool-result",
		model: [{ role: "toolResult", toolCallId: callId, toolName: "edit", content: [], details, isError }],
	}) as never;

it("bounds files, operations per file and diff bytes, and says so", () => {
	const state = new ConversationChanges(MAIN_AGENT, "/w", "/w");
	let id = 1;
	for (let i = 0; i < CHANGE_LIMITS.files + 5; i++) {
		state.feed(call(id, "write", { path: `f${i}.txt`, content: "x\n" }));
		state.feed(result(id + 1, `c${id}`, undefined));
		id += 2;
	}
	expect(state.files.size).toBe(CHANGE_LIMITS.files);
	expect(state.truncated).toBe(true);
	expect(state.total).toBe(CHANGE_LIMITS.files + 5);
	expect(state.files.has("f0.txt")).toBe(false);

	const many = new ConversationChanges(MAIN_AGENT, "/w", "/w");
	id = 1;
	for (let i = 0; i < CHANGE_LIMITS.opsPerFile + 3; i++) {
		many.feed(call(id, "write", { path: "same.txt", content: `${i}\n` }));
		many.feed(result(id + 1, `c${id}`, undefined));
		id += 2;
	}
	const same = many.files.get("same.txt")!;
	expect(same.ops).toBe(CHANGE_LIMITS.opsPerFile + 3);
	expect(same.items).toHaveLength(CHANGE_LIMITS.opsPerFile);
	expect(same.truncated).toBe(true);

	const big = new ConversationChanges(MAIN_AGENT, "/w", "/w");
	const diff = `${"+1 ".padEnd(60 * 1024, "x")}`;
	id = 1;
	for (let i = 0; i < 40; i++) {
		big.feed(call(id, "edit", { path: `big${i}.txt` }));
		big.feed(result(id + 1, `c${id}`, { diff }));
		id += 2;
	}
	expect(big.bytes).toBeLessThanOrEqual(CHANGE_LIMITS.diffBytes);
	expect(big.truncated).toBe(true);
	expect(big.files.get("big0.txt")!.items[0]).toMatchObject({ diff: "", truncated: true });
	expect(big.files.get("big39.txt")!.items[0]!.diff.length).toBeGreaterThan(0);

	const failed = new ConversationChanges(MAIN_AGENT, "/w", "/w");
	failed.feed(call(1, "edit", { path: "a.txt" }));
	failed.feed(result(2, "c1", { diff: "+1 x" }, true));
	expect(failed.total).toBe(0);
});

it("keeps a fork's changes to the entries it can see", async () => {
	const work = directory();
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		model,
		providers: [faux.provider],
		credentials: new InMemoryCredentialStore(),
		cwd: work,
	});
	try {
		faux.setResponses([tool("write", { path: "a.txt", content: "a\n" }), fauxAssistantMessage([fauxText("done")])]);
		await runtime.waitAnswer(await runtime.submit("go"));
		const fork = await runtime.forkConversation(runtime.root.id);
		expect((await fork.changes()).files.map((f) => f.path)).toEqual(["a.txt"]);
		faux.setResponses([tool("write", { path: "b.txt", content: "b\n" }), fauxAssistantMessage([fauxText("done")])]);
		await fork.waitAnswer(await fork.submit("more"));
		expect((await fork.changes()).files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
		expect((await runtime.root.changes()).files.map((f) => f.path)).toEqual(["a.txt"]);
	} finally {
		await runtime.close();
	}
}, 30_000);

it("browses the workspace of the session, not the process directory or another session", async () => {
	const a = directory();
	const b = directory();
	writeFileSync(join(a, "only-a.txt"), "A");
	writeFileSync(join(b, "only-b.txt"), "B");
	const faux = fauxProvider();
	const runtime = await createNekoRuntime({
		storage: "memory",
		model,
		providers: [faux.provider],
		credentials: new InMemoryCredentialStore(),
		cwd: a,
	});
	try {
		const second = await runtime.createConversation({ cwd: b });
		expect((await runtime.root.workspaceDir("")).entries.map((e) => e.name)).toEqual(["only-a.txt"]);
		expect((await second.workspaceDir("")).entries.map((e) => e.name)).toEqual(["only-b.txt"]);
		expect(await second.workspaceFile("only-b.txt")).toMatchObject({ kind: "text", content: "B" });
		await expect(second.workspaceFile("only-a.txt")).rejects.toThrow();
		const aborted = new AbortController();
		aborted.abort();
		await expect(second.workspaceDir("", aborted.signal)).rejects.toThrow();
	} finally {
		await runtime.close();
	}
}, 30_000);
