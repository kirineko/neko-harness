import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView, PromptInput } from "@earendil-works/pi-durable";
import { removeDirSync } from "../../../test/temp-dir.ts";
import { exportConversation } from "../src/conversation-export.ts";
import { NekoInput } from "../src/input.ts";
import { promptHistory } from "../src/input-history.ts";
import { projectChatView } from "../src/projection.ts";
import { createNekoPrompt } from "../src/prompt/prompt.ts";
import { createResourceLoader } from "../src/prompt/resources.ts";

const REPORT = "[job-1] failed (exit 2)\nboom";

const userEntry = (id: number, text: string, data?: unknown) => ({
	id,
	kind: NekoInput.kind,
	model: [{ role: "user", content: [{ type: "text", text }], timestamp: 0 }],
	...(data === undefined ? {} : { data }),
});
const view = (entries: unknown[]) =>
	({ docs: { "pi.agent": { cwd: "/work/demo" } }, entries }) as unknown as ConversationView;
const report = { jobId: "job-1", status: "failed", exitCode: 2 };

it("projects a job report as a system item with its jobId, never as a user item", () => {
	const { items } = projectChatView(
		view([
			userEntry(1, "start the server"),
			userEntry(2, REPORT, { at: 0, prompt: REPORT, images: [], jobReport: report }),
		]),
		"test/model",
	);
	expect(items.map((item) => item.type)).toEqual(["user", "system"]);
	expect(items[1]).toMatchObject({ type: "system", key: "e2", id: 2, text: REPORT, jobId: "job-1" });
});

it("keeps inputs without jobReport, including old data, as user items", () => {
	const { items } = projectChatView(
		view([userEntry(1, "plain"), userEntry(2, "typed", { at: 0, prompt: "typed", images: [] })]),
		"test/model",
	);
	expect(items.map((item) => item.type)).toEqual(["user", "user"]);
	expect(items.every((item) => !("jobId" in item))).toBe(true);
});

it("exports a job report through the system item path", async () => {
	const { items } = projectChatView(
		view([userEntry(1, "go"), userEntry(2, REPORT, { at: 0, prompt: REPORT, images: [], jobReport: report })]),
		"test/model",
	);
	const source = {
		sessionId: "s",
		title: "t",
		cwd: "/work/demo",
		model: "test/model",
		exportedAt: new Date(0),
		items,
	};
	const json = JSON.parse((await exportConversation("json", source, { includeThinking: false })).content);
	expect(json.items.at(-1)).toEqual({ type: "system", text: REPORT });
	const markdown = (await exportConversation("markdown", source, { includeThinking: false })).content;
	expect(markdown).toContain("boom");
});

it("leaves job reports out of the input history", () => {
	const { items } = projectChatView(
		view([
			userEntry(1, "first"),
			userEntry(2, REPORT, { at: 0, prompt: REPORT, images: [], jobReport: report }),
			userEntry(3, "second"),
		]),
		"test/model",
	);
	expect(promptHistory(items)).toEqual(["second", "first"]);
});

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) removeDirSync(d);
});
const rules = async (tools: string[]) => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "neko-prompt-")));
	dirs.push(home);
	const extension = createNekoPrompt((_id, workspace) =>
		createResourceLoader(home, undefined, { builtinDir: null })(workspace),
	);
	const section = extension.sections?.find((s) => s.key === "rules");
	const input = {
		agent: { cwd: home, tools: tools.map((name) => ({ name })), callable: [] },
		read: { snapshot: async () => ({ role: null, parentId: null }) },
	} as unknown as PromptInput;
	return (await section!.render(input, BACKGROUND_CONTEXT)) ?? "";
};

it("adds the job guideline only when the job tool is enabled, using its real parameter names", async () => {
	const withJob = await rules(["read", "job"]);
	expect(withJob).toContain('action:"start"');
	for (const name of ["command", "jobId", "since", "stop", "list", "output"]) expect(withJob).toContain(name);
	expect(withJob).toContain("no stdin");
	expect(await rules(["read"])).not.toContain("job");
});
