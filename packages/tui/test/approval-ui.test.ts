import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ChatView, ToolApproval } from "@neko-harness/core";
import type { NekoGatewayConnection } from "@neko-harness/gateway/client-session";
import { ApprovalDetail, approvalText } from "../src/approval-ui.ts";
import { setActiveTheme } from "../src/theme/index.ts";

it("requires explicit decisions, scrolls complete commands, synchronizes and releases review", async () => {
	const item: ToolApproval = {
		id: 3,
		version: "v",
		childId: 2,
		delegationTaskId: 1,
		callId: "bash",
		command: Array.from({ length: 100 }, (_, i) => `echo line ${i}`).join("\n"),
		cwd: "/work",
		timeout: null,
		status: "pending",
		createdAt: 0,
		decidedAt: null,
	};
	let callback: (view: ChatView | undefined) => void = () => {};
	let released = false;
	let calls = 0;
	const service = {
		view: {
			subscribe: (fn: typeof callback) => {
				callback = fn;
				return () => {
					released = true;
				};
			},
		},
		decideApproval: async (input: { id: number; version: string; decision: string }) => {
			calls++;
			expect(input.id).toBe(item.id);
			expect(input.version).toBe("v");
			return input.decision;
		},
	} as unknown as ReturnType<NekoGatewayConnection["subagent"]>;
	const detail = new ApprovalDetail(item, service, () => {});
	for (const theme of ["light", "dark"] as const) {
		setActiveTheme(theme);
		for (const width of [58, 78]) {
			const first = detail.lines(width, 8);
			expect(first.every((l) => visibleWidth(l) <= width)).toBe(true);
			detail.handleKey("\x1b[6~");
			expect(detail.lines(width, 8)).not.toEqual(first);
		}
	}
	expect(detail.handleKey("\r")).toBe(false);
	expect(detail.handleKey("\x1b")).toBe(false);
	expect(calls).toBe(0);
	await detail.decide("denied");
	expect(calls).toBe(1);
	await detail.decide("allowed");
	expect(calls).toBe(1);
	callback({ approvals: [{ ...item, status: "cancelled" }] } as ChatView);
	expect(stripTerminalSequences(detail.help)).not.toContain("Allow once");
	detail.close();
	expect(released).toBe(true);
	expect(approvalText("echo\x1b[31m\rnext")).toBe("echo\\u001b[31m\\u000dnext");
});

it("mouse approval acts only on the visible action row", async () => {
	const item: ToolApproval = {
		id: 3,
		version: "v",
		childId: 2,
		delegationTaskId: 1,
		callId: "bash",
		command: "pwd",
		cwd: "/work",
		timeout: 10,
		status: "pending",
		createdAt: 0,
		decidedAt: null,
	};
	let decision = "";
	const service = {
		view: { subscribe: () => () => {} },
		decideApproval: async (input: { decision: string }) => {
			decision = input.decision;
			return decision;
		},
	} as unknown as ReturnType<NekoGatewayConnection["subagent"]>;
	const detail = new ApprovalDetail(item, service, () => {});
	const lines = detail.lines(58, 10);
	expect(detail.handleMouse({ type: "click", button: "left", x: 20, y: 0 } as never)).toBe(false);
	expect(detail.handleMouse({ type: "click", button: "left", x: 20, y: lines.length - 1 } as never)).toBe(true);
	await Bun.sleep(0);
	expect(decision).toBe("denied");
	detail.close();
});

it("keeps approval actions visible in the real layout while the busy row is present", async () => {
	const { Text, ScrollView, Container } = await import("@earendil-works/pi-tui");
	const { renderLayoutFrame } = await import("@earendil-works/pi-tui/dist/layout.js");
	const { createAppLayout } = await import("../src/layout.ts");
	const { PickerPanel } = await import("../src/components/picker.ts");
	const item: ToolApproval = {
		id: 3,
		version: "v",
		childId: 2,
		delegationTaskId: 1,
		callId: "bash",
		command: "# long command\n".repeat(100),
		cwd: "/work",
		timeout: null,
		status: "pending",
		createdAt: 0,
		decidedAt: null,
	};
	let selected = 0;
	const second = { ...item, id: 4, version: "second", command: "pwd" };
	const service = {
		view: { value: { approvals: [item, second] }, subscribe: () => () => {} },
		decideApproval: async (input: { id: number }) => {
			selected = input.id;
			return "allowed";
		},
	} as unknown as ReturnType<NekoGatewayConnection["subagent"]>;
	const detail = new ApprovalDetail(item, service, () => {});
	const panel = new PickerPanel(
		() => {},
		() => {},
	);
	await panel.show(
		"Agents",
		async () => [],
		async () => {},
	);
	panel.showDetail(detail);
	const layout = createAppLayout({
		transcript: new ScrollView(new Text("", 0, 0)),
		panel,
		editor: new Text("input\n\n", 0, 0),
		footer: new Text("status\nkeys", 0, 0),
		notices: new Container(),
		panelOpen: () => true,
		busy: new Text("\nRunning", 0, 0),
		busyVisible: () => true,
	});
	for (const [w, h] of [
		[80, 24],
		[60, 16],
	]) {
		const frame = renderLayoutFrame(layout, w!, h!, () => {});
		const text = frame.lines.map(stripTerminalSequences).join("\n");
		expect(text).toContain("Allow once");
		expect(text).toContain("Deny");
		expect(text).toContain("Running");
	}
	detail.handleKey("]");
	expect(detail.lines(58, 8).map(stripTerminalSequences).join("\n")).toContain("pwd");
	await detail.decide("allowed");
	expect(selected).toBe(4);
	detail.close();
});
