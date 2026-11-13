import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { rm } from "../../../test/temp-dir.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import type { SearchProviderId } from "../src/search-providers.ts";
import { createDeepseekProvider } from "../src/web-search/deepseek.ts";
import type { WebFetch } from "../src/web-search/index.ts";
import { createWebSearchTools } from "../src/web-search/index.ts";
import { createTavilyProvider } from "../src/web-search/tavily.ts";

const api = undefined as never;
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function routing(selected: () => SearchProviderId, deepseekKey: string | undefined) {
	const urls: string[] = [];
	const headers: Record<string, string>[] = [];
	const fetchImpl: WebFetch = async (url, init) => {
		urls.push(url);
		headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
		return new Response(JSON.stringify({ results: [] }));
	};
	const tavily = createTavilyProvider(async () => undefined, fetchImpl);
	const deepseek = createDeepseekProvider(async () => deepseekKey, fetchImpl);
	const tools = createWebSearchTools(async () => (selected() === "deepseek" ? deepseek : tavily));
	const search: ToolRegistration = tools.tools!.find((tool) => tool.name === "web_search")!;
	return { urls, headers, search };
}

it("routes each call to the selected provider and never falls back", async () => {
	let selected: SearchProviderId = "tavily";
	const withKey = routing(() => selected, "sk-test");
	await withKey.search.execute({ query: "q" }, api, context);
	expect(withKey.urls).toEqual(["https://api.tavily.com/search"]);
	expect(withKey.headers[0]!.authorization).toBeUndefined();
	selected = "deepseek";
	await withKey.search.execute({ query: "q" }, api, context);
	expect(withKey.urls[1]).toBe("https://api.deepseek.com/v1/tools/search");

	const missing = routing(() => "deepseek", undefined);
	const result = (await missing.search.execute({ query: "q" }, api, context)) as { isError?: boolean };
	expect(result.isError).toBe(true);
	expect(missing.urls).toEqual([]);
});

it("defaults to tavily and applies a saved choice without a restart", async () => {
	const runtime = await createNekoRuntime({ credentials: new InMemoryCredentialStore(), storage: "memory" });
	try {
		expect(await runtime.searchSettings()).toEqual({ selected: "tavily" });
		await runtime.setSearchProvider("deepseek");
		expect(await runtime.searchSettings()).toEqual({ selected: "deepseek" });
		await runtime.setSearchProvider("tavily");
		expect(await runtime.searchSettings()).toEqual({ selected: "tavily" });
	} finally {
		await runtime.close();
	}
});

it("uses the configured initial provider and persists the saved choice across restarts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "neko-search-"));
	dirs.push(dir);
	const open = (searchProvider?: SearchProviderId) =>
		createNekoRuntime({
			credentials: new InMemoryCredentialStore(),
			storagePath: join(dir, "neko.sqlite"),
			...(searchProvider !== undefined ? { searchProvider } : {}),
		});
	let runtime = await open("deepseek");
	expect((await runtime.searchSettings()).selected).toBe("deepseek");
	await runtime.setSearchProvider("tavily");
	await runtime.close();
	runtime = await open("deepseek");
	try {
		expect((await runtime.searchSettings()).selected).toBe("tavily");
	} finally {
		await runtime.close();
	}
});

it("rejects unknown providers (including the retired auto) and keeps the previous choice", async () => {
	const runtime = await createNekoRuntime({ credentials: new InMemoryCredentialStore(), storage: "memory" });
	try {
		await runtime.setSearchProvider("deepseek");
		for (const value of ["auto", "bing"])
			await expect(runtime.setSearchProvider(value as SearchProviderId)).rejects.toThrow("Unknown search provider");
		expect((await runtime.searchSettings()).selected).toBe("deepseek");
	} finally {
		await runtime.close();
	}
});
