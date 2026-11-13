import { fauxAssistantMessage, fauxToolCall, type Provider } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { expect, it } from "vitest";
import { fauxProvider } from "../../../test/faux.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";
import { listDelegations, listSubagents } from "../src/subagents.ts";

it("sends a provider-compatible object schema on ordinary DeepSeek messages through the actual Pi adapter", async () => {
	const provider: Provider = deepseekProvider();
	const schemas: Record<string, unknown>[] = [];
	const transport = async (_input: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as {
			tools?: { function: { name: string; parameters: Record<string, unknown> } }[];
		};
		const subagent = body.tools?.find((t) => t.function.name === "subagent");
		if (subagent) {
			const schema = subagent.function.parameters;
			schemas.push(schema);
			if (schema.type !== "object" || schema.anyOf !== undefined)
				return Response.json(
					{
						error: {
							message: "Invalid schema for function 'subagent': expected object",
							type: "invalid_request_error",
						},
					},
					{ status: 400 },
				);
		}
		const chunk = {
			id: "schema-test",
			object: "chat.completion.chunk",
			created: 1,
			model: "deepseek-flash",
			choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
		};
		const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	const offlineFetch = Object.assign(transport, { preconnect: () => {} });
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		apiKey: "test-schema-fixture",
		providers: [
			{
				...provider,
				streamSimple: (model, context, options) =>
					provider.streamSimple(model, context, { ...options, fetch: offlineFetch }),
			},
		],
	});
	try {
		for (const message of ["hi", "Another ordinary message"])
			expect(await runtime.waitAnswer(await runtime.submit(message))).toEqual({ status: "done", text: "Hello" });
		expect(schemas).toHaveLength(2);
		for (const schema of schemas) {
			expect(schema.additionalProperties).toBe(false);
			expect(schema.properties).toMatchObject({
				action: { type: "string", enum: ["create", "continue", "list"] },
				type: { type: "string", enum: ["explore", "plan", "coder"] },
				agentId: { type: "string" },
			});
		}
	} finally {
		await runtime.close();
	}
});

const invalidArguments: Record<string, string>[] = [
	{},
	{ title: "Missing role", task: "Inspect" },
	{ action: "continue", title: "Missing identity", task: "Inspect" },
	{ action: "continue", agentId: "agent-2", type: "coder", title: "Role override", task: "Inspect" },
	{ action: "create", type: "explore", agentId: "agent-2", title: "Mixed fields", task: "Inspect" },
	{ action: "list", task: "Unexpected task" },
];
it.each(invalidArguments)("rejects invalid action fields before creating a child: %j", async (args) => {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", args)], { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.findLast((m) => m.role === "toolResult");
			expect(result).toMatchObject({ isError: true });
			expect(JSON.stringify(result)).toContain("Invalid subagent arguments");
			return fauxAssistantMessage("Handled invalid arguments");
		},
	]);
	const runtime = await createNekoRuntime({
		storage: "memory",
		credentials: new InMemoryCredentialStore(),
		providers: [faux.provider],
		model: { provider: "faux", modelId: "faux-1" },
	});
	try {
		await runtime.waitAnswer(await runtime.submit("Try invalid arguments"));
		expect(await listDelegations(runtime.harness, runtime.root.id, runtime.context)).toEqual([]);
		expect(await listSubagents(runtime.harness, runtime.root.id, runtime.context)).toEqual([]);
	} finally {
		await runtime.close();
	}
});
