import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, num, obj, opt, str } from "@earendil-works/pi-schema";
import { truncate, WebToolError } from "./http.ts";
import type { WebSearchProvider } from "./provider.ts";

export { type WebFetch, WebToolError } from "./http.ts";
export type { ExtractOutcome, SearchHit, WebSearchProvider } from "./provider.ts";

const MAX_URLS = 20;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const MAX_SOURCE_CHARS = 2000;
const MAX_TOTAL_CHARS = 12_000;

/** Resolves the backend for one tool call; throws `WebToolError` when the selected backend is unusable. */
export type WebProviderResolver = (context: Context) => Promise<WebSearchProvider>;

function toolError(error: unknown) {
	return {
		output: [
			{ type: "text" as const, text: error instanceof WebToolError ? error.message : "Web tool failed. Please retry." },
		],
		isError: true,
	};
}
function content(text: string) {
	return { output: [{ type: "text" as const, text }] };
}

/** Tool surface is identical for every provider; the resolver picks the backend per call. */
export function createWebSearchTools(resolveProvider: WebProviderResolver) {
	return defineExtension({
		name: "neko-web-search",
		tools: [
			defineTool({
				name: "web_search",
				description:
					"Search the live web for current or unknown information. Returns ranked sources (title, URL, bounded excerpts). Keep the query short and focused (ideally under 128 characters). Use only when up-to-date or external information is needed; use web_extract to read a known URL.",
				parameters: obj(
					{
						query: str({ minLength: 1, maxLength: 4096, description: "The search query" }),
						maxResults: opt(
							num({ description: `Maximum number of results (1-${MAX_RESULTS}, default ${DEFAULT_RESULTS})` }),
						),
					},
					{ open: true },
				),
				async execute({ query, maxResults }, _api, context) {
					try {
						if (!query.trim() || query.length > 4096)
							throw new WebToolError("Provide a non-empty query of at most 4096 characters.");
						if (maxResults !== undefined && !Number.isFinite(maxResults))
							throw new WebToolError("maxResults must be a finite number.");
						const limit = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(maxResults ?? DEFAULT_RESULTS)));
						const provider = await resolveProvider(context);
						const results = (await provider.search(query, limit, context)).slice(0, limit);
						const budget = Math.floor(MAX_TOTAL_CHARS / Math.max(1, results.length)) - 2;
						return content(
							results
								.map((item, index) => {
									const header = `${index + 1}. ${truncate(item.title, 200)}\n${truncate(item.url, 300)}\n${item.date ? `Published: ${item.date}\n` : ""}`;
									return header + truncate(item.text, Math.min(MAX_SOURCE_CHARS, budget - header.length));
								})
								.join("\n\n") || "No results.",
						);
					} catch (error) {
						return toolError(error);
					}
				},
			}),
			defineTool({
				name: "web_extract",
				description:
					"Extract bounded markdown excerpts from web pages by URL. Every requested URL has a result or failure entry; long content is truncated.",
				parameters: obj(
					{
						urls: arr(str({ maxLength: 2048, description: "http(s) URL" }), {
							minItems: 1,
							maxItems: MAX_URLS,
							description: `URLs to extract (1-${MAX_URLS})`,
						}),
					},
					{ open: true },
				),
				async execute({ urls }, _api, context) {
					try {
						if (!urls.length || urls.length > MAX_URLS)
							throw new WebToolError(`Provide between 1 and ${MAX_URLS} URLs.`);
						for (const url of urls) {
							let parsed: URL;
							try {
								parsed = new URL(url);
							} catch {
								throw new WebToolError("Provide valid http(s) URLs.");
							}
							if (
								url.length > 2048 ||
								!["http:", "https:"].includes(parsed.protocol) ||
								parsed.username ||
								parsed.password
							)
								throw new WebToolError("Provide http(s) URLs of at most 2048 characters without embedded credentials.");
						}
						const provider = await resolveProvider(context);
						const outcomes = await provider.extract(urls, context);
						// Reserve a bounded slot for every requested URL, so content cannot displace failure information.
						const budget = Math.floor(MAX_TOTAL_CHARS / urls.length) - 2;
						return content(
							urls
								.map((url, index) => {
									const header = `## ${index + 1}. ${truncate(url, 300)}\n`;
									const outcome = outcomes[index];
									const text =
										outcome && "text" in outcome
											? outcome.text
											: `Extraction failed: ${outcome?.error ?? "No result returned for this URL"}`;
									return header + truncate(text, Math.min(MAX_SOURCE_CHARS, budget - header.length));
								})
								.join("\n\n"),
						);
					} catch (error) {
						return toolError(error);
					}
				},
			}),
		],
	});
}
