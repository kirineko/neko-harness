import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createDeepseekProvider } from "../src/web-search/deepseek.ts";
import { createWebSearchTools, type WebFetch } from "../src/web-search/index.ts";

const api = undefined as never;
const KEY = "sk-test-FAKE-SECRET";

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function setup(handler: (call: Call) => Response | Promise<Response>, key: string | null = KEY) {
	const calls: Call[] = [];
	const sleeps: number[] = [];
	const fetchImpl: WebFetch = async (input, init) => {
		const call: Call = {
			url: input,
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: JSON.parse(String(init?.body)),
		};
		calls.push(call);
		return handler(call);
	};
	const provider = createDeepseekProvider(async () => key ?? undefined, fetchImpl, {
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	const extension = createWebSearchTools(async () => provider);
	const find = (name: string): ToolRegistration => extension.tools!.find((tool) => tool.name === name)!;
	return { calls, sleeps, search: find("web_search"), extract: find("web_extract") };
}

function textOf(result: unknown): string {
	const content = (result as { output: { type: string; text?: string }[] }).output;
	return content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("");
}
const isError = (result: unknown) => (result as { isError?: boolean }).isError === true;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const apiError = (status: number, message = "failed") =>
	json({ error: { message, type: "invalid_request_error", param: null, code: "x" } }, status);

it("searches with the DeepSeek key and maps summaries and dates", async () => {
	const { calls, search } = setup(() =>
		json({
			results: [
				{
					rerank_score: 2.4,
					title: "First",
					url: "https://a.example",
					snippet: "short",
					summary: "long summary",
					content: "",
					date: "2026-06-01T00:00:00+00:00",
					authority: 3,
				},
				{ title: "Second", url: "https://b.example", snippet: "only snippet", summary: "", date: null },
			],
		}),
	);
	const result = await search.execute({ query: "DeepSeek V4", maxResults: 99 }, api, context);
	expect(isError(result)).toBe(false);
	expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/tools/search");
	expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
	expect(calls[0]!.body).toEqual({ query: "DeepSeek V4", count: 10, need_content: false });
	const text = textOf(result);
	expect(text).toContain("1. First\nhttps://a.example\nPublished: 2026-06-01\nlong summary");
	expect(text).toContain("2. Second\nhttps://b.example\nonly snippet");
	expect(text).not.toContain("Published: null");
});

it("bounds search output and reports empty results without an error", async () => {
	const long = "x".repeat(5000);
	const { search } = setup(() => json({ results: [{ title: "A", url: "https://a.example", summary: long }] }));
	expect(textOf(await search.execute({ query: "q" }, api, context)).length).toBeLessThan(2300);
	const empty = setup(() => json({ results: [] }));
	const result = await empty.search.execute({ query: "q" }, api, context);
	expect(isError(result)).toBe(false);
	expect(textOf(result)).toBe("No results.");
});

it("rejects blank and over-long queries before any request, counting characters not bytes", async () => {
	const { calls, search } = setup(() => json({ results: [] }));
	expect(isError(await search.execute({ query: "  " }, api, context))).toBe(true);
	const tooLong = await search.execute({ query: "查".repeat(129) }, api, context);
	expect(isError(tooLong)).toBe(true);
	expect(textOf(tooLong)).toContain("128 characters");
	expect(calls).toHaveLength(0);
	expect(isError(await search.execute({ query: "查".repeat(128) }, api, context))).toBe(false);
	expect(calls).toHaveLength(1);
});

it("fails with configuration guidance and no request when the DeepSeek key is missing", async () => {
	const { calls, search, extract } = setup(() => json({ results: [] }), null);
	for (const result of [
		await search.execute({ query: "q" }, api, context),
		await extract.execute({ urls: ["https://a.example"] }, api, context),
	]) {
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain("/login");
		expect(textOf(result)).toContain("Tavily");
	}
	expect(calls).toHaveLength(0);
});

it("maps HTTP errors to actionable messages without echoing the key", async () => {
	for (const [status, expected] of [
		[401, "missing or invalid"],
		[402, "balance"],
		[429, "rate limit"],
		[500, "service error"],
	] as const) {
		const { search } = setup(() => apiError(status, `bad key ${KEY} ${encodeURIComponent(KEY)}`));
		const result = await search.execute({ query: "q" }, api, context);
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain(expected);
		expect(textOf(result)).not.toContain(KEY);
	}
	const bad = setup(() => apiError(400, `invalid ${KEY}`));
	const text = textOf(await bad.search.execute({ query: "q" }, api, context));
	expect(text).toContain("400");
	expect(text).not.toContain(KEY);
	const thrown = createWebSearchTools(async () =>
		createDeepseekProvider(
			async () => KEY,
			async () => {
				throw new Error(`network ${KEY}`);
			},
		),
	).tools!.find((tool) => tool.name === "web_search")! as ToolRegistration;
	const failure = await thrown.execute({ query: "q" }, api, context);
	expect(isError(failure)).toBe(true);
	expect(textOf(failure)).not.toContain(KEY);
});

it("rejects malformed search responses", async () => {
	const { search } = setup(() => json({ results: null }));
	expect(textOf(await search.execute({ query: "q" }, api, context))).toContain("Invalid DeepSeek response");
});

it("extracts every URL in order and reports per-URL failures without failing the call", async () => {
	const { calls, extract } = setup((call) => {
		const url = call.body.url;
		if (url === "https://b.example/") return apiError(404);
		if (url === "https://c.example/") return apiError(403);
		return json({ title: "T", content: `content of ${url}` });
	});
	const urls = ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"];
	const result = await extract.execute({ urls }, api, context);
	expect(isError(result)).toBe(false);
	const text = textOf(result);
	expect(text.indexOf("content of https://a.example/")).toBeGreaterThan(-1);
	expect(text).toContain("Extraction failed: DeepSeek could not fetch a usable page");
	expect(text).toContain("Extraction failed: DeepSeek blocked this request");
	expect(text.indexOf("content of https://d.example/")).toBeGreaterThan(text.indexOf("## 3."));
	expect(calls.every((call) => call.url === "https://api.deepseek.com/v1/tools/fetch")).toBe(true);
	expect(calls).toHaveLength(4);
});

it("retries rate limits with backoff, then succeeds or reports the URL as failed", async () => {
	let attempts = 0;
	const recovering = setup(() => (++attempts < 3 ? apiError(429) : json({ title: "", content: "recovered" })));
	const ok = await recovering.extract.execute({ urls: ["https://a.example/"] }, api, context);
	expect(textOf(ok)).toContain("recovered");
	expect(recovering.sleeps).toEqual([250, 750]);
	expect(recovering.calls).toHaveLength(3);

	const exhausted = setup(() => apiError(429));
	const result = await exhausted.extract.execute({ urls: ["https://a.example/", "https://b.example/"] }, api, context);
	expect(isError(result)).toBe(false);
	expect(textOf(result).match(/Extraction failed: DeepSeek rate limit reached/g)).toHaveLength(2);
	expect(exhausted.calls).toHaveLength(6);

	const transient = setup((call) =>
		call.body.url === "https://a.example/" ? apiError(503) : json({ content: "fine" }),
	);
	const mixed = textOf(
		await transient.extract.execute({ urls: ["https://a.example/", "https://b.example/"] }, api, context),
	);
	expect(mixed).toContain("service error (503)");
	expect(mixed).toContain("fine");
});

it("does not retry client errors and fails the whole call on credential or balance errors", async () => {
	const notFound = setup(() => apiError(404));
	await notFound.extract.execute({ urls: ["https://a.example/"] }, api, context);
	expect(notFound.calls).toHaveLength(1);
	expect(notFound.sleeps).toEqual([]);

	for (const [status, expected] of [
		[401, "missing or invalid"],
		[402, "balance"],
	] as const) {
		const { calls, sleeps, extract } = setup(() => apiError(status));
		const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
		const result = await extract.execute({ urls }, api, context);
		expect(isError(result)).toBe(true);
		expect(textOf(result)).toContain(expected);
		expect(sleeps).toEqual([]);
		// No new URLs are started after the fatal error; only already running workers finish.
		expect(calls.length).toBeLessThanOrEqual(3);
	}
});

it("limits concurrent fetches", async () => {
	let active = 0;
	let peak = 0;
	const { extract } = setup(async () => {
		peak = Math.max(peak, ++active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return json({ content: "ok" });
	});
	const urls = Array.from({ length: 12 }, (_, i) => `https://example.com/${i}`);
	expect(isError(await extract.execute({ urls }, api, context))).toBe(false);
	expect(peak).toBe(3);
});

it("cancels fetches when the context is cancelled", async () => {
	const controller = new AbortController();
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const provider = createDeepseekProvider(
		async () => KEY,
		async (_url, init) => {
			began();
			return new Promise((_resolve, reject) =>
				init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
			);
		},
	);
	const { tools } = createWebSearchTools(async () => provider);
	const extract: ToolRegistration = tools!.find((tool) => tool.name === "web_extract")!;
	const pending = extract.execute({ urls: ["https://a.example/"] }, api, withAbortSignal(controller.signal, context));
	await started;
	controller.abort();
	const result = await pending;
	expect(isError(result)).toBe(true);
	expect(textOf(result)).toContain("cancelled");
});
