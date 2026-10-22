import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "../../../test/temp-dir.ts";
import { FileCredentialStore, InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
it("serializes file stores, persists private credentials and preserves invalid files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-credentials-"));
	paths.push(dir);
	const path = join(dir, "credentials.json");
	const a = new FileCredentialStore(path),
		b = new FileCredentialStore(path);
	await Promise.all([
		a.modify("a", async () => ({ type: "api_key", key: "test-a" })),
		b.modify("b", async () => ({ type: "api_key", key: "test-b" })),
	]);
	expect((await new FileCredentialStore(path).list()).length).toBe(2);
	// Windows reports ACL-backed modes, not the POSIX 0600 bit the store requests.
	if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
	await b.delete("a");
	expect(await a.read("a")).toBeUndefined();
	await writeFile(path, "broken-secret");
	await expect(a.modify("b", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow(
		"Cannot update credential storage",
	);
	expect(await readFile(path, "utf8")).toBe("broken-secret");
});
it("boots without a key, preserves input state and uses Pi capabilities and defaults", async () => {
	const old = process.env.DEEPSEEK_API_KEY;
	delete process.env.DEEPSEEK_API_KEY;
	const runtime = await createNekoRuntime({ storage: "memory" });
	try {
		expect((await runtime.getAgent()).thinkingLevel).toBe("high");
		const before = await runtime.listConversations();
		await expect(runtime.submit("hello")).rejects.toThrow("PROVIDER_KEY_REQUIRED");
		expect(await runtime.listConversations()).toEqual(before);
		expect((await runtime.listSelectableModels()).map((m) => m.supportedThinkingLevels)).toEqual([
			["off", "low", "high", "max"],
			["off", "high", "max"],
		]);
		await runtime.configureConversation(runtime.conversation.id, { thinkingLevel: "low" });
		await runtime.configureConversation(runtime.conversation.id, {
			model: { provider: "deepseek", modelId: "deepseek-v4-pro" },
		});
		expect((await runtime.getAgent()).thinkingLevel).toBe("high");
		await runtime.saveCredential("deepseek", "test-saved");
		expect((await runtime.credentialStatus("deepseek")).source).toBe("saved");
		process.env.DEEPSEEK_API_KEY = "test-env";
		expect(await runtime.credentialStatus("deepseek")).toEqual({
			savedConfigured: true,
			environmentConfigured: true,
			source: "saved",
		});
		await expect(runtime.saveCredential("deepseek", "  ")).rejects.toThrow();
		await expect(runtime.credentialStatus("unknown" as never)).rejects.toThrow("Unknown credential provider");
		await runtime.removeCredential("deepseek");
		expect((await runtime.credentialStatus("deepseek")).source).toBe("environment");
	} finally {
		await runtime.close();
		if (old === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = old;
	}
});
it("does not mutate the environment for explicit runtime keys", async () => {
	const before = process.env.DEEPSEEK_API_KEY;
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		apiKey: "test-override",
	});
	try {
		await runtime.saveCredential("deepseek", "test-saved");
		expect((await runtime.credentialStatus("deepseek")).source).toBe("runtime");
		expect(process.env.DEEPSEEK_API_KEY).toBe(before);
	} finally {
		await runtime.close();
	}
});

it("resolves saved, rotated and environment keys on actual Pi requests without network", async () => {
	const originalFetch = globalThis.fetch,
		old = process.env.DEEPSEEK_API_KEY;
	process.env.DEEPSEEK_API_KEY = "test-environment";
	const requests: { auth: string | null; body: Record<string, unknown> }[] = [];
	globalThis.fetch = Object.assign(
		async (_input: unknown, init?: RequestInit) => {
			requests.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
			const chunk = {
				id: "test",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-flash",
				choices: [{ index: 0, delta: { role: "assistant", content: "Test answer" }, finish_reason: null }],
			};
			const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	const runtime = await createNekoRuntime({ storage: "memory" });
	try {
		await runtime.saveCredential("deepseek", "test-saved");
		const first = await runtime.submit("first", { requestId: "first" });
		await runtime.waitAnswer(first);
		for (let i = 0; i < 100 && !(await runtime.listConversations())[0]?.title; i++) await Bun.sleep(10);
		expect(requests[0]!.auth).toBe("Bearer test-saved");
		expect(requests[0]!.body.reasoning_effort).toBe("high");
		expect(requests[1]!.body.thinking).toEqual({ type: "disabled" });
		await runtime.saveCredential("deepseek", "test-rotated");
		await runtime.waitAnswer(await runtime.submit("second"));
		expect(requests.at(-1)!.auth).toBe("Bearer test-rotated");
		await runtime.removeCredential("deepseek");
		await runtime.waitAnswer(await runtime.submit("third"));
		expect(requests.at(-1)!.auth).toBe("Bearer test-environment");
		delete process.env.DEEPSEEK_API_KEY;
		const requestCount = requests.length;
		expect((await runtime.submit("ignored replay", { requestId: "first" })).id).toBe(first.id);
		expect(requests).toHaveLength(requestCount);
		expect(JSON.stringify(await runtime.viewState())).not.toContain("test-saved");
	} finally {
		await runtime.close();
		globalThis.fetch = originalFetch;
		if (old === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = old;
	}
});

it("manages per-provider credentials independently, with keyless fallback for tavily", async () => {
	const old = process.env.TAVILY_API_KEY;
	delete process.env.TAVILY_API_KEY;
	const runtime = await createNekoRuntime({ storage: "memory" });
	try {
		expect(await runtime.credentialStatus("tavily")).toEqual({
			savedConfigured: false,
			environmentConfigured: false,
			source: "keyless",
		});
		await runtime.saveCredential("tavily", "test-tavily");
		expect((await runtime.credentialStatus("tavily")).source).toBe("saved");
		expect((await runtime.credentialStatus("deepseek")).savedConfigured).toBe(false);
		process.env.TAVILY_API_KEY = "test-tavily-env";
		expect(await runtime.credentialStatus("tavily")).toEqual({
			savedConfigured: true,
			environmentConfigured: true,
			source: "saved",
		});
		await runtime.removeCredential("tavily");
		expect((await runtime.credentialStatus("tavily")).source).toBe("environment");
		delete process.env.TAVILY_API_KEY;
		expect((await runtime.credentialStatus("tavily")).source).toBe("keyless");
	} finally {
		await runtime.close();
		if (old === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = old;
	}
});

it("applies the tavily runtime override without persisting or touching the environment", async () => {
	const before = process.env.TAVILY_API_KEY;
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		tavilyApiKey: "test-tavily-override",
	});
	try {
		expect((await runtime.credentialStatus("tavily")).source).toBe("runtime");
		await runtime.saveCredential("tavily", "test-saved");
		expect((await runtime.credentialStatus("tavily")).source).toBe("runtime");
		expect(process.env.TAVILY_API_KEY).toBe(before);
	} finally {
		await runtime.close();
	}
});

it("locks read-modify-write across processes and preserves callback rejections", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-process-credentials-"));
	paths.push(dir);
	const path = join(dir, "keys.json");
	const store = new FileCredentialStore(path);
	await store.modify("counter", async () => ({ type: "api_key", key: "0" }));
	const modulePath = fileURLToPath(new URL("../src/credentials.ts", import.meta.url));
	const code = `import { FileCredentialStore } from ${JSON.stringify(modulePath)}; const store = new FileCredentialStore(process.argv[1]); for(let i=0;i<3;i++) await store.modify("counter", async(value)=> { await Bun.sleep(10); return {type:"api_key", key:String(Number(value.key)+1)}; });`;
	const a = Bun.spawn([process.execPath, "-e", code, path], { stdout: "pipe", stderr: "pipe" });
	const b = Bun.spawn([process.execPath, "-e", code, path], { stdout: "pipe", stderr: "pipe" });
	expect(await a.exited).toBe(0);
	expect(await b.exited).toBe(0);
	expect((await store.read("counter"))?.type).toBe("api_key");
	expect(await store.read("counter")).toEqual({ type: "api_key", key: "6" });
	const failure = new Error("callback rejected");
	await expect(
		store.modify("counter", async () => {
			throw failure;
		}),
	).rejects.toBe(failure);
	expect(await store.read("counter")).toEqual({ type: "api_key", key: "6" });
});

it("reclaims a stale lock but never a fresh one", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-credentials-lock-"));
	paths.push(dir);
	const path = join(dir, "credentials.json");
	const lockPath = `${path}.lock`;
	const store = new FileCredentialStore(path, {}, { lockAttempts: 3, lockRetryMs: 5 });
	await writeFile(lockPath, "");
	const old = new Date(Date.now() - 60_000);
	await utimes(lockPath, old, old);
	await store.modify("a", async () => ({ type: "api_key", key: "test-a" }));
	expect(await store.read("a")).toEqual({ type: "api_key", key: "test-a" });
	await expect(stat(lockPath)).rejects.toThrow();

	await writeFile(lockPath, "");
	await expect(store.modify("b", async () => ({ type: "api_key", key: "test-b" }))).rejects.toThrow(
		"Credential storage is busy",
	);
	await stat(lockPath);
	expect(await store.read("b")).toBeUndefined();
});

it("keeps the original file and leaves no temp file when the replacement rename keeps failing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-credentials-rename-"));
	paths.push(dir);
	const path = join(dir, "credentials.json");
	await new FileCredentialStore(path).modify("a", async () => ({ type: "api_key", key: "test-a" }));
	const before = await readFile(path, "utf8");
	const store = new FileCredentialStore(path, {
		rename: async () => {
			throw Object.assign(new Error("busy"), { code: "EBUSY" });
		},
		sleep: async () => {},
	});
	await expect(store.modify("b", async () => ({ type: "api_key", key: "test-b" }))).rejects.toThrow(
		"Cannot update credential storage",
	);
	expect(await readFile(path, "utf8")).toBe(before);
	expect((await readdir(dir)).sort()).toEqual(["credentials.json"]);
});
