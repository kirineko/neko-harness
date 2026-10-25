import { expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "../../../test/faux.ts";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor as wait } from "./helpers.ts";

const waitFor = (predicate: () => boolean) => wait(predicate, "codemode settings synchronization");

async function start(dir: string, config?: string, extra: Record<string, unknown> = {}) {
	if (config !== undefined) await writeFile(join(dir, "neko.config.json"), config);
	return startGateway({
		configDir: dir,
		storage: "memory",
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
		...extra,
	});
}

it("synchronizes the codemode mode across clients, restores the default and rejects invalid values", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-codemode-gateway-"));
	const gateway = await start(dir);
	const unix = await connectTestClient(gateway);
	const web = await connectTestWsClient(gateway);
	try {
		await waitFor(() => !!web.codemodeSettings.state.value && !!unix.codemodeSettings.state.value);
		const initial = web.codemodeSettings.state.value!;
		expect(initial).toMatchObject({ effective: { mode: "off" }, source: "default" });

		await unix.codemodeSettings.set({ mode: "only" });
		await waitFor(() => web.codemodeSettings.state.value?.effective.mode === "only");
		expect(unix.codemodeSettings.state.value).toEqual(web.codemodeSettings.state.value);
		expect(web.codemodeSettings.state.value).toMatchObject({ source: "saved" });
		expect(web.codemodeSettings.state.value!.revision).toBeGreaterThan(initial.revision);

		const revision = web.codemodeSettings.state.value!.revision;
		await expect(web.codemodeSettings.set({ mode: "bogus" as never })).rejects.toThrow();
		await Bun.sleep(50);
		expect(web.codemodeSettings.state.value!.revision).toBe(revision);

		await web.codemodeSettings.reset({});
		await waitFor(() => unix.codemodeSettings.state.value?.source === "default");
		expect(unix.codemodeSettings.state.value!.effective.mode).toBe("off");
	} finally {
		await unix.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("takes the config file value and lets a saved value win over it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-codemode-gateway-"));
	const gateway = await start(dir, '{"codemode": {"mode": "on"}}');
	const client = await connectTestClient(gateway);
	try {
		await waitFor(() => !!client.codemodeSettings.state.value);
		expect(client.codemodeSettings.state.value).toMatchObject({ effective: { mode: "on" }, source: "config" });
		await client.codemodeSettings.set({ mode: "off" });
		await waitFor(() => client.codemodeSettings.state.value?.source === "saved");
		expect(client.codemodeSettings.state.value!.effective.mode).toBe("off");
		await client.codemodeSettings.reset({});
		await waitFor(() => client.codemodeSettings.state.value?.source === "config");
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
});

it("fails to start on an invalid codemode config and names the field", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-codemode-gateway-"));
	try {
		await expect(start(dir, '{"codemode": {"mode": "maybe"}}')).rejects.toThrow(/codemode\.mode/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

it("publishes the nested calls of a codemode script in the chat view", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-codemode-gateway-"));
	await writeFile(join(dir, "a.txt"), "hello");
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", {
					code: `const t = await tools.read({ path: ${JSON.stringify(join(dir, "a.txt"))} });\ntext(t);`,
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("done")]),
	]);
	const gateway = await start(dir, '{"codemode": {"mode": "on"}}', {
		cwd: dir,
		model: { provider: "faux", modelId: "faux-1" },
		providers: [faux.provider],
	});
	const client = await connectTestClient(gateway);
	try {
		const session = await client.management.create({});
		const chat = await client.attach(session.id);
		await chat.submit({ content: "read it" });
		await wait(
			() => chat.view.value?.items.some((item) => item.type === "assistant" && item.text === "done") ?? false,
			"codemode turn",
			30_000,
		);
		const tool = chat.view.value!.items.find((item) => item.type === "tool" && item.name === "codemode");
		expect(tool).toMatchObject({ type: "tool", phase: "done", isError: false });
		const view = (tool as { codemode?: { calls: { name: string; status: string }[]; omitted: number } }).codemode;
		expect(view?.omitted).toBe(0);
		expect(view?.calls.map((c) => [c.name, c.status])).toEqual([["read", "ok"]]);
	} finally {
		await client.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);
