import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ChatView, Delegation } from "@neko-harness/core";
import type { NekoGatewayConnection } from "@neko-harness/gateway/client-session";
import { StatusFooter } from "../src/components/footer.ts";
import { PickerPanel } from "../src/components/picker.ts";
import { SubagentDetail, subagentItems } from "../src/subagents-ui.ts";
import { setActiveTheme } from "../src/theme/index.ts";

const entry: Delegation = {
	parentId: 1,
	childId: 2,
	taskId: 3,
	callId: "delegate",
	role: "explore",
	title: "Inspect evidence",
	createdAt: 0,
	startedAt: 1,
	endedAt: 1000,
	status: "completed",
	report: "report",
};
const view: ChatView = {
	model: "faux",
	agent: { model: null, thinkingLevel: "off" },
	cwd: "/work",
	busy: false,
	status: null,
	usage: { input: 12, output: 34, cacheRead: 0, cacheWrite: 0, cost: 0 },
	streaming: null,
	items: [
		{
			type: "user",
			key: "e1",
			id: 1,
			text: "Inspect evidence",
			images: [
				{ name: "fixture.png", entryId: 1, contentIndex: 1, mimeType: "image/png", width: 1, height: 1, bytes: 2 },
			],
		},
		{
			type: "assistant",
			key: "e2",
			id: 2,
			thinking: "visible reasoning",
			text: "Inspecting",
			stopReason: "toolUse",
			errorMessage: null,
			note: null,
		},
		{
			type: "tool",
			key: "tread",
			callId: "read",
			name: "read",
			summary: "evidence.ts",
			detail: "path: evidence.ts",
			phase: "done",
			isError: true,
			output: null,
			result: "read failed: missing file",
			durationMs: 12,
			note: "[truncated]",
			diff: null,
			diffAdded: null,
			diffRemoved: null,
		},
		{
			type: "assistant",
			key: "e4",
			id: 4,
			thinking: "",
			text: "Final report",
			stopReason: "stop",
			errorMessage: null,
			note: null,
		},
	],
};
it("reuses full transcript components, preserves expansion on reopen, and releases subscriptions", async () => {
	let live: (value: ChatView) => void = () => {};
	let holds = 0;
	const service = {
		view: {
			subscribe(fn: (value: ChatView) => void) {
				holds++;
				live = fn;
				fn(view);
				return () => {
					holds--;
				};
			},
		},
		history: async () => ({ items: view.items, next: null }),
		stop: async () => null,
	};
	const client = { subagent: () => service } as unknown as NekoGatewayConnection;
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	const detail = new SubagentDetail(client, 3, panel, () => {});
	detail.entry = entry;
	try {
		detail.open();
		expect(holds).toBe(1);
		detail.open();
		expect(holds).toBe(1);
		detail.handleKey("e");
		for (const theme of ["light", "dark"] as const) {
			setActiveTheme(theme);
			const rendered = detail.lines(78, 100).join("\n");
			for (const text of [
				"Inspect evidence",
				"fixture.png",
				"visible reasoning",
				"path: evidence.ts",
				"read failed",
				"Final report",
				"In 12",
			])
				expect(rendered).toContain(text);
			expect(detail.lines(58, 10)).toHaveLength(10);
		}
		detail.close();
		expect(holds).toBe(0);
		detail.open();
		expect(detail.lines(78, 100).join("\n")).toContain("visible reasoning");
		live({ ...view, streaming: { text: "Streaming", thinking: "", toolCalls: [] } });
		expect(detail.lines(78, 100).join("\n")).toContain("Streaming");
		await detail.history();
		expect(
			detail
				.lines(78, 100)
				.join("\n")
				.match(/Final report/g),
		).toHaveLength(1);
		expect(subagentItems([entry])[0]?.rightLabel).toBe("Idle");
	} finally {
		detail.close();
		setActiveTheme("light");
	}
});

it("scrolls long child history by wheel and viewport pages without losing position on reopen", async () => {
	let live!: (value: ChatView) => void;
	const longView = {
		...view,
		items: [
			{
				type: "system" as const,
				key: "long",
				id: 1,
				text: Array.from({ length: 100 }, (_, i) => `ROW ${i}`).join("\n"),
			},
		],
	};
	const client = {
		subagent: () => ({
			view: {
				subscribe(fn: (value: ChatView) => void) {
					live = fn;
					fn(longView as ChatView);
					return () => {};
				},
			},
		}),
	} as unknown as NekoGatewayConnection;
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	panel.agentNavigation = true;
	const detail = new SubagentDetail(client, 3, panel, () => {});
	await panel.show(
		"agents",
		async () => subagentItems([entry]),
		async () => detail.open(),
	);
	panel.handleInput("\x1b[C");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(panel.detailOpen).toBe(true);
	const bottom = detail.lines(60, 10).map(stripTerminalSequences);
	expect(
		panel.handleMouse({
			type: "wheel",
			button: "none",
			wheelDelta: -20,
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 60,
			height: 10,
			shift: false,
			alt: false,
			ctrl: false,
		})?.handled,
	).toBe(true);
	const scrolled = detail.lines(60, 10).map(stripTerminalSequences);
	expect(scrolled).not.toEqual(bottom);
	live({ ...longView, streaming: { text: "new output", thinking: "", toolCalls: [] } } as ChatView);
	expect(detail.lines(60, 10).map(stripTerminalSequences)).toEqual(scrolled);
	detail.handleKey("\x1b[5~");
	const paged = detail.lines(60, 10).map(stripTerminalSequences);
	expect(paged.at(-1)).toBe(scrolled[0]);
	panel.handleInput("\x1b[D");
	expect(panel.open).toBe(false);
	detail.open();
	expect(detail.lines(60, 10).map(stripTerminalSequences)).toEqual(paged);
	detail.close();
});

it("keeps the completed-agent footer entry visible at narrow widths and while busy", () => {
	const footer = new StatusFooter();
	for (const busy of [undefined, "Thinking..."]) {
		footer.setStats({
			model: "faux",
			thinkingLevel: null,
			busy,
			cwd: "/work",
			usageText: "In 100 Out 200",
			subagentCount: 3,
		});
		for (const width of [40, 60, 80]) {
			const lines = footer.render(width);
			expect(lines.map(stripTerminalSequences).join("\n")).toContain("→ Agents 3");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	}
	footer.panelOpen = true;
	expect(footer.render(60).map(stripTerminalSequences).join("\n")).not.toContain("Agents");
});

it("dispatches clicks to the footer and the rendered agent list row", async () => {
	const event = {
		type: "click" as const,
		button: "left" as const,
		x: 4,
		y: 1,
		screenX: 4,
		screenY: 1,
		width: 60,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	};
	const footer = new StatusFooter();
	let opened = 0;
	footer.onOpenAgents = () => {
		opened++;
	};
	footer.setStats({
		model: "faux",
		thinkingLevel: null,
		busy: undefined,
		cwd: "/work",
		usageText: "",
		subagentCount: 1,
	});
	expect(footer.handleMouse(event)?.handled).toBe(true);
	expect(opened).toBe(1);
	footer.panelOpen = true;
	expect(footer.handleMouse(event)).toBeUndefined();
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	panel.pointerSelection = true;
	panel.agentNavigation = true;
	let picked = "";
	await panel.show(
		"agents",
		async () => subagentItems([entry]),
		async (value) => {
			picked = value;
		},
	);
	panel.render(60);
	expect(panel.handleMouse({ ...event, y: 2 })?.handled).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(picked).toBe(`agent-${entry.childId}`);
});

it("loads older records on upward scroll without an H command or a viewport jump", async () => {
	let calls = 0;
	const current: ChatView = {
		...view,
		historyBefore: 50,
		items: [
			{
				type: "system",
				id: 50,
				key: "now",
				order: 50,
				text: Array.from({ length: 30 }, (_, i) => `Current ${i}`).join("\n"),
			},
		],
	};
	const client = {
		subagent: () => ({
			view: {
				subscribe(fn: (v: ChatView) => void) {
					fn(current);
					return () => {};
				},
			},
			history: async () => {
				calls++;
				return { items: [{ type: "system", id: 1, key: "old", order: 1, text: "Earlier record" }], next: null };
			},
		}),
	} as unknown as NekoGatewayConnection;
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	const detail = new SubagentDetail(client, 3, panel, () => {});
	detail.open();
	detail.lines(60, 10);
	expect(detail.handleKey("h")).toBe(false);
	expect(calls).toBe(0);
	detail.scroll(-100);
	const before = detail.lines(60, 10).map(stripTerminalSequences);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls).toBe(1);
	expect(detail.lines(60, 10).map(stripTerminalSequences).slice(2)).toEqual(before.slice(2));
	detail.scroll(-100);
	expect(detail.lines(60, 10).map(stripTerminalSequences).join("\n")).toContain("Earlier record");
	expect(calls).toBe(1);
	detail.close();
});

it("groups multiple completed rounds into one idle entry while preserving per-round cards", () => {
	const first = { ...entry, agentId: `agent-${entry.childId}`, round: 1 };
	const second = { ...first, taskId: 4, title: "Follow up", round: 2 };
	const items = subagentItems([first, second]);
	expect(items).toHaveLength(1);
	expect(items[0]!.value).toBe(first.agentId);
	expect(items[0]!.rightLabel).toBe("Idle");
	expect(items[0]!.description).toContain("2 rounds");
	expect(first.status).toBe("completed");
});

it("loads and locates an earlier round without replacing its historical status", async () => {
	const first = { ...entry, agentId: "agent-2", round: 1, inputEntryId: 1 };
	const second = {
		...first,
		taskId: 4,
		round: 2,
		inputEntryId: 120,
		title: "Second",
		status: "running" as const,
		endedAt: null,
	};
	const snapshot: ChatView = {
		...view,
		historyBefore: 120,
		rounds: [first, second],
		items: [{ type: "user", key: "e120", id: 120, text: "Second input", subagentRoundId: 4 }],
	};
	let calls = 0;
	const service = {
		view: {
			value: snapshot,
			subscribe(fn: (v: ChatView) => void) {
				fn(snapshot);
				return () => {};
			},
		},
		history: async () => {
			calls++;
			return {
				items: [{ type: "user" as const, key: "e1", id: 1, text: "First input", subagentRoundId: 3 }],
				next: null,
			};
		},
	} as unknown as ReturnType<NekoGatewayConnection["subagent"]>;
	const client = { subagent: () => service } as unknown as NekoGatewayConnection;
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	const detail = new SubagentDetail(client, "agent-2", panel, () => {});
	detail.entry = second;
	detail.open();
	detail.locate(first.taskId);
	await new Promise((r) => setTimeout(r, 0));
	const text = detail.lines(60, 8).map(stripTerminalSequences).join("\n");
	expect(calls).toBe(1);
	expect(text).toContain("Task 1");
	expect(text).toContain("First input");
	expect(first.status).toBe("completed");
	detail.close();
});
