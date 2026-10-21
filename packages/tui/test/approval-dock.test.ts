import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { ChatView, Delegation, ToolApproval } from "@neko-harness/core";
import type { NekoGatewayConnection } from "@neko-harness/gateway/client-session";
import { ApprovalDock } from "../src/approval-dock.ts";
import { createAppLayout } from "../src/layout.ts";

it("reviews from either main or agent view, automatically selects and explicitly confirms, and settled requests disappear", async () => {
	const item: ToolApproval = {
		id: 3,
		version: "v",
		childId: 2,
		delegationTaskId: 1,
		callId: "bash",
		command: "git status --short",
		cwd: "/work",
		timeout: null,
		status: "pending",
		createdAt: 0,
		decidedAt: null,
	};
	let value = { approvals: [item] } as ChatView;
	const listeners = new Set<(view: ChatView) => void>();
	const decisions: number[] = [];
	const service = {
		view: {
			get value() {
				return value;
			},
			subscribe(fn: (view: ChatView) => void) {
				listeners.add(fn);
				fn(value);
				return () => {
					listeners.delete(fn);
				};
			},
		},
		decideApproval: async ({ id, decision }: { id: number; decision: ToolApproval["status"] }) => {
			decisions.push(id);
			value = { ...value, approvals: value.approvals!.map((a) => (a.id === id ? { ...a, status: decision } : a)) };
			for (const fn of listeners) fn(value);
			return decision;
		},
	} as unknown as ReturnType<NekoGatewayConnection["subagent"]>;
	const dock = new ApprovalDock(
		() => service,
		() => {},
	);
	dock.update([{ taskId: 1, title: "Inspect", approvalCount: 1 }] as Delegation[]);
	expect(dock.visible).toBe(true);
	for (const panelOpen of [false, true]) {
		for (const [width, height] of [
			[60, 16],
			[80, 24],
		] as const) {
			const layout = createAppLayout({
				transcript: new Text("Transcript", 0, 0),
				panel: { height: 1, render: () => ["Agent"], invalidate() {} },
				editor: new Text("Draft\nline\nline", 0, 0),
				footer: new Text("Footer\nKeys", 0, 0),
				notices: new Text("", 0, 0),
				panelOpen: () => panelOpen,
				approval: dock,
				approvalVisible: () => dock.visible,
			});
			const rows = renderLayoutFrame(layout, width, height, () => {})
				.lines.map(stripTerminalSequences)
				.join("\n");
			expect(rows).toContain("git status --short");
			expect(rows).toContain("Allow once");
			expect(rows).toContain("Confirm");
		}
	}
	expect(dock.handleInput("a")).toBe(true);
	expect(decisions).toEqual([]);
	dock.handleInput("\x1b[B");
	expect(decisions).toEqual([]);
	dock.handleInput("\r");
	await Promise.resolve();
	expect(decisions).toEqual([3]);
	expect(value.approvals![0]!.status).toBe("denied");
	expect(dock.visible).toBe(false);
	expect(dock.render(60)).toEqual([]);
	value = { ...value, approvals: [{ ...item, id: 4, command: "echo next" }] };
	for (const fn of listeners) fn(value);
	expect(dock.visible).toBe(true);
	expect(dock.focused).toBe(true);
	expect(dock.handleInput("a")).toBe(true);
	expect(decisions).toEqual([3]);
	dock.handleInput("\r"); // A new request cannot confirm before it has been rendered.
	expect(decisions).toEqual([3]);
	dock.render(60);
	dock.handleInput("\r");
	await Promise.resolve();
	expect(decisions).toEqual([3, 4]);
	expect(value.approvals![0]!.status).toBe("allowed");
	dock.close();
	expect(listeners.size).toBe(0);
});
