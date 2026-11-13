import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createWebSearchTools, type WebFetch } from "../src/web-search/index.ts";
import { createTavilyProvider } from "../src/web-search/tavily.ts";

type TavilyFetch = WebFetch;

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function harness(handler: (call: Call) => unknown) {
	const calls: Call[] = [];
	const fetchImpl: TavilyFetch = async (input, init) => {
		const call: Call = {
			url: input,
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: JSON.parse(String(init?.body)),
		};
		calls.push(call);
		return handler(call) as unknown as globalThis.Response;
	};
	return { calls, fetchImpl };
}

function tools(resolveKey: () => Promise<string | undefined>, fetchImpl: TavilyFetch) {
	const extension = createWebSearchTools(async () => createTavilyProvider(resolveKey, fetchImpl));
	const find = (name: string): ToolRegistration => extension.tools!.find((tool) => tool.name === name)!;
	return { search: find("web_search"), extract: find("web_extract") };
}

// Tools ignore the execution api; a placeholder keeps the call site honest.
const api = undefined as never;

function textOf(result: unknown): string {
	const content = (result as { output: { type: string; text?: string }[] }).output;
	return content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("");
}

it("sends the keyless header without a key and the bearer header with one", async () => {
	const ok = new Response(JSON.stringify({ results: [] }));
	const keyless = harness(() => ok.clone());
	const withoutKey = tools(async () => undefined, keyless.fetchImpl);
	await withoutKey.search.execute({ query: "weather" }, api, context);
	expect(keyless.calls[0]!.headers["x-tavily-access-mode"]).toBe("keyless");
	expect(keyless.calls[0]!.headers.authorization).toBeUndefined();
	expect(keyless.calls[0]!.body.max_results).toBe(5);

	const keyed = harness(() => ok.clone());
	const withKey = tools(async () => "tvly-test", keyed.fetchImpl);
	await withKey.search.execute({ query: "weather", maxResults: 99 }, api, context);
	expect(keyed.calls[0]!.headers.authorization).toBe("Bearer tvly-test");
	expect(keyed.calls[0]!.headers["x-tavily-access-mode"]).toBeUndefined();
	expect(keyed.calls[0]!.body.max_results).toBe(10);
});

it("passes through Tavily rate-limit guidance as a tool error without leaking the key", async () => {
	const { calls, fetchImpl } = harness(
		() =>
			new Response("Keyless rate limit reached. Create a free API key at https://app.tavily.com to continue.", {
				status: 429,
			}),
	);
	const { search } = tools(async () => undefined, fetchImpl);
	const result = (await search.execute({ query: "news" }, api, context)) as { isError?: boolean };
	expect(result.isError).toBe(true);
	const text = textOf(result);
	expect(text).toContain("429");
	expect(text).toContain("Keyless rate limit reached");
	expect(text).toContain("keyless");
	void calls;
});

it("returns ranked search results with bounded per-source content", async () => {
	const long = "x".repeat(5000);
	const { fetchImpl } = harness(
		() =>
			new Response(
				JSON.stringify({
					results: [
						{ title: "First", url: "https://a.example", content: long, score: 0.9 },
						{ title: "Second", url: "https://b.example", content: "short", score: 0.5 },
					],
				}),
			),
	);
	const { search } = tools(async () => undefined, fetchImpl);
	const result = await search.execute({ query: "q" }, api, context);
	const text = textOf(result);
	expect(text).toContain("1. First\nhttps://a.example");
	expect(text).toContain("2. Second\nhttps://b.example");
	expect(text).not.toContain(long);
	expect(text.length).toBeLessThan(6000);
});

it("extracts content and reports per-URL failures without failing the call", async () => {
	const { calls, fetchImpl } = harness(
		() =>
			new Response(
				JSON.stringify({
					results: [{ url: "https://a.example", raw_content: "page content" }],
					failed_results: [{ url: "https://b.example", error: "unreachable" }],
				}),
			),
	);
	const { extract } = tools(async () => undefined, fetchImpl);
	const result = (await extract.execute({ urls: ["https://a.example", "https://b.example"] }, api, context)) as {
		isError?: boolean;
	};
	expect(calls[0]!.url).toBe("https://api.tavily.com/extract");
	expect(calls[0]!.body.urls).toEqual(["https://a.example", "https://b.example"]);
	expect(result.isError).toBeUndefined();
	const text = textOf(result);
	expect(text).toContain("page content");
	expect(text).toContain("Extraction failed: unreachable");
});

it("surfaces network failures as tool errors", async () => {
	const fetchImpl: TavilyFetch = async () => {
		throw new Error("connection refused");
	};
	const { search } = tools(async () => undefined, fetchImpl);
	const result = (await search.execute({ query: "q" }, api, context)) as { isError?: boolean };
	expect(result.isError).toBe(true);
	expect(textOf(result)).toContain("Check the connection");
});

it("cancels an in-flight request and does not start requests for an already cancelled context", async () => {
	const controller = new AbortController();
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	let signal: AbortSignal | undefined;
	let calls = 0;
	const { search } = tools(
		async () => undefined,
		async (_url, init) => {
			calls++;
			signal = init!.signal!;
			began();
			return new Promise((_resolve, reject) =>
				signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
			);
		},
	);
	const ctx = withAbortSignal(controller.signal, context);
	const pending = search.execute({ query: "q" }, api, ctx);
	await started;
	controller.abort();
	expect(textOf(await pending)).toContain("cancelled");
	expect(signal!.aborted).toBe(true);
	expect(textOf(await search.execute({ query: "q" }, api, ctx))).toContain("cancelled");
	expect(calls).toBe(1);
});

it("cancels a response body still streaming after headers", async () => {
	const controller = new AbortController();
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const { search } = tools(
		async () => undefined,
		async () => {
			began();
			return new Response(body);
		},
	);
	const pending = search.execute({ query: "q" }, api, withAbortSignal(controller.signal, context));
	await started;
	controller.abort();
	expect(textOf(await pending)).toContain("cancelled");
	expect(cancelled).toBe(true);
});

it("redacts echoed keys before truncation and hides arbitrary transport and credential errors", async () => {
	const key = "tvly-review-FAKE-SECRET";
	for (const fetchImpl of [
		async () => new Response(`Invalid key ${key} ${encodeURIComponent(key)}`, { status: 401 }),
		async () => {
			throw new Error(`network error ${key}`);
		},
	] as TavilyFetch[]) {
		const { search } = tools(async () => key, fetchImpl);
		const result = await search.execute({ query: "q" }, api, context);
		expect(textOf(result)).not.toContain(key);
		expect((result as { isError?: boolean }).isError).toBe(true);
	}
	const { search } = tools(
		async () => {
			throw new Error(key);
		},
		async () => new Response("{}"),
	);
	expect(textOf(await search.execute({ query: "q" }, api, context))).not.toContain(key);
});

it("preserves every URL outcome even when successful excerpts fill the output budget", async () => {
	const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`);
	const { extract } = tools(
		async () => undefined,
		async () =>
			new Response(
				JSON.stringify({
					results: urls.slice(0, 19).map((url) => ({ url, raw_content: "x".repeat(10000) })),
					failed_results: [{ url: urls[19], error: "unreachable" }],
				}),
			),
	);
	const result = await extract.execute({ urls }, api, context);
	const text = textOf(result);
	for (const url of urls) expect(text).toContain(url);
	expect(text).toContain("Extraction failed: unreachable");
	expect(text.length).toBeLessThanOrEqual(12000);
});

it("rejects oversized responses both with and without content-length, cancelling the body", async () => {
	for (const declared of [true, false]) {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
			},
			cancel() {
				cancelled = true;
			},
		});
		const { search } = tools(
			async () => undefined,
			async () => new Response(body, { headers: declared ? { "content-length": "2097153" } : {} }),
		);
		expect(textOf(await search.execute({ query: "q" }, api, context))).toContain("2 MiB limit");
		expect(cancelled).toBe(true);
	}
});

it("rejects invalid inputs before sending and rejects malformed provider responses", async () => {
	let calls = 0;
	const { search, extract } = tools(
		async () => undefined,
		async () => {
			calls++;
			return new Response('{"results":null}');
		},
	);
	for (const urls of [
		[],
		Array(21).fill("https://example.com"),
		["file:///tmp/test"],
		["https://user:secret@example.com"],
	]) {
		expect(((await extract.execute({ urls }, api, context)) as { isError?: boolean }).isError).toBe(true);
	}
	expect(((await search.execute({ query: " " }, api, context)) as { isError?: boolean }).isError).toBe(true);
	expect(calls).toBe(0);
	expect(textOf(await search.execute({ query: "q" }, api, context))).toContain("Invalid Tavily response");
});

it("matches equivalent URL serialization without conflating distinct paths", async () => {
	const { fetchImpl } = harness(
		() =>
			new Response(
				JSON.stringify({
					results: [{ url: "https://example.com/", raw_content: "Home page" }],
					failed_results: [{ url: "https://example.com/path", error: "Unavailable" }],
				}),
			),
	);
	const { extract } = tools(async () => undefined, fetchImpl);
	const result = await extract.execute(
		{ urls: ["https://EXAMPLE.com:443", "https://example.com/path", "https://example.com/path/"] },
		api,
		context,
	);
	const text = textOf(result);
	expect(text).toContain("Home page");
	expect(text).toContain("Extraction failed: Unavailable");
	expect(text).toContain("Extraction failed: No result returned for this URL");
});
