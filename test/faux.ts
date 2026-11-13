import { fauxProvider as createFaux, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

/** Existing chat fixtures keep their queue/count isolated from background naming. */
export function fauxProvider(options?: Parameters<typeof createFaux>[0]): ReturnType<typeof createFaux> {
	const chat = createFaux(options);
	const naming = createFaux(options);
	naming.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage([fauxText("Test session")])));
	const original = chat.provider.streamSimple.bind(chat.provider);
	return {
		...chat,
		provider: {
			...chat.provider,
			streamSimple(model, context, opts) {
				const title = context.messages.some(
					(m) =>
						m.role === "system" &&
						typeof m.content === "string" &&
						m.content.startsWith("Summarize the first question"),
				);
				return title ? naming.provider.streamSimple(model, context, opts) : original(model, context, opts);
			},
		},
	};
}
