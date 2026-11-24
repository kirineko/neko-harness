import type { Context } from "@earendil-works/chord/context";
import { type KeyResolver, postJson, record, truncate, type WebFetch, WebToolError } from "./http.ts";
import type { ExtractOutcome, SearchHit, WebSearchProvider } from "./provider.ts";

const SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
export const DEEPSEEK_QUERY_MAX_CHARS = 128;
const FETCH_CONCURRENCY = 3;
const MAX_RETRIES = 2;
const BACKOFF_MS = [250, 750];

export const DEEPSEEK_MISSING_KEY =
	"DeepSeek API key is not configured. Save one with /login or in the Web settings, or switch the search provider to Tavily.";

export type DeepseekProviderOptions = {
	/** Wait between retries; replaceable so tests need no real delay. Must reject when `signal` aborts. */
	readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
};

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

function apiMessage(text: string): string {
	try {
		const data: unknown = JSON.parse(text);
		if (record(data) && record(data.error) && typeof data.error.message === "string")
			return truncate(data.error.message, 300);
	} catch {}
	return truncate(text, 300);
}

function httpError(status: number, text: string): WebToolError {
	const guidance = "Check the key in /login or the Web settings, or switch the search provider.";
	if (status === 401) return new WebToolError(`DeepSeek API key is missing or invalid. ${guidance}`, status);
	if (status === 402)
		return new WebToolError(
			"DeepSeek account balance is insufficient. Recharge, or switch the search provider to Tavily.",
			status,
		);
	if (status === 403) return new WebToolError("DeepSeek blocked this request by its security policy.", status);
	if (status === 404) return new WebToolError("DeepSeek could not fetch a usable page for this URL.", status);
	if (status === 429) return new WebToolError("DeepSeek rate limit reached. Retry shortly.", status);
	if (status === 408 || status >= 500)
		return new WebToolError(`DeepSeek service error (${status}). Retry shortly.`, status);
	return new WebToolError(`DeepSeek request failed (${status}): ${apiMessage(text)}`, status);
}

const retryable = (status: number | undefined) =>
	status !== undefined && (status === 429 || status === 408 || status >= 500);
/** Credential and balance problems affect every URL, so they fail the whole call instead of one entry. */
const wholeCall = (status: number | undefined) => status === 401 || status === 402;

function dateOnly(value: unknown): string | undefined {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

/** DeepSeek Search / Fetch share the model's DeepSeek API key; a missing key fails before any request. */
export function createDeepseekProvider(
	resolveKey: KeyResolver,
	fetchImpl: WebFetch = fetch,
	options: DeepseekProviderOptions = {},
): WebSearchProvider {
	const sleep = options.sleep ?? defaultSleep;
	const requireKey = async () => {
		const key = await resolveKey();
		if (!key) throw new WebToolError(DEEPSEEK_MISSING_KEY);
		return key;
	};
	const post = (url: string, body: Record<string, unknown>, context: Context) =>
		postJson({
			label: "DeepSeek",
			url,
			body,
			fetchImpl,
			context,
			resolveKey: requireKey,
			headers: (key) => ({ authorization: `Bearer ${key}` }),
			httpError,
		});
	return {
		id: "deepseek",
		async search(query, limit, context): Promise<SearchHit[]> {
			if (!query.trim()) throw new WebToolError("Provide a non-empty query.");
			if ([...query].length > DEEPSEEK_QUERY_MAX_CHARS)
				throw new WebToolError(
					`DeepSeek search queries are limited to ${DEEPSEEK_QUERY_MAX_CHARS} characters. Shorten the query and retry.`,
				);
			await requireKey();
			const data = await post(SEARCH_URL, { query, count: limit, need_content: false }, context);
			if (!record(data) || !Array.isArray(data.results) || !data.results.every(record))
				throw new WebToolError("Invalid DeepSeek response.");
			return data.results.slice(0, limit).map((item) => {
				const date = dateOnly(item.date);
				return {
					title: String(item.title ?? "(untitled)"),
					url: String(item.url ?? ""),
					text: String(item.summary || item.snippet || ""),
					...(date ? { date } : {}),
				};
			});
		},
		async extract(urls, context): Promise<ExtractOutcome[]> {
			await requireKey();
			const outcomes: ExtractOutcome[] = new Array(urls.length);
			let next = 0;
			let fatal: WebToolError | undefined;
			const fetchOne = async (url: string): Promise<ExtractOutcome> => {
				for (let attempt = 0; ; attempt++) {
					try {
						const data = await post(FETCH_URL, { url }, context);
						if (!record(data) || typeof data.content !== "string") throw new WebToolError("Invalid DeepSeek response.");
						return { url, text: data.content };
					} catch (error) {
						const failure = error instanceof WebToolError ? error : new WebToolError("DeepSeek request failed.");
						if (context.abortSignal?.aborted || wholeCall(failure.status)) throw failure;
						if (!retryable(failure.status) || attempt >= MAX_RETRIES) return { url, error: failure.message };
						try {
							await sleep(BACKOFF_MS[attempt] ?? 750, context.abortSignal);
						} catch {
							throw new WebToolError("Web request cancelled.");
						}
					}
				}
			};
			const worker = async () => {
				while (!fatal) {
					const index = next++;
					if (index >= urls.length) return;
					try {
						outcomes[index] = await fetchOne(urls[index] as string);
					} catch (error) {
						fatal ??= error instanceof WebToolError ? error : new WebToolError("DeepSeek request failed.");
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, worker));
			if (fatal) throw fatal;
			return outcomes;
		},
	};
}
