// Pi 1.3 acceptance: upstream behavior changes neko relies on and must not regress or patch around.

import { expect, it } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { createNekoRuntime, projectChatView } from "../src/index.ts";

it("fails a tool call with malformed arguments before running it and shows the model what it sent", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-args-error-"));
	const faux = fauxProvider();
	const sent = String.raw`{"path":"never.txt","content":"\usepackage`;
	faux.setResponses([
		fauxAssistantMessage(
			[{ type: "toolCall", id: "call-bad", name: "write", arguments: {}, argumentsError: `Invalid JSON: ${sent}` }],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("understood")]),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		cwd: dir,
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("write it"));
		const state = await runtime.viewState();
		const tool = projectChatView(state.value, "test")
			.items.filter((item) => item.type === "tool")
			.at(-1)!;
		state.dispose();
		expect(tool.type === "tool" && tool.isError).toBe(true);
		expect(JSON.stringify(tool)).toContain("usepackage");
		await expect(stat(join(dir, "never.txt"))).rejects.toThrow();
	} finally {
		await runtime.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 15000);
