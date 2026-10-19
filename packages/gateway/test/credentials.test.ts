import { expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "../../../test/temp-dir.ts";
import { startGateway } from "../src/index.ts";
import { connectTestClient, connectTestWsClient, testSocketPath, waitFor as wait } from "./helpers.ts";

const waitFor = (predicate: () => boolean) => wait(predicate, "credential synchronization");

it("shares private credential state and Pi configuration across Unix and WebSocket, including restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-credential-gateway-"));
	const old = process.env.DEEPSEEK_API_KEY;
	const oldTavily = process.env.TAVILY_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
	delete process.env.TAVILY_API_KEY;
	const options = {
		storage: "memory" as const,
		storagePath: join(dir, "neko.sqlite"),
		credentialsPath: join(dir, "credentials.json"),
		socketPath: testSocketPath(dir),
		port: 0,
		serverId: crypto.randomUUID(),
	};
	let gateway = await startGateway(options);
	let unix = await connectTestClient(gateway);
	let web = await connectTestWsClient(gateway);
	try {
		await waitFor(() => !!web.credentials.state.value);
		expect(web.credentials.state.value!.statuses.deepseek?.source).toBe("none");
		expect(web.credentials.state.value!.statuses.tavily?.source).toBe("keyless");
		const initial = (await gateway.runtime.listConversations())[0]!;
		const initialChat = await unix.attach(String(initial.id));
		await expect(initialChat.submit({ content: "no key" })).rejects.toThrow("PROVIDER_KEY_REQUIRED");
		expect((await gateway.runtime.listConversations())[0]!.lastMessageAt).toBeNull();
		await unix.detach();
		await unix.credentials.save({ provider: "deepseek", key: "test-private-value" });
		await waitFor(() => web.credentials.state.value?.statuses.deepseek?.source === "saved");
		expect(JSON.stringify(web.credentials.state.value)).not.toContain("test-private-value");
		await expect(web.credentials.save({ provider: "deepseek", key: " " })).rejects.toThrow();
		expect(web.credentials.state.value!.statuses.deepseek?.source).toBe("saved");
		const contents = await readFile(options.credentialsPath, "utf8");
		const revision = web.credentials.state.value!.revision;
		await writeFile(options.credentialsPath, "invalid-file-test-secret");
		await expect(unix.credentials.save({ provider: "deepseek", key: "test-rejected-secret" })).rejects.toThrow(
			"Cannot save API key",
		);
		expect(web.credentials.state.value!.revision).toBe(revision);
		expect(await readFile(options.credentialsPath, "utf8")).toBe("invalid-file-test-secret");
		await writeFile(options.credentialsPath, contents);
		const session = await unix.management.create({});
		const a = await unix.attach(session.id),
			b = await web.attach(session.id);
		await waitFor(() => !!b.view.value);
		expect(b.view.value!.agent.thinkingLevel).toBe("high");
		await a.configure({ thinkingLevel: "low" });
		await b.configure({ model: { provider: "deepseek", modelId: "deepseek-v4-pro" } });
		await waitFor(
			() => a.view.value?.agent.model?.modelId === "deepseek-v4-pro" && a.view.value?.agent.thinkingLevel === "high",
		);
		expect((await web.models.list(null)).find((m) => m.modelId === "deepseek-v4-pro")!.supportedThinkingLevels).toEqual(
			["off", "high", "max"],
		);
		await unix.close();
		await web.close();
		await gateway.close();
		gateway = await startGateway(options);
		unix = await connectTestClient(gateway);
		web = await connectTestWsClient(gateway);
		await waitFor(() => web.credentials.state.value?.statuses.deepseek?.source === "saved");
		process.env.DEEPSEEK_API_KEY = "test-env";
		await web.credentials.remove({ provider: "deepseek" });
		await waitFor(() => unix.credentials.state.value?.statuses.deepseek?.source === "environment");
		expect(unix.credentials.state.value!.statuses.deepseek?.environmentConfigured).toBe(true);
		await web.credentials.save({ provider: "tavily", key: "test-tavily-value" });
		await waitFor(() => unix.credentials.state.value?.statuses.tavily?.source === "saved");
		expect(unix.credentials.state.value!.statuses.deepseek?.source).toBe("environment");
		await Promise.all([
			unix.credentials.save({ provider: "deepseek", key: "test-a" }),
			web.credentials.save({ provider: "deepseek", key: "test-b" }),
		]);
		await waitFor(
			() =>
				unix.credentials.state.value?.revision === web.credentials.state.value?.revision &&
				unix.credentials.state.value?.statuses.deepseek?.source === "saved",
		);
	} finally {
		await unix.close();
		await web.close();
		await gateway.close();
		await rm(dir, { recursive: true, force: true });
		if (old === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = old;
		if (oldTavily === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = oldTavily;
	}
});
