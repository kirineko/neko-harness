import type { ChatView, Delegation, ToolApproval } from "@neko-harness/core";
import { expect, it } from "vitest";
import { ApprovalQueue } from "../src/approval-queue.ts";
import type { SubagentClient } from "../src/subagent-client.ts";

it("aggregates pending requests across children and releases readers on settlement and session changes", () => {
	const readers = new Map<
		number,
		{
			service: SubagentClient;
			listeners: Set<(v: ChatView | undefined) => void>;
			publish: (approvals: ToolApproval[]) => void;
		}
	>();
	const connect = (target: number | string) => {
		const id = Number(target);
		let value = { approvals: [{ id, status: "pending", createdAt: id }] } as ChatView;
		const listeners = new Set<(v: ChatView | undefined) => void>();
		const service = {
			view: {
				get value() {
					return value;
				},
				subscribe(fn: (v: ChatView | undefined) => void) {
					listeners.add(fn);
					fn(value);
					return () => {
						listeners.delete(fn);
					};
				},
			},
		} as SubagentClient;
		readers.set(id, {
			service,
			listeners,
			publish: (approvals) => {
				value = { ...value, approvals };
				for (const fn of listeners) fn(value);
			},
		});
		return service;
	};
	const queue = new ApprovalQueue(connect, () => {});
	queue.update([
		{ taskId: 1, approvalCount: 1 },
		{ taskId: 2, approvalCount: 2 },
		{ taskId: 3, approvalCount: 1, historyThrough: 10 },
	] as Delegation[]);
	expect(queue.pending.map(({ item }) => item.id)).toEqual([1, 2]);
	expect(readers.has(3)).toBe(false);
	readers.get(1)!.publish([{ id: 1, status: "allowed" } as ToolApproval]);
	expect(queue.pending.map(({ item }) => item.id)).toEqual([2]);
	queue.update([{ taskId: 2, approvalCount: 1 }] as Delegation[]);
	expect(readers.get(1)!.listeners.size).toBe(0);
	queue.close();
	expect(queue.pending).toEqual([]);
	expect(readers.get(2)!.listeners.size).toBe(0);
});
