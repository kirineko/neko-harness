import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getCurrentSystemMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ConversationBusy, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { fauxProvider } from "../../../test/faux.ts";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/index.ts";

const dirs: string[] = [];
function directory() {
	const d = realpathSync(mkdtempSync(join(tmpdir(), "neko-skill-submit-")));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});

const writeSkill = (root: string, name: string, description: string, extra = "", body = `body of ${name}`) => {
	const skillDir = join(root, ".agents", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\ndescription: ${description}\n${extra}---\n${body}`);
};

const writeVersion = (root: string, version: string) =>
	writeSkill(root, "pdf", `PDF metadata ${version}`, "", `PDF body ${version}`);

type Gate = { promise: Promise<void>; resolve: () => void };

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function gatedTool(started: Gate, release: Gate) {
	return defineExtension({
		name: "skill-resource-test",
		tools: [
			defineTool({
				name: "skill_gate",
				description: "Hold a tool round while skill inputs are prepared",
				parameters: obj({}, { open: true }),
				execute: async () => {
					started.resolve();
					await release.promise;
					return { output: [{ type: "text" as const, text: "tool finished" }] };
				},
			}),
		],
	});
}

async function setup(extensions: readonly Extension[] = []) {
	const home = directory();
	const workspace = directory();
	writeSkill(workspace, "pdf", "Read PDFs");
	writeSkill(workspace, "hidden", "Hidden", "disable-model-invocation: true\n");
	const contexts: TranscriptContext[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(
		Array.from({ length: 20 }, () => (context: TranscriptContext) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("ok")]);
		}),
	);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
		cwd: workspace,
		promptHome: home,
		extensions,
	});
	return { runtime, contexts, workspace, home, faux };
}

const userTexts = (context: TranscriptContext): string[] =>
	context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
		);

const lastUserText = (context: TranscriptContext): string => userTexts(context).at(-1) ?? "";

function expectVersion(context: TranscriptContext, version: string) {
	const skills = getCurrentSystemMessage(context.messages)?.sections?.skills;
	expect(skills?.match(/PDF metadata v\d/g)).toEqual([`PDF metadata ${version}`]);
}

it("expands /skill: with args into a skill block; hidden skills expand too", async () => {
	const { runtime, contexts, workspace } = await setup();
	try {
		await runtime.waitAnswer(await runtime.submit("/skill:pdf summarize this"));
		const text = lastUserText(contexts[0]!);
		expect(text).toContain(`<skill name="pdf" location="${join(workspace, ".agents", "skills", "pdf", "SKILL.md")}">`);
		expect(text).toContain("body of pdf");
		expect(text).toContain("summarize this");
		expect(text).not.toContain("description: Read PDFs");

		await runtime.waitAnswer(await runtime.submit("/skill:hidden"));
		expect(lastUserText(contexts[1]!)).toContain("body of hidden");
	} finally {
		await runtime.close();
	}
});

it("passes unknown skills through and does not expand block content", async () => {
	const { runtime, contexts } = await setup();
	try {
		await runtime.waitAnswer(await runtime.submit("/skill:nope hi"));
		expect(lastUserText(contexts[0]!)).toBe("/skill:nope hi");

		await runtime.waitAnswer(await runtime.submit([{ type: "text", text: "/skill:pdf" }]));
		expect(lastUserText(contexts[1]!)).toBe("/skill:pdf");
	} finally {
		await runtime.close();
	}
});

it("listSkills sees new files during a run without replacing that run's active skills", async () => {
	const started = gate();
	const release = gate();
	const { runtime, contexts, workspace, home, faux } = await setup([gatedTool(started, release)]);
	writeSkill(home, "personal", "User-level skill");
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("skill_gate", {}, { id: "list-skills-gate" })], {
				stopReason: "toolUse",
			});
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("current run answered")]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("next input answered")]);
		},
	]);
	try {
		const first = await runtime.submit("/skill:pdf initial");
		await started.promise;
		const skills = await runtime.listSkills();
		const byName = new Map(skills.map((skill) => [skill.name, skill]));
		expect(byName.get("pdf")?.description).toBe("Read PDFs");
		expect(byName.get("hidden")?.description).toBe("Hidden");
		expect(byName.get("personal")?.description).toBe("User-level skill");
		expect(byName.get("pdf")?.location).toBe(join(workspace, ".agents", "skills", "pdf", "SKILL.md"));

		writeSkill(workspace, "fresh", "Added later");
		writeSkill(workspace, "pdf", "Latest PDF metadata", "", "Latest PDF body");
		const again = await runtime.listSkills();
		expect(again.map((skill) => skill.name)).toContain("fresh");
		expect(again.find((skill) => skill.name === "pdf")?.description).toBe("Latest PDF metadata");
		release.resolve();
		expect((await runtime.waitAnswer(first)).status).toBe("done");
		expect(contexts).toHaveLength(2);
		const initial = getCurrentSystemMessage(contexts[0]!.messages)!;
		const continued = getCurrentSystemMessage(contexts[1]!.messages)!;
		expect(initial.sections?.skills).toContain("Read PDFs");
		expect(initial.sections?.skills).not.toContain("<name>fresh</name>");
		expect(continued.content).toEqual(initial.content);
		expect(continued.sections?.skills).toBe(initial.sections?.skills);
		expect(contexts[1]!.messages.filter((message) => message.role === "system")).toHaveLength(
			contexts[0]!.messages.filter((message) => message.role === "system").length,
		);
		expect(lastUserText(contexts[1]!)).toContain("body of pdf");
		expect(lastUserText(contexts[1]!)).not.toContain("Latest PDF body");

		await runtime.waitAnswer(await runtime.submit("/skill:pdf next"));
		const nextSkills = getCurrentSystemMessage(contexts[2]!.messages)!.sections!.skills;
		expect(nextSkills).toContain("<name>fresh</name>");
		expect(nextSkills).toContain("Latest PDF metadata");
		expect(lastUserText(contexts[2]!)).toContain("Latest PDF body");
	} finally {
		release.resolve();
		started.resolve();
		await runtime.close();
	}
}, 30_000);

it("does not expand a duplicate request again after the skill changes", async () => {
	const { runtime, contexts, workspace } = await setup();
	try {
		const first = await runtime.submit("/skill:pdf args", { requestId: "skill-retry" });
		await runtime.waitAnswer(first);
		writeSkill(workspace, "pdf", "Changed metadata", "", "Changed body");
		const again = await runtime.submit("/skill:pdf args", { requestId: "skill-retry" });
		expect(again.id).toBe(first.id);
		expect((await runtime.waitAnswer(again)).status).toBe("done");
		expect(contexts).toHaveLength(1);
		expect(lastUserText(contexts[0]!)).toContain("body of pdf");
		expect(lastUserText(contexts[0]!)).not.toContain("Changed body");
		expect(getCurrentSystemMessage(contexts[0]!.messages)?.sections?.skills).toContain("Read PDFs");

		await runtime.waitAnswer(await runtime.submit("/skill:pdf next", { requestId: "skill-next" }));
		expect(lastUserText(contexts[1]!)).toContain("Changed body");
		expect(getCurrentSystemMessage(contexts[1]!.messages)?.sections?.skills).toContain("Changed metadata");
	} finally {
		await runtime.close();
	}
});

it("activates queued skill versions one at a time and ignores canceled and rejected inputs", async () => {
	const started = gate();
	const release = gate();
	const { runtime, contexts, workspace, faux } = await setup([gatedTool(started, release)]);
	writeVersion(workspace, "v1");
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("skill_gate", {}, { id: "queued-skill-gate" })], {
				stopReason: "toolUse",
			});
		},
		...Array.from({ length: 3 }, () => (context: TranscriptContext) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("answered")]);
		}),
	]);
	try {
		const initial = await runtime.submit("/skill:pdf initial", { requestId: "queued-v1" });
		await started.promise;
		writeVersion(workspace, "v2");
		const second = await runtime.submit("/skill:pdf second", { requestId: "queued-v2", whenBusy: "followUp" });
		expect((await second.status(runtime.context)).status).toBe("queued");
		expect((await second.status(runtime.context)).entry).toBeUndefined();
		writeVersion(workspace, "v3");
		const third = await runtime.submit("/skill:pdf third", { requestId: "queued-v3", whenBusy: "followUp" });
		expect((await third.status(runtime.context)).status).toBe("queued");
		expect((await third.status(runtime.context)).entry).toBeUndefined();
		const retry = await runtime.submit("/skill:pdf second", { requestId: "queued-v2", whenBusy: "followUp" });
		expect(retry.id).toBe(second.id);

		writeVersion(workspace, "v4");
		const canceled = await runtime.submit("/skill:pdf canceled", {
			requestId: "queued-canceled",
			whenBusy: "followUp",
		});
		expect(await canceled.abort(runtime.context)).toBe("aborted");
		expect((await canceled.status(runtime.context)).entry).toBeUndefined();
		expect(await runtime.waitAnswer(canceled)).toEqual({ status: "unanswered", reason: "aborted" });
		writeVersion(workspace, "v5");
		await expect(
			runtime.submit("/skill:pdf rejected", { requestId: "queued-rejected", whenBusy: "reject" }),
		).rejects.toBeInstanceOf(ConversationBusy);

		release.resolve();
		expect((await runtime.waitAnswer(initial)).status).toBe("done");
		expect((await runtime.waitAnswer(second)).status).toBe("done");
		expect((await runtime.waitAnswer(third)).status).toBe("done");
		expect(contexts).toHaveLength(4);
		expectVersion(contexts[0]!, "v1");
		expectVersion(contexts[1]!, "v1");
		expect(getCurrentSystemMessage(contexts[1]!.messages)!.content).toEqual(
			getCurrentSystemMessage(contexts[0]!.messages)!.content,
		);
		expect(contexts[1]!.messages.filter((message) => message.role === "system")).toHaveLength(
			contexts[0]!.messages.filter((message) => message.role === "system").length,
		);
		expect(userTexts(contexts[1]!)).toHaveLength(1);
		expect(lastUserText(contexts[1]!)).toContain("PDF body v1");

		expectVersion(contexts[2]!, "v2");
		expect(userTexts(contexts[2]!)).toHaveLength(2);
		expect(lastUserText(contexts[2]!)).toContain("PDF body v2");
		expect(lastUserText(contexts[2]!)).toContain("second");
		expect(lastUserText(contexts[2]!)).not.toContain("PDF body v3");

		expectVersion(contexts[3]!, "v3");
		const placed = userTexts(contexts[3]!);
		expect(placed).toHaveLength(3);
		expect(placed[0]).toContain("PDF body v1");
		expect(placed[1]).toContain("PDF body v2");
		expect(placed[2]).toContain("PDF body v3");
		expect(placed[2]).toContain("third");
		expect(placed.join("\n")).not.toContain("PDF body v4");
		expect(placed.join("\n")).not.toContain("PDF body v5");
		const secondRecord = await second.status(runtime.context);
		const thirdRecord = await third.status(runtime.context);
		expect(thirdRecord.entry!).toBeGreaterThan(secondRecord.entry!);
	} finally {
		release.resolve();
		started.resolve();
		await runtime.close();
	}
}, 30_000);

it("activates a steered skill snapshot only when it is placed after tools", async () => {
	const started = gate();
	const release = gate();
	const { runtime, contexts, workspace, faux } = await setup([gatedTool(started, release)]);
	writeVersion(workspace, "v1");
	faux.setResponses([
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxToolCall("skill_gate", {}, { id: "steered-skill-gate" })], {
				stopReason: "toolUse",
			});
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("initial and steer answered")]);
		},
	]);
	try {
		const initial = await runtime.submit("/skill:pdf initial");
		await started.promise;
		writeVersion(workspace, "v2");
		const steer = await runtime.submit("/skill:pdf steer", { whenBusy: "steer" });
		const queued = await steer.status(runtime.context);
		expect(queued.status).toBe("queued");
		expect(queued.entry).toBeUndefined();
		writeVersion(workspace, "v3");
		release.resolve();
		expect((await runtime.waitAnswer(initial)).status).toBe("done");
		expect((await runtime.waitAnswer(steer)).status).toBe("done");
		expect(contexts).toHaveLength(2);
		expectVersion(contexts[0]!, "v1");
		expectVersion(contexts[1]!, "v2");
		const placed = userTexts(contexts[1]!);
		expect(placed).toHaveLength(2);
		expect(placed[0]).toContain("PDF body v1");
		expect(placed[1]).toContain("PDF body v2");
		expect(placed[1]).toContain("steer");
		expect(placed[1]).not.toContain("PDF body v3");
		expect(contexts[1]!.messages.some((message) => message.role === "toolResult")).toBe(true);
		expect((await steer.status(runtime.context)).entry).toBeDefined();
	} finally {
		release.resolve();
		started.resolve();
		await runtime.close();
	}
}, 30_000);

it("uses the latest snapshot when steer and follow-up are placed at the same final boundary", async () => {
	const started = gate();
	const release = gate();
	const { runtime, contexts, workspace, faux } = await setup();
	writeVersion(workspace, "v1");
	faux.setResponses([
		async (context) => {
			contexts.push(context);
			started.resolve();
			await release.promise;
			return fauxAssistantMessage([fauxText("initial answered")]);
		},
		(context) => {
			contexts.push(context);
			return fauxAssistantMessage([fauxText("batch answered")]);
		},
	]);
	try {
		const initial = await runtime.submit("/skill:pdf initial");
		await started.promise;
		writeVersion(workspace, "v2");
		const steer = await runtime.submit("/skill:pdf steer", { whenBusy: "steer" });
		writeVersion(workspace, "v3");
		const follow = await runtime.submit("/skill:pdf follow", { whenBusy: "followUp" });
		expect((await steer.status(runtime.context)).status).toBe("queued");
		expect((await follow.status(runtime.context)).status).toBe("queued");
		writeVersion(workspace, "v4");
		release.resolve();
		expect((await runtime.waitAnswer(initial)).status).toBe("done");
		expect((await runtime.waitAnswer(steer)).status).toBe("done");
		expect((await runtime.waitAnswer(follow)).status).toBe("done");
		expect(contexts).toHaveLength(2);
		expectVersion(contexts[0]!, "v1");
		expectVersion(contexts[1]!, "v3");
		const placed = userTexts(contexts[1]!);
		expect(placed).toHaveLength(3);
		expect(placed[0]).toContain("PDF body v1");
		expect(placed[1]).toContain("PDF body v2");
		expect(placed[2]).toContain("PDF body v3");
		expect(placed.join("\n")).not.toContain("PDF body v4");
		const steerRecord = await steer.status(runtime.context);
		const followRecord = await follow.status(runtime.context);
		expect(followRecord.entry!).toBeGreaterThan(steerRecord.entry!);
	} finally {
		release.resolve();
		started.resolve();
		await runtime.close();
	}
}, 30_000);

it("persists skill display data without reparsing XML or rereading the source on restart", async () => {
	const home = directory(),
		workspace = directory();
	const body = 'Body </skill> with <tag value="x">';
	const args = "args </skill> <xml>";
	writeSkill(workspace, "literal", "Literal XML", "", body);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
	const options = {
		storagePath: join(workspace, "history.sqlite"),
		cwd: workspace,
		promptHome: home,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	};
	let runtime = await createNekoRuntime(options);
	try {
		await runtime.waitAnswer(await runtime.submit(`/skill:literal ${args}`, { requestId: "literal" }));
		writeSkill(workspace, "literal", "Changed", "", "new body");
		await runtime.submit(`/skill:literal changed`, { requestId: "literal" });
		await runtime.close();
		runtime = await createNekoRuntime(options);
		const state = await runtime.follow();
		const { projectChatView } = await import("../src/projection.ts");
		const item = projectChatView(state.value, "test").items.find((item) => item.type === "user")!;
		expect(item.type === "user" && item.skill).toMatchObject({
			name: "literal",
			body: expect.stringContaining(body),
			args,
		});
		state.dispose();
		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		await runtime.waitAnswer(await runtime.submit('<skill name="manual">plain XML</skill>'));
		const manual = await runtime.follow();
		const latest = projectChatView(manual.value, "test")
			.items.filter((item) => item.type === "user")
			.at(-1)!;
		expect(latest.type === "user" && latest.skill).toBeUndefined();
		manual.dispose();
	} finally {
		await runtime.close();
	}
});
