import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getCurrentSystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool, SystemEntry } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { afterEach, expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/index.ts";

const dirs: string[] = [];
function directory() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-prompt-e2e-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

type Gate = { promise: Promise<void>; resolve: () => void };

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function gatedTool(started: Gate, release: Gate, onStart = () => {}) {
	return defineExtension({
		name: "prompt-resource-test",
		tools: [
			defineTool({
				name: "prompt_gate",
				description: "Hold a tool round while prompt resources change",
				parameters: obj({}, { open: true }),
				execute: async () => {
					onStart();
					started.resolve();
					await release.promise;
					return { output: [{ type: "text" as const, text: "tool finished" }] };
				},
			}),
		],
	});
}

it("refreshes project instructions and skills when a new input is admitted", async () => {
	const home = directory();
	const workspace = directory();
	mkdirSync(join(home, ".agents"), { recursive: true });
	writeFileSync(join(home, ".agents", "AGENTS.md"), "user rules");
	writeFileSync(join(workspace, "AGENTS.md"), "project rules v1");
	const skillDir = join(workspace, ".agents", "skills", "pdf");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\ndescription: Read PDFs\n---\nbody`);

	const contexts: TranscriptContext[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("one")]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("two")]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("three")]);
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		cwd: workspace,
		promptHome: home,
	});
	try {
		await runtime.waitAnswer(await runtime.submit("hello"));
		const first = getCurrentSystemMessage(contexts[0]!.messages)?.sections ?? {};
		expect(first.project_context).toContain("user rules");
		expect(first.project_context).toContain("project rules v1");
		expect(first.skills).toContain("<name>pdf</name>");
		expect(first.skills).toContain(join(skillDir, "SKILL.md"));

		writeFileSync(join(workspace, "AGENTS.md"), "project rules v2");
		await runtime.waitAnswer(await runtime.submit("again"));
		const second = getCurrentSystemMessage(contexts[1]!.messages)?.sections ?? {};
		expect(second.project_context).toContain("project rules v2");
		expect(second.project_context).not.toContain("project rules v1");
		rmSync(join(workspace, "AGENTS.md"));
		rmSync(join(home, ".agents", "AGENTS.md"));
		rmSync(skillDir, { recursive: true });
		await runtime.waitAnswer(await runtime.submit("after deletion"));
		const third = getCurrentSystemMessage(contexts[2]!.messages)?.sections ?? {};
		expect(third.project_context).toBeUndefined();
		// The workspace skill is gone; builtin skills still populate the section.
		expect(third.skills).toBeDefined();
		expect(third.skills).not.toContain("<name>pdf</name>");
	} finally {
		await runtime.close();
	}
});

it("keeps system resources stable after a tool edits AGENTS.md until the next input", async () => {
	const home = directory();
	const workspace = directory();
	const agents = join(workspace, "AGENTS.md");
	writeFileSync(agents, "project rules v1");
	const started = gate();
	const release = gate();
	const contexts: TranscriptContext[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("prompt_gate", {}, { id: "edit-agents" })], {
				stopReason: "toolUse",
			});
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("tool round answered")]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("next input answered")]);
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		cwd: workspace,
		promptHome: home,
		extensions: [gatedTool(started, release, () => writeFileSync(agents, "project rules v2"))],
	});
	try {
		const first = await runtime.submit("edit project instructions");
		await started.promise;
		const before = await runtime.conversation.entries({}, 100, undefined, runtime.context);
		const systemEntriesBefore = before.items.filter((entry) => SystemEntry.is(entry)).length;
		expect(systemEntriesBefore).toBeGreaterThan(0);
		release.resolve();
		expect((await runtime.waitAnswer(first)).status).toBe("done");

		expect(contexts).toHaveLength(2);
		const initial = getCurrentSystemMessage(contexts[0]!.messages)!;
		const continued = getCurrentSystemMessage(contexts[1]!.messages)!;
		expect(initial.sections?.project_context).toContain("project rules v1");
		expect(continued.content).toEqual(initial.content);
		expect(continued.sections).toEqual(initial.sections);
		expect(contexts[1]!.messages.filter((message) => message.role === "system")).toHaveLength(
			contexts[0]!.messages.filter((message) => message.role === "system").length,
		);
		const after = await runtime.conversation.entries({}, 100, undefined, runtime.context);
		expect(after.items.filter((entry) => SystemEntry.is(entry))).toHaveLength(systemEntriesBefore);

		await runtime.waitAnswer(await runtime.submit("use the updated instructions"));
		const next = getCurrentSystemMessage(contexts[2]!.messages)!.sections!;
		expect(next.project_context).toContain("project rules v2");
		expect(next.project_context).not.toContain("project rules v1");
	} finally {
		release.resolve();
		started.resolve();
		await runtime.close();
	}
}, 30_000);

it("isolates active resources between conversations sharing a workspace", async () => {
	const home = directory();
	const workspace = directory();
	const agents = join(workspace, "AGENTS.md");
	writeFileSync(agents, "shared project v1");
	const started = gate();
	const release = gate();
	const contexts: TranscriptContext[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("prompt_gate", {}, { id: "conversation-a" })], {
				stopReason: "toolUse",
			});
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("conversation B answered")]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("conversation A answered")]);
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		cwd: workspace,
		promptHome: home,
		extensions: [gatedTool(started, release)],
	});
	try {
		const other = await runtime.createConversation();
		const first = await runtime.submit("conversation A");
		await started.promise;
		writeFileSync(agents, "shared project v2");
		expect((await other.waitAnswer(await other.submit("conversation B"))).status).toBe("done");
		const otherSystem = getCurrentSystemMessage(contexts[1]!.messages)!;
		expect(otherSystem.sections?.project_context).toContain("shared project v2");
		expect(otherSystem.sections?.project_context).not.toContain("shared project v1");

		release.resolve();
		expect((await runtime.waitAnswer(first)).status).toBe("done");
		expect(contexts).toHaveLength(3);
		const initial = getCurrentSystemMessage(contexts[0]!.messages)!;
		const continued = getCurrentSystemMessage(contexts[2]!.messages)!;
		expect(initial.sections?.project_context).toContain("shared project v1");
		expect(continued.content).toEqual(initial.content);
		expect(continued.sections).toEqual(initial.sections);
		expect(contexts[2]!.messages.filter((message) => message.role === "system")).toHaveLength(
			contexts[0]!.messages.filter((message) => message.role === "system").length,
		);
	} finally {
		release.resolve();
		started.resolve();
		await runtime.close();
	}
}, 30_000);
