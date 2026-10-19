import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime, type NekoRuntime } from "../src/runtime.ts";
import type { WindowsShellResolver, WindowsShellStatus } from "../src/windows-shell.ts";
import { WorkspaceFiles } from "../src/workspace-files.ts";

const MISSING: WindowsShellStatus = {
	kind: "missing",
	reason: "not_found",
	detail: "No Git Bash was found.",
	searched: ["C:\\Program Files\\Git\\bin\\bash.exe"],
};
const resolverOf = (status: WindowsShellStatus): WindowsShellResolver => ({ status: () => status });

it("fails shell strings with guidance but still runs argv commands when Git Bash is missing", async () => {
	const files = new WorkspaceFiles(undefined, resolverOf(MISSING));
	try {
		const env = files.env(process.cwd());
		const shell = await env.exec("echo hi", undefined, BACKGROUND_CONTEXT);
		expect(shell.ok).toBe(false);
		if (shell.ok) throw new Error("expected failure");
		expect(shell.error.code).toBe("shell_unavailable");
		expect(shell.error.message).toContain("Git for Windows");
		expect(shell.error.message).toContain("shell.path");
		expect(shell.error.message).toContain("C:\\Program Files\\Git\\bin\\bash.exe");

		const argv = await env.exec(
			[process.execPath, "-e", "process.stdout.write('argv-ok')"],
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(argv.ok).toBe(true);
		if (!argv.ok) throw new Error("expected success");
		expect(argv.value.exitCode).toBe(0);
	} finally {
		await files.close();
	}
});

it("passes the discovered bash as shellPath so the upstream PATH fallback is never used", async () => {
	const bash = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
	const files = new WorkspaceFiles(undefined, resolverOf({ kind: "found", path: bash, source: "auto" }));
	try {
		expect(files.shellStatus()).toEqual({ kind: "found", path: bash, source: "auto" });
		const env = files.env(process.cwd());
		// A found shell is handed to the upstream env; it must not be replaced by the unavailable stub.
		expect(env.constructor.name).toBe("LocalExecutionEnv");
	} finally {
		await files.close();
	}
});

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function openWithoutShell(dir: string, responses: ReturnType<typeof fauxAssistantMessage>[]) {
	const faux = fauxProvider();
	faux.setResponses(responses);
	return createNekoRuntime({
		storagePath: join(dir, "db.sqlite"),
		cwd: dir,
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		shellResolver: resolverOf(MISSING),
	});
}

const toolResults = async (runtime: NekoRuntime) =>
	(await runtime.root.conversation.entries({}, 200, undefined, runtime.context)).items
		.filter((entry) => entry.model?.[0]?.role === "toolResult")
		.map((entry) => JSON.stringify(entry.model![0]));

it("reports the same error from the bash tool and job start, keeps the session usable and file tools working", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-shell-missing-"));
	await writeFile(join(dir, "note.txt"), "file-content");
	const runtime = await openWithoutShell(dir, [
		toolCall("bash", { command: "echo hi" }),
		toolCall("job", { action: "start", command: "echo hi", title: "t" }),
		toolCall("read", { path: "note.txt" }),
		fauxAssistantMessage([fauxText("done")]),
	]);
	try {
		expect(await runtime.waitAnswer(await runtime.submit("go"))).toEqual({ status: "done", text: "done" });
		const results = await toolResults(runtime);
		const byTool = (name: string) => results.find((text) => text.includes(`"toolName":"${name}"`)) ?? "";
		const [bash, job, read] = [byTool("bash"), byTool("job"), byTool("read")];
		for (const text of [bash, job]) {
			expect(text).toContain("Git for Windows");
			expect(text).toContain("shell.path");
		}
		expect(read).toContain("file-content");
		expect((await runtime.root.jobs()).filter((item) => item.status === "running")).toEqual([]);
		expect(runtime.shellStatus()).toMatchObject({ status: "missing", reason: "not_found" });
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
});
