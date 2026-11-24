import { createHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { compile } from "@earendil-works/pi-schema";
import { expect, it } from "vitest";
import {
	ChatViewSchema,
	DefaultModelStateSchema,
	DirectoryStateSchema,
	decodeSubagentTarget,
	encodeSubagentTarget,
	GATEWAY_ADDRESS,
	NekoChat,
	NekoDefaultModel,
	NekoSessionDirectory,
	NekoSubagent,
} from "../src/contract.ts";
import { NekoMobileAdmin } from "../src/mobile/admin.ts";

it("validates Chord v2 contract params, closed method arguments, and snapshot delivery", async () => {
	const facet = defineFacet((host) => {
		host.serve(NekoDefaultModel, (_params, _principal, self) => {
			const w = self.writable<import("../src/contract.ts").NekoDefaultModelState>({
				effective: { provider: "deepseek", modelId: "deepseek-flash" },
				source: "default",
			});
			return {
				variant: "ready",
				members: {
					snapshot: self.derive([w], ([v]) => v),
					set: async (next) => {
						w.set({ effective: next, source: "saved" });
						return null;
					},
					clear: async () => null,
				},
			};
		});
		host.serve(NekoSessionDirectory, (_params, _principal, self) => {
			const w = self.writable({ revision: 1, sessions: [] });
			return {
				variant: "ready",
				members: {
					snapshot: self.derive([w], ([v]) => v),
				},
			};
		});
	});
	const host = createHost({ address: GATEWAY_ADDRESS, principal: { kind: "host" }, onError() {} });
	await host.load([{ name: "@neko-harness/gateway-test", facet }], BACKGROUND_CONTEXT);
	try {
		const [defaultModel, directory] = await Promise.all([
			host.get(NekoDefaultModel, {}, BACKGROUND_CONTEXT),
			host.get(NekoSessionDirectory, {}, BACKGROUND_CONTEXT),
		]);
		expect(directory.snapshot.value).toEqual({ revision: 1, sessions: [] });
		expect(defaultModel.snapshot.value).toEqual({
			effective: { provider: "deepseek", modelId: "deepseek-flash" },
			source: "default",
		});
		// Closed argument objects reject extra unknown fields and wrong types with invalid/args.
		await expect(
			defaultModel.set({ provider: "deepseek", modelId: "deepseek-chat", extra: true } as never, BACKGROUND_CONTEXT),
		).rejects.toMatchObject({ code: "invalid", reason: "args" });
		await expect(
			defaultModel.set({ provider: 123, modelId: "deepseek-chat" } as never, BACKGROUND_CONTEXT),
		).rejects.toMatchObject({ code: "invalid", reason: "args" });
		// Params are checked synchronously on get/hold with invalid/params.
		await expect(
			host.get(NekoChat, { sessionId: 42, attachmentId: "a1" } as never, BACKGROUND_CONTEXT),
		).rejects.toMatchObject({ code: "invalid", reason: "params" });
		expect(NekoMobileAdmin.name).toBe("neko.mobile-admin");
		expect(NekoSubagent.name).toBe("neko.subagent");
	} finally {
		await host.close(BACKGROUND_CONTEXT);
	}
});

it("encodes and decodes flat NekoSubagent target params round-trip", () => {
	expect(encodeSubagentTarget(42)).toBe("round:42");
	expect(encodeSubagentTarget("explore-1")).toBe("agent:explore-1");
	expect(decodeSubagentTarget("round:42")).toEqual({ kind: "round", taskId: 42 });
	expect(decodeSubagentTarget("agent:explore-1")).toEqual({ kind: "agent", agentId: "explore-1" });
	expect(decodeSubagentTarget("round:notanumber")).toBeUndefined();
	expect(decodeSubagentTarget("agent:")).toBeUndefined();
	expect(decodeSubagentTarget("other:1")).toBeUndefined();
	expect(compile(DirectoryStateSchema).check({ revision: 1, sessions: [{ id: 42 }] })).toBe(false);
});

it("accepts only known default-model sources in states", () => {
	const state = { effective: { provider: "deepseek", modelId: "deepseek-flash" }, source: "default" };
	expect(compile(DefaultModelStateSchema).check(state)).toBe(true);
	expect(compile(DefaultModelStateSchema).check({ ...state, source: "saved" })).toBe(true);
	expect(compile(DefaultModelStateSchema).check({ ...state, source: "bogus" })).toBe(false);
	expect(compile(DefaultModelStateSchema).check({ effective: { provider: "deepseek" }, source: "default" })).toBe(
		false,
	);
	expect(compile(DefaultModelStateSchema).check({ source: "default" })).toBe(false);
	expect(NekoDefaultModel.version).toBe(1);
	expect(NekoDefaultModel.name).toBe("neko.default-model");
});

it("accepts nullable diff fields on tool items and streaming calls", () => {
	const baseView = {
		model: "deepseek/deepseek-chat",
		agent: { model: null, thinkingLevel: "off" },
		cwd: "/tmp",
		busy: false,
		status: null,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		items: [],
		streaming: null,
	};
	const toolItem = {
		type: "tool",
		key: "t1",
		callId: "c1",
		name: "edit",
		summary: "src/a.ts (1 edits)",
		detail: null,
		phase: "done",
		isError: false,
		output: null,
		result: "done",
		durationMs: 12,
		note: null,
		diff: "+ 1 export const a = 1",
		diffAdded: 1,
		diffRemoved: 0,
	};
	const streamCall = {
		callId: "c2",
		name: "write",
		summary: "b.ts",
		detail: null,
		phase: "running",
		output: null,
		diff: null,
		diffAdded: null,
		diffRemoved: null,
	};
	const view = { ...baseView, items: [toolItem], streaming: { thinking: "", text: "", toolCalls: [streamCall] } };
	expect(compile(ChatViewSchema).check(view)).toBe(true);
	const truncatedView = {
		...view,
		items: [{ ...toolItem, diffTruncated: true }],
		streaming: { ...view.streaming, toolCalls: [{ ...streamCall, diffTruncated: true }] },
	};
	expect(compile(ChatViewSchema).check(truncatedView)).toBe(true);
	expect(compile(ChatViewSchema).check({ ...truncatedView, items: [{ ...toolItem, diffTruncated: "true" }] })).toBe(
		false,
	);
	// Fields are required-nullable: omitting them on a tool item is a contract violation.
	const missingDiff = {
		...view,
		items: [Object.fromEntries(Object.entries(toolItem).filter(([key]) => key !== "diff"))],
	};
	expect(compile(ChatViewSchema).check(missingDiff)).toBe(false);
});

it("accepts the optional codemode view on tool items and streaming calls, and items without it", () => {
	const codemode = {
		calls: [{ id: 1, name: "read", args: '{"path":"a"}', status: "ok", durationMs: 4, error: null }],
		omitted: 0,
		fullOutputPath: null,
	};
	const toolItem = {
		type: "tool",
		key: "t1",
		callId: "c1",
		name: "codemode",
		summary: "text(a)",
		detail: null,
		phase: "done",
		isError: false,
		output: null,
		result: "done",
		durationMs: 12,
		note: null,
		diff: null,
		diffAdded: null,
		diffRemoved: null,
	};
	const streamCall = {
		callId: "c2",
		name: "codemode",
		summary: "x",
		detail: null,
		phase: "running",
		output: null,
		diff: null,
		diffAdded: null,
		diffRemoved: null,
	};
	const view = (item: object, call: object) => ({
		model: "deepseek/deepseek-chat",
		agent: { model: null, thinkingLevel: "off" },
		cwd: "/tmp",
		busy: false,
		status: null,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		items: [item],
		streaming: { thinking: "", text: "", toolCalls: [call] },
	});
	expect(compile(ChatViewSchema).check(view(toolItem, streamCall))).toBe(true);
	expect(compile(ChatViewSchema).check(view({ ...toolItem, codemode }, { ...streamCall, codemode }))).toBe(true);
	const bad = { ...codemode, calls: [{ ...codemode.calls[0], status: "weird" }] };
	expect(compile(ChatViewSchema).check(view({ ...toolItem, codemode: bad }, streamCall))).toBe(false);
});
