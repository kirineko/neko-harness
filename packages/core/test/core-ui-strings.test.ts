import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/index.ts";
import { PLAN_BUSY } from "../src/plan.ts";
import { projectChatView } from "../src/projection.ts";
import { WORKSPACE_BUSY, WORKSPACE_LAST, WORKSPACE_UNKNOWN } from "../src/workspace.ts";

interface Sample {
	id: string;
	text: string;
	params?: Record<string, string>;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/core-ui-strings.json", import.meta.url), "utf8")) as {
	status: Sample[];
	systemRows: Sample[];
	toolNotes: Sample[];
	errors: { code: string; text: string }[];
	webErrors: { code: string; text: string }[];
};

const USAGE = { totalTokens: 10, input: 8, output: 2, cacheRead: 0, cacheWrite: 0 };

function view(entries: unknown[], docs: Record<string, unknown> = {}): ConversationView {
	return { docs: { "pi.agent": { cwd: "/work/demo" }, ...docs }, entries } as unknown as ConversationView;
}

function status(live: Record<string, unknown>): string | null {
	return projectChatView(view([], { "pi.live": live }), "test/model").status;
}

/**
 * Pins the exact English strings core sends to the frontends. Web, TUI and Mobile map them to the UI language
 * (see ui-language); when a wording changes here, update this fixture and the three mapping tables together.
 */
describe("core UI strings contract", () => {
	it("keeps run status strings", () => {
		expect(status({ run: {}, generation: { attempt: 0 } })).toBe(fixture.status[0]?.text ?? null);
		expect(
			status({ run: {}, tools: [{ callId: "c1", name: "bash", status: "running" }], generation: { attempt: 0 } }),
		).toBe(fixture.status[1]?.text ?? null);
		expect(status({ run: {}, generation: { attempt: 1, retry: {} } })).toBe(fixture.status[2]?.text ?? null);
	});

	it("keeps system row strings", () => {
		const items = projectChatView(
			view([
				{ id: 1, kind: "pi.compaction" },
				{ id: 2, kind: "pi.reset" },
			]),
			"test/model",
		).items;
		expect(items.map((item) => (item.type === "system" ? item.text : null))).toEqual(
			fixture.systemRows.map((row) => row.text),
		);
	});

	it("keeps the tool note string", () => {
		const entries = [
			{
				id: 1,
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "c7", name: "write", arguments: { path: "a.ts", content: "x" } }],
						stopReason: "stop",
						usage: USAGE,
					},
				],
			},
		];
		const tool = projectChatView(view(entries), "test/model").items.find((item) => item.type === "tool");
		expect(tool?.type === "tool" ? tool.note : undefined).toBe(fixture.toolNotes[0]?.text);
	});

	it("keeps error strings and their code prefixes", async () => {
		const original = process.env.DEEPSEEK_API_KEY;
		delete process.env.DEEPSEEK_API_KEY;
		const messages = new Map<string, string>();
		try {
			const keyless = await createNekoRuntime({ credentials: new InMemoryCredentialStore(), storage: "memory" });
			await keyless.submit("hello").catch((error: Error) => messages.set("PROVIDER_KEY_REQUIRED", error.message));
			await keyless.close();
		} finally {
			if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
		}
		const faux = fauxProvider({ provider: "openrouter" });
		faux.setResponses([fauxAssistantMessage([fauxText("x")])]);
		const disabled = await createNekoRuntime({
			storage: "memory",
			credentials: new InMemoryCredentialStore(),
			providers: [faux.provider],
			model: { provider: "openrouter", modelId: "faux-1" },
		});
		try {
			await disabled.submit("hi").catch((error: Error) => messages.set("PROVIDER_DISABLED", error.message));
		} finally {
			await disabled.close();
		}
		messages.set("PLAN_BUSY", PLAN_BUSY);
		messages.set("WORKSPACE_UNKNOWN", WORKSPACE_UNKNOWN);
		messages.set("WORKSPACE_LAST", WORKSPACE_LAST);
		messages.set("WORKSPACE_BUSY", WORKSPACE_BUSY);
		for (const { code, text } of [...fixture.errors, ...fixture.webErrors]) {
			expect(messages.get(code)).toBe(text);
			expect(text.startsWith(`${code}:`)).toBe(true);
		}
	});
});
