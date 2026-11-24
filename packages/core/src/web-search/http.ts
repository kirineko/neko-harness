import type { Context } from "@earendil-works/chord/context";

export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type WebFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type KeyResolver = () => Promise<string | undefined>;

/** Only deliberate, sanitized errors may enter a persistent tool result. */
export class WebToolError extends Error {
	readonly status: number | undefined;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export function redact(text: string, key: string | undefined): string {
	for (const secret of key ? [key, encodeURIComponent(key)] : []) text = text.replaceAll(secret, "[redacted]");
	return text.replace(/\b(?:tvly|sk)-[a-zA-Z0-9_-]+/g, "[redacted]");
}

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

async function readBounded(response: Response, signal: AbortSignal, label: string): Promise<string> {
	if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw new WebToolError(`${label} response exceeds the 2 MiB limit.`);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) return text + decoder.decode();
			size += chunk.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new WebToolError(`${label} response exceeds the 2 MiB limit.`);
			text += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export type PostJsonOptions = {
	/** Provider name used in error messages, e.g. "Tavily". */
	readonly label: string;
	readonly url: string;
	readonly body: Record<string, unknown>;
	readonly fetchImpl: WebFetch;
	readonly context: Context;
	/** Resolves the key per request; the returned headers carry the authentication. */
	readonly resolveKey: KeyResolver;
	readonly headers: (key: string | undefined) => Record<string, string>;
	/** Maps a non-2xx response (body already redacted) to the error shown to the model. */
	readonly httpError: (status: number, text: string, key: string | undefined) => WebToolError;
};

/** POST JSON with timeout, cancellation, a bounded body and sanitized errors; returns the parsed JSON. */
export async function postJson(options: PostJsonOptions): Promise<unknown> {
	const { label, context } = options;
	let key: string | undefined;
	const signal = AbortSignal.any([
		AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		...(context.abortSignal ? [context.abortSignal] : []),
	]);
	try {
		signal.throwIfAborted();
		key = await options.resolveKey();
		signal.throwIfAborted();
		const response = await options.fetchImpl(options.url, {
			method: "POST",
			headers: { "content-type": "application/json", ...options.headers(key) },
			body: JSON.stringify(options.body),
			signal,
		});
		const text = redact(await readBounded(response, signal, label), key);
		if (!response.ok) throw options.httpError(response.status, text, key);
		return JSON.parse(text);
	} catch (error) {
		if (context.abortSignal?.aborted) throw new WebToolError("Web request cancelled.");
		if (signal.aborted) throw new WebToolError(`${label} request timed out. Please retry.`);
		if (error instanceof WebToolError) throw error;
		// Network errors, JSON parser errors and credential-store errors can contain sensitive data.
		throw new WebToolError(`${label} request failed. Check the connection and credentials, then retry.`);
	}
}
