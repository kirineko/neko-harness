import type { Context } from "@earendil-works/chord/context";
import type { SearchProviderId } from "../search-providers.ts";

export type SearchHit = {
	readonly title: string;
	readonly url: string;
	/** Model-facing excerpt; the tool layer truncates it. */
	readonly text: string;
	/** Publication date (YYYY-MM-DD) when the backend knows it. */
	readonly date?: string;
};

/** One entry per requested URL: either page text or a failure reason. */
export type ExtractOutcome =
	| { readonly url: string; readonly text: string }
	| { readonly url: string; readonly error: string };

/** A web backend; implementations throw `WebToolError` for failures that may be shown to the model. */
export interface WebSearchProvider {
	readonly id: SearchProviderId;
	search(query: string, limit: number, context: Context): Promise<SearchHit[]>;
	/** Returns exactly one outcome per input URL, in input order. */
	extract(urls: readonly string[], context: Context): Promise<ExtractOutcome[]>;
}
