import { expect, it } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Provider } from "@earendil-works/pi-ai";
import {
	type ClientIdentity,
	formatUserAgent,
	getAttributionHeaders,
	PI_ATTRIBUTION,
} from "@earendil-works/pi-ai/utils/identity";
import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";

type Seen = { readonly title: boolean; readonly identity: ClientIdentity | undefined };

/** A faux provider that records the identity each request reaches the provider with. */
function recordingProvider() {
	const faux = fauxProvider();
	const seen: Seen[] = [];
	const call = faux.provider.streamSimple.bind(faux.provider);
	const provider: Provider = {
		...faux.provider,
		streamSimple(model, context, options) {
			const title = context.messages.some(
				(m) =>
					m.role === "system" && typeof m.content === "string" && m.content.startsWith("Summarize the first question"),
			);
			seen.push({ title, identity: options?.identity });
			return call(model, context, options);
		},
	};
	return { faux, provider, seen };
}

async function until(test: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (test()) return;
		await Bun.sleep(20);
	}
	throw new Error("identity timeout");
}

// Some model vendors only accept Pi's own client identity, so neko deliberately sends exactly that.
it("sends Pi's User-Agent and attribution on chat, delegation and naming requests", async () => {
	const { faux, provider, seen } = recordingProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { type: "explore", title: "Inspect", task: "Find evidence" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("Evidence report")]),
		fauxAssistantMessage([fauxText("Integrated report")]),
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("Investigate using explore"));
		await until(() => seen.some((request) => request.title));
		// Main run, subagent run, final answer, and the title request.
		expect(seen.length).toBeGreaterThanOrEqual(4);
		for (const { identity } of seen) {
			expect(formatUserAgent(identity)).toMatch(/^pi\/\S+ \(/);
			expect(
				getAttributionHeaders({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, identity),
			).toEqual(
				getAttributionHeaders(
					{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
					{ attribution: PI_ATTRIBUTION },
				),
			);
		}
		expect(
			Object.keys(
				getAttributionHeaders({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, seen[0]?.identity),
			),
		).not.toHaveLength(0);
	} finally {
		await runtime.close();
	}
}, 30_000);
