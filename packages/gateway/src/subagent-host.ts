import { ChordError, type Context, type Host, local, opaque } from "@earendil-works/chord";
import { type ConversationId, type EntryId, type EntryRecord, type TaskId, UsageDoc } from "@earendil-works/pi-durable";
import { int, obj, str } from "@earendil-works/pi-schema";
import {
	agentIdFor,
	type ChatView,
	listDelegations,
	type NekoRuntime,
	onCommits,
	projectChatView,
	SubagentsDoc,
	subagentUsageTotals,
	subtractSubagentUsage,
} from "@neko-harness/core";
import { NekoSubagent } from "./contract.ts";
import { IMAGE_CHUNK_BYTES } from "./image-uploads.ts";
import type { GatewayPrincipal } from "./principal.ts";
import { Owner } from "./session-host.ts";

async function openReader(
	runtime: NekoRuntime,
	childId: number,
	parentId: number,
	context: Context,
	through?: number,
	historyUsage?: ChatView["usage"],
) {
	const child = await runtime.harness.conversation(childId as ConversationId, context);
	if (!child) throw new ChordError("gone", "Subagent unavailable");
	// Only the documents and live state come from the view; entries are paged below.
	const native = await child.watch(context);
	const listeners = new Set<() => void>();
	if (through !== undefined) await native.stop();
	else
		native.start(async () => {
			for (const listener of listeners) listener();
		});
	const project = (entries: readonly EntryRecord[], streaming = true): ChatView => {
		const result = projectChatView({ ...native.value, entries: [...entries].sort((a, b) => a.id - b.id) }, "", {
			models: runtime.listModels(),
		});
		if (!streaming || through !== undefined) {
			result.streaming = null;
			result.busy = false;
			result.status = null;
			if (through !== undefined) {
				result.usage = historyUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
				delete result.contextUsage;
			}
		}
		let order = 0;
		for (const item of result.items) {
			if (item.type !== "tool") order = item.id;
			item.order = order;
		}
		return result;
	};
	const pageAt = async (before?: number) => {
		const max = Math.min(before === undefined ? Infinity : before - 1, through ?? Infinity);
		const page = await child.entries(
			Number.isFinite(max) ? { maxEntryId: max as EntryId } : {},
			100,
			undefined,
			context,
		);
		const entries = [...page.items];
		// Keep the initiating assistant and its tool results on the same page.
		// Otherwise a boundary can turn a completed tool into a pending card.
		while (page.next && !["assistant", "user"].includes(entries.at(-1)?.model?.[0]?.role ?? "")) {
			const extra = await child.entries({ maxEntryId: (entries.at(-1)!.id - 1) as EntryId }, 1, undefined, context);
			entries.push(...extra.items);
			if (!extra.items.length || !extra.next) break;
		}
		const first = entries.at(-1)?.id;
		const older =
			first === undefined
				? []
				: (await child.entries({ maxEntryId: (first - 1) as EntryId }, 1, undefined, context)).items;
		return { entries, next: older.length ? first! : null };
	};
	let revision = 0;
	let sequence = 0;
	const payloads = new Map<number, string>();
	const remember = (value: unknown) => {
		const token = ++sequence;
		payloads.set(token, JSON.stringify(value));
		while (payloads.size > 4) {
			const oldest = [...payloads.keys()].find((key) => key !== revision)!;
			payloads.delete(oldest);
		}
		return token;
	};
	return {
		subscribe: (fn: (event: null) => void) => {
			if (through !== undefined) return () => {};
			const listener = () => fn(null);
			listeners.add(listener);
			const stop = () => listeners.delete(listener);
			const stopApprovals = onCommits(runtime.harness, ({ changes }) => {
				if (
					changes.some(
						(c) =>
							c.type === "document" &&
							["app.neko.approvals", "app.neko.delegations", "app.neko.subagents"].includes(c.record.kind) &&
							c.conversationId === parentId,
					)
				)
					fn(null);
			});
			return () => {
				stop();
				stopApprovals();
			};
		},
		async refresh() {
			const page = await pageAt();
			const approvals =
				through === undefined
					? (await runtime.approvals.list(parentId as ConversationId, context)).filter((a) => a.childId === childId)
					: [];
			const currentUsage = await runtime.harness.snapshot(UsageDoc, childId as ConversationId, context);
			const rounds = (await listDelegations(runtime.harness, parentId as ConversationId, context))
				.filter((r) => r.childId === childId)
				.map(({ usageStart, usageEnd: _end, ...round }) => ({
					...round,
					roundUsage:
						round.roundUsage ??
						(through === undefined && usageStart && currentUsage
							? subagentUsageTotals(subtractSubagentUsage(currentUsage, usageStart))
							: null),
				}));
			revision = remember({ ...project(page.entries), rounds, approvals, historyBefore: page.next });
			return revision;
		},
		async chunk(input: { kind: "view" | "history"; before?: number; token?: number; offset: number }) {
			let token = input.token;
			if (token === undefined) {
				if (input.kind === "view") token = revision;
				else {
					const page = await pageAt(input.before);
					token = remember({ items: project(page.entries, false).items, next: page.next });
				}
			}
			const payload = payloads.get(token);
			if (payload === undefined) throw new ChordError("gone", "Transcript changed; reload");
			if (input.offset > payload.length) throw new ChordError("invalid", "Invalid transcript range");
			const end = Math.min(payload.length, input.offset + 32768);
			return { token, data: payload.slice(input.offset, end), next: end < payload.length ? end : null };
		},
		async history(before?: number) {
			const page = await pageAt(before);
			return { items: project(page.entries, false).items, next: page.next };
		},
		async image(entryId: number, contentIndex: number, offset: number) {
			if (through !== undefined && entryId > through) throw new ChordError("forbidden", "Image outside fork history");
			const page = await child.entries(
				{ minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId },
				1,
				undefined,
				context,
			);
			const content = page.items[0]?.model?.[0]?.content;
			const image = Array.isArray(content) ? content[contentIndex] : undefined;
			if (image?.type !== "image") throw new ChordError("invalid", "Image not in subagent conversation");
			const bytes = Buffer.from(image.data, "base64");
			if (offset > bytes.length) throw new ChordError("invalid", "Invalid image range");
			return {
				data: bytes.subarray(offset, offset + IMAGE_CHUNK_BYTES).toString("base64"),
				total: bytes.length,
				mimeType: image.mimeType,
			};
		},
		close: () => {
			listeners.clear();
			void native.stop();
		},
	};
}
const ChildProjection = local("neko.subagent-projection", {
	version: 1,
	input: obj({ parentId: int(), agentId: str() }, { open: true }),
	members: {
		revision: int(),
		reader: opaque<Awaited<ReturnType<typeof openReader>>>("neko.subagent-reader@1"),
	},
});
export function installSubagentHost(host: Host<GatewayPrincipal>, runtime: NekoRuntime, context: Context) {
	host.serve(ChildProjection, (input, _principal, self) => {
		const revision = self.state("revision", int(), 0);
		const reader = self.resource("reader", {
			version: 1,
			async open() {
				const entry = (await listDelegations(runtime.harness, input.parentId as ConversationId, context)).find((d) =>
					input.agentId.startsWith("round-")
						? d.taskId === Number(input.agentId.slice(6))
						: (d.agentId ?? agentIdFor(d.childId)) === input.agentId,
				);
				if (!entry) throw new ChordError("gone", "Subagent unavailable");
				const r = await openReader(
					runtime,
					entry.childId,
					input.parentId,
					context,
					entry.historyThrough,
					entry.historyUsage,
				);
				try {
					const initial = await r.refresh();
					await host.root((ctx) => revision.replace(ctx, initial));
					return r;
				} catch (error) {
					r.close();
					throw error;
				}
			},
			close: (r) => r.close(),
		});
		self.on(
			"view",
			reader,
			(r) => r,
			async (_event, ctx) => {
				revision.replace(ctx, await reader.value.refresh());
			},
		);
		return { revision, reader: self.expose(reader) };
	});
	host.serve(NekoSubagent, (input, principal, self) => {
		const owner = self.get(Owner, {}, { principal });
		const check = async () => {
			if (owner.owner?.active?.attachmentId !== input.attachmentId || owner.owner.active.sessionId !== input.sessionId)
				throw new ChordError("forbidden", "Attachment expired");
			if (!(await runtime.getConversation(Number(input.sessionId) as ConversationId)))
				throw new ChordError("gone", "Session unavailable");
			const entry = (await listDelegations(runtime.harness, Number(input.sessionId) as ConversationId, context)).find(
				(d) =>
					input.agentId !== undefined
						? (d.agentId ?? agentIdFor(d.childId)) === input.agentId
						: d.taskId === input.taskId,
			);
			if (!entry) throw new ChordError("forbidden", "Subagent does not belong to this session");
			return entry;
		};
		const target = self.resource("target", { version: 1, deps: [owner], open: check });
		const shared = self.get(ChildProjection, {
			parentId: Number(input.sessionId),
			agentId: input.agentId ?? `round-${input.taskId}`,
		});
		const authorizedRevision = self.state("authorizedRevision", int(), 0);
		self.on("authorizedView", shared.revision, async (value, ctx) => {
			try {
				void target.value;
				await check();
				if (value) authorizedRevision.replace(ctx, value);
			} catch {
				authorizedRevision.replace(ctx, 0);
			}
		});
		return {
			variant: "ready",
			revision: authorizedRevision,
			chunk: async (request) => {
				await check();
				return shared.reader!.chunk(request);
			},
			getImage: async ({ entryId, contentIndex, offset }) => {
				await check();
				return shared.reader!.image(entryId, contentIndex, offset);
			},
			decideApproval: async ({ id, version, decision }) => {
				const entry = await check();
				if (entry.historyThrough !== undefined) throw new ChordError("forbidden", "Fork history is read-only");
				const approval = (await runtime.approvals.list(Number(input.sessionId) as ConversationId, context)).find(
					(a) => a.id === id && a.childId === entry.childId,
				);
				if (!approval) throw new ChordError("forbidden", "Approval does not belong to this agent");
				return runtime.approvals.decide(
					Number(input.sessionId) as ConversationId,
					approval.delegationTaskId,
					id,
					version,
					decision,
					context,
				);
			},
			stop: async (request) => {
				const entry = await check();
				if (entry.historyThrough !== undefined) throw new ChordError("forbidden", "Fork history is read-only");
				const taskId = request?.taskId ?? input.taskId;
				if (taskId === undefined) throw new ChordError("invalid", "Select the exact active round to stop");
				const valid = await runtime.harness.commit(async (tx) => {
					const identity = (await tx.doc(SubagentsDoc, Number(input.sessionId) as ConversationId)).items.find(
						(a) => a.childId === entry.childId,
					);
					return identity?.activeRoundId === taskId;
				}, context);
				if (!valid) return null;
				await runtime.harness.abortTask(taskId as TaskId, context);
				await runtime.harness.waitForTask(taskId as TaskId, context);
				return null;
			},
		};
	});
}
