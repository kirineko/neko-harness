import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { removeDirSync, trySymlink } from "../../../test/temp-dir.ts";
import { WORKSPACE_UNSUPPORTED, workspaceClient } from "../src/client-session.ts";
import {
	ChangeDetailSchema,
	ChangeListSchema,
	ChatViewSchema,
	WorkspaceDirSchema,
	WorkspaceFileSchema,
} from "../src/contract.ts";
import { cleanup, connectTestClient, makeGateway, waitFor } from "./helpers.ts";

const tool = (name: string, args: Record<string, string>) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

it("browses a session's workspace read-only and refuses escapes and credentials", async () => {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "neko-ws-browse-")));
	const outside = realpathSync(mkdtempSync(join(tmpdir(), "neko-ws-outside-")));
	const target = await makeGateway();
	const client = await connectTestClient(target);
	try {
		mkdirSync(join(work, "src"));
		writeFileSync(join(work, "src/a.ts"), "export const a = 1;\n");
		writeFileSync(join(work, ".env"), "SECRET=hunter2");
		writeFileSync(join(outside, "secret.txt"), "outside");
		const linked = trySymlink(join(outside, "secret.txt"), join(work, "link.txt"));
		const session = await target.gateway.runtime.createConversation({ cwd: work });
		const chat = await client.attach(String(session.id));
		const files = workspaceClient(chat, client.host);
		expect(files.supported).toBe(true);
		expect(files.summary()).toEqual({ revision: 0, files: 0, added: 0, removed: 0 });

		const root = await files.dir("");
		expect(Value.Check(WorkspaceDirSchema, root)).toBe(true);
		expect(root.entries.map((e) => e.name)).toEqual(["src", ".env", ...(linked ? ["link.txt"] : [])]);
		expect((await files.dir("src")).entries.map((e) => e.path)).toEqual(["src/a.ts"]);
		const file = await files.file("src/a.ts");
		expect(Value.Check(WorkspaceFileSchema, file)).toBe(true);
		expect(file).toMatchObject({ kind: "text", content: "export const a = 1;\n", truncated: false });

		const secret = await files.file(".env");
		expect(secret.kind).toBe("protected");
		expect(JSON.stringify(secret)).not.toContain("hunter2");
		for (const bad of ["../x", outside, ...(linked ? ["link.txt"] : []), ".git/config", "a\\b", "missing.ts"])
			await expect(files.file(bad)).rejects.toThrow();
		await expect(files.dir("../")).rejects.toThrow();

		const aborted = new AbortController();
		aborted.abort();
		await expect(files.dir("src", aborted.signal)).rejects.toThrow();
		expect(Value.Check(ChatViewSchema, chat.view.value)).toBe(true);
	} finally {
		await client.close();
		await cleanup(target);
		removeDirSync(work);
		removeDirSync(outside);
	}
}, 30_000);

it("publishes agent changes live with a revision, a list and per-file diffs, subagents included", async () => {
	const work = realpathSync(mkdtempSync(join(tmpdir(), "neko-ws-changes-")));
	const target = await makeGateway();
	const client = await connectTestClient(target);
	try {
		writeFileSync(join(work, "seed.txt"), "alpha\nbeta\n");
		const session = await target.gateway.runtime.createConversation({ cwd: work });
		const chat = await client.attach(String(session.id));
		const files = workspaceClient(chat);
		target.faux.setResponses([
			tool("edit", { path: "seed.txt", oldText: "beta", newText: "gamma" }),
			tool("subagent", { type: "coder", title: "Writer", task: "write child.txt" }),
			tool("write", { path: "child.txt", content: "child\n" }),
			fauxAssistantMessage([fauxText("child done")]),
			tool("write", { path: "main.txt", content: "main\n" }),
			fauxAssistantMessage([fauxText("all done")]),
		]);
		await chat.submit({ content: "change things" });
		await waitFor(
			() => chat.view.value?.busy === false && (chat.view.value.changes?.files ?? 0) === 3,
			"three changed files",
		);
		const summary = chat.view.value!.changes!;
		expect(summary.revision).toBe(3);
		expect(summary.added).toBeGreaterThanOrEqual(3);
		expect(Value.Check(ChatViewSchema, chat.view.value)).toBe(true);

		const list = await files.changes();
		expect(Value.Check(ChangeListSchema, list)).toBe(true);
		expect(list.revision).toBe(summary.revision);
		expect(list.files.map((f) => f.path).sort()).toEqual(["child.txt", "main.txt", "seed.txt"]);
		expect(list.files.find((f) => f.path === "child.txt")?.agents[0]).not.toBe("main");

		const detail = (await files.change("seed.txt"))!;
		expect(Value.Check(ChangeDetailSchema, detail)).toBe(true);
		expect(detail.ops).toHaveLength(1);
		expect(detail.ops[0]).toMatchObject({ tool: "edit", agent: "main" });
		expect(detail.ops[0]!.diff).toContain("gamma");
		expect(await files.change("nothing.txt")).toBeNull();
	} finally {
		await client.close();
		await cleanup(target);
		removeDirSync(work);
	}
}, 30_000);

it("treats a view without the changes summary as an old gateway", async () => {
	const target = await makeGateway();
	const client = await connectTestClient(target);
	try {
		const chat = await client.attach(String(target.gateway.runtime.root.id));
		const old = { ...chat.view, value: { ...chat.view.value!, changes: undefined } } as unknown as typeof chat;
		const files = workspaceClient(old as never);
		expect(files.supported).toBe(false);
		expect(files.summary()).toBeUndefined();
		await expect(files.dir("")).rejects.toThrow(WORKSPACE_UNSUPPORTED);
		await expect(files.changes()).rejects.toThrow(WORKSPACE_UNSUPPORTED);
		const { changes: _drop, ...view } = chat.view.value!;
		expect(Value.Check(ChatViewSchema, view)).toBe(true);
	} finally {
		await client.close();
		await cleanup(target);
	}
}, 30_000);
