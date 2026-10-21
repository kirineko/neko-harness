import { expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { FindFiles, SEARCH_LIMITS, SearchText } from "../src/agent-file-search.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { WorkspaceFiles } from "../src/workspace-files.ts";

it("discovers ignored-aware paths and searches literal UTF-8/CRLF without modifying files", async () => {
	const root = await mkdtemp(join(tmpdir(), "neko-agent-search-"));
	const files = new WorkspaceFiles();
	try {
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
		await writeFile(join(root, ".gitignore"), "ignored/\n");
		await mkdir(join(root, "ignored"));
		await writeFile(join(root, "ignored/secret"), "needle");
		await mkdir(join(root, "中文 dir"));
		const target = join(root, "中文 dir/a.ts");
		const source = "before\r\nneedle $(touch NO) `echo`\r\nafter\r\n";
		await writeFile(target, source);
		const api = { env: files.env(root) } as unknown as ToolExecutionApi;
		const found = await FindFiles.execute({ query: "a.ts" }, api, context);
		expect(JSON.stringify(found)).toContain("中文 dir/a.ts");
		expect(JSON.stringify(await FindFiles.execute({}, api, context))).not.toContain("secret");
		const result = await SearchText.execute({ pattern: "needle $(touch NO) `echo`", contextLines: 1 }, api, context);
		expect(JSON.stringify(result)).toContain("a.ts:2:needle");
		expect(JSON.stringify(result)).toContain("a.ts:1:before");
		expect(JSON.stringify(result)).toContain('"complete":true');
		expect(await readFile(target, "utf8")).toBe(source);
		await writeFile(join(root, "binary"), new Uint8Array([0, 1, 2]));
		await writeFile(join(root, "large"), "x".repeat(SEARCH_LIMITS.fileBytes + 1));
		const partial = await SearchText.execute({ pattern: "absent" }, api, context);
		expect(JSON.stringify(partial)).toContain('"complete":false');
		expect(JSON.stringify(partial)).toContain('"skipped":2');
		const controller = new AbortController();
		controller.abort();
		await expect(FindFiles.execute({}, api, withAbortSignal(controller.signal, context))).rejects.toThrow();
		await expect(SearchText.execute({ pattern: "x", path: "missing" }, api, context)).rejects.toThrow();
	} finally {
		await files.close();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

it("reports partial listings and bounded output instead of claiming absence", async () => {
	const files = new WorkspaceFiles();
	const env = files.env(process.cwd());
	env.listFiles = async () => ({
		ok: true,
		value: {
			entries: [
				{ path: "中文/a.ts", kind: "file" },
				{ path: "b.ts", kind: "file" },
			],
			truncated: true,
		},
	});
	try {
		const api = { env } as unknown as ToolExecutionApi;
		expect(JSON.stringify(await FindFiles.execute({ query: "missing" }, api, context))).toContain('"complete":false');
		expect(JSON.stringify(await FindFiles.execute({ limit: 1 }, api, context))).not.toContain("b.ts");
	} finally {
		await files.close();
	}
});

it("runs discover -> search -> native read through the actual runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "neko-search-chain-"));
	await writeFile(join(root, "evidence.ts"), "export const answer = 42;\n");
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("find_files", { query: "evidence" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("search_text", { pattern: "answer" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read", { path: "evidence.ts", offset: 1, limit: 1 })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("evidence.ts:1 defines answer = 42")]),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		cwd: root,
		credentials: new InMemoryCredentialStore(),
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	try {
		const answer = await runtime.waitAnswer(await runtime.submit("Find the answer definition"));
		expect(answer).toEqual({ status: "done", text: "evidence.ts:1 defines answer = 42" });
		const view = await runtime.viewState();
		const saved = JSON.stringify(view.value.entries);
		expect(saved).toContain("Search complete");
		expect(saved).toContain("export const answer = 42");
		view.dispose();
	} finally {
		await runtime.close();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

it("uses environment path semantics for Windows paths and marks read failures/byte truncation", async () => {
	const files = new WorkspaceFiles();
	const env = files.env(process.cwd());
	env.absolutePath = async () => ({ ok: true, value: "C:\\work dir" });
	env.joinPath = async (parts) => ({ ok: true, value: parts.join("\\") });
	env.listFiles = async () => ({
		ok: true,
		value: { entries: [{ path: "中文/a.ts", kind: "file" }], truncated: false },
	});
	try {
		const api = { env } as unknown as ToolExecutionApi;
		expect(JSON.stringify(await FindFiles.execute({}, api, context))).toContain("C:/work dir/中文/a.ts");
		env.openBinaryReader = async () => {
			throw new Error("access denied");
		};
		// Native env methods return tagged errors; an adapter throwing remains an explicit tool failure.
		await expect(SearchText.execute({ pattern: "x" }, api, context)).rejects.toThrow("access denied");
		env.openBinaryReader = async () =>
			({ ok: false, error: { code: "permission-denied", message: "access denied" } }) as never;
		const failed = await SearchText.execute({ pattern: "x" }, api, context);
		expect(failed.details).toEqual({ complete: false, skipped: 1 });
		env.listFiles = async () => ({
			ok: true,
			value: { entries: [{ path: "x".repeat(SEARCH_LIMITS.outputBytes), kind: "file" }], truncated: false },
		});
		const bounded = await FindFiles.execute({}, api, context);
		expect(bounded.details).toMatchObject({ complete: false });
		expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(SEARCH_LIMITS.outputBytes);
	} finally {
		await files.close();
	}
});

it("aborts a slow environment on the deadline", async () => {
	const files = new WorkspaceFiles();
	const env = files.env(process.cwd());
	env.listFiles = async (_path, _options, ctx) =>
		new Promise((_resolve, reject) => {
			const abort = () => reject(ctx.abortSignal?.reason);
			ctx.abortSignal?.addEventListener("abort", abort, { once: true });
			if (ctx.abortSignal?.aborted) abort();
		});
	const original = SEARCH_LIMITS.timeoutMs;
	SEARCH_LIMITS.timeoutMs = 50;
	try {
		await expect(SearchText.execute({ pattern: "x" }, { env } as unknown as ToolExecutionApi, context)).rejects.toThrow(
			"timed out",
		);
	} finally {
		SEARCH_LIMITS.timeoutMs = original;
		await files.close();
	}
}, 5000);
