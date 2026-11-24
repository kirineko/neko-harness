import { broken, ChordError, type FacetHost, forbidden, invalid, isChordError } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, type EntryId, type EntryRecord, type TaskId, UsageDoc } from "@earendil-works/pi-durable";
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
import { type DecodedSubagentTarget, decodeSubagentTarget, NekoSubagent } from "./contract.ts";
import { IMAGE_CHUNK_BYTES } from "./image-uploads.ts";
import type { GatewayPrincipal } from "./principal.ts";
import { createStateHub, type PrincipalAttachments, type StateHub } from "./state-hub.ts";

function parseConversationId(sessionId: string): ConversationId {
	const numeric = Number(sessionId);
	if (!Number.isSafeInteger(numeric) || numeric < 1 || String(numeric) !== sessionId)
		throw invalid("args", `Invalid neko session id: ${sessionId}`);
	return numeric as ConversationId;
}

async function openReader(
	runtime: NekoRuntime,
	childId: number,
	parentId: number,
	context: Context,
	through?: number,
	historyUsage?: ChatView["usage"],
) {
	const child = await runtime.harness.conversation(childId as ConversationId, context);
	if (!child) throw new ChordError({ code: "gone", message: "Subagent unavailable" });
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
			const lastEntry = entries.at(-1);
			if (!lastEntry) break;
			const extra = await child.entries({ maxEntryId: (lastEntry.id - 1) as EntryId }, 1, undefined, context);
			entries.push(...extra.items);
			if (!extra.items.length || !extra.next) break;
		}
		const first = entries.at(-1)?.id;
		const older =
			first === undefined
				? []
				: (await child.entries({ maxEntryId: (first - 1) as EntryId }, 1, undefined, context)).items;
		return { entries, next: older.length && first !== undefined ? first : null };
	};
	let revision = 0;
	let sequence = 0;
	const payloads = new Map<number, string>();
	const remember = (value: unknown) => {
		const token = ++sequence;
		payloads.set(token, JSON.stringify(value));
		while (payloads.size > 4) {
			const oldest = [...payloads.keys()].find((key) => key !== revision);
			if (oldest === undefined) break;
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
			if (payload === undefined) throw new ChordError({ code: "gone", message: "Transcript changed; reload" });
			if (input.offset > payload.length) throw invalid("args", "Invalid transcript range");
			const end = Math.min(payload.length, input.offset + 32768);
			return { token, data: payload.slice(input.offset, end), next: end < payload.length ? end : null };
		},
		async history(before?: number) {
			const page = await pageAt(before);
			return { items: project(page.entries, false).items, next: page.next };
		},
		async image(entryId: number, contentIndex: number, offset: number) {
			if (through !== undefined && entryId > through) throw forbidden("Image outside fork history");
			const page = await child.entries(
				{ minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId },
				1,
				undefined,
				context,
			);
			const content = page.items[0]?.model?.[0]?.content;
			const image = Array.isArray(content) ? content[contentIndex] : undefined;
			if (image?.type !== "image") throw invalid("args", "Image not in subagent conversation");
			const bytes = Buffer.from(image.data, "base64");
			if (offset > bytes.length) throw invalid("args", "Invalid image range");
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

type SharedChildReader = {
	readonly hub: StateHub<number>;
	readonly reader: Awaited<ReturnType<typeof openReader>>;
	dispose(): void;
};

export function registerSubagentService(
	host: FacetHost<GatewayPrincipal>,
	runtime: NekoRuntime,
	context: Context,
	principals: PrincipalAttachments,
) {
	const readers = new Map<string, { refs: number; promise: Promise<SharedChildReader>; value?: SharedChildReader }>();

	const startChildReader = async (
		parentId: ConversationId,
		decoded: DecodedSubagentTarget,
	): Promise<SharedChildReader> => {
		const entry = (await listDelegations(runtime.harness, parentId, context)).find((d) =>
			decoded.kind === "round" ? d.taskId === decoded.taskId : (d.agentId ?? agentIdFor(d.childId)) === decoded.agentId,
		);
		if (!entry) throw new ChordError({ code: "gone", message: "Subagent unavailable" });
		const reader = await openReader(
			runtime,
			entry.childId,
			parentId,
			context,
			entry.historyThrough,
			entry.historyUsage,
		);
		try {
			const initial = await reader.refresh();
			const hub = createStateHub<number>(initial);
			let stopped = false;
			let running = false;
			let dirty = false;
			const pump = () => {
				if (running || stopped) return;
				running = true;
				void (async () => {
					try {
						do {
							dirty = false;
							const next = await reader.refresh();
							if (!stopped) hub.set(next);
						} while (dirty && !stopped);
					} catch {
						// Ignore transient refresh failure during teardown.
					} finally {
						running = false;
						if (dirty && !stopped) pump();
					}
				})();
			};
			const unsubscribe = reader.subscribe(() => {
				dirty = true;
				pump();
			});
			return {
				hub,
				reader,
				dispose() {
					stopped = true;
					unsubscribe();
					hub.clear();
					reader.close();
				},
			};
		} catch (error) {
			reader.close();
			throw error;
		}
	};

	const acquireChildReader = async (parentId: ConversationId, targetKey: string, decoded: DecodedSubagentTarget) => {
		const key = `${parentId}:${targetKey}`;
		let slot = readers.get(key);
		if (!slot) {
			const created: { refs: number; promise: Promise<SharedChildReader>; value?: SharedChildReader } = {
				refs: 1,
				promise: startChildReader(parentId, decoded),
			};
			slot = created;
			readers.set(key, created);
		} else {
			slot.refs += 1;
		}
		try {
			const shared = await slot.promise;
			slot.value = shared;
			if (slot.refs <= 0) {
				if (readers.get(key) === slot) readers.delete(key);
				shared.dispose();
				throw new ChordError({ code: "released", reason: "ended", message: "Subagent released" });
			}
			let released = false;
			return {
				...shared,
				release() {
					if (released) return;
					released = true;
					slot.refs -= 1;
					if (slot.refs <= 0 && readers.get(key) === slot) {
						readers.delete(key);
						shared.dispose();
					}
				},
			};
		} catch (error) {
			slot.refs -= 1;
			if (slot.refs <= 0 && readers.get(key) === slot) readers.delete(key);
			throw error;
		}
	};

	host.serve(NekoSubagent, (input, principal, self) => {
		const check = async () => {
			const decoded = decodeSubagentTarget(input.target);
			if (!decoded) throw invalid("args", `Invalid subagent target: ${input.target}`);
			const parentId = parseConversationId(input.sessionId);
			const active = principals.get(principal);
			if (active?.attachmentId !== input.attachmentId || active.sessionId !== input.sessionId)
				throw forbidden("Attachment expired");
			if (!(await runtime.getConversation(parentId)))
				throw new ChordError({ code: "gone", message: "Session unavailable" });
			const entry = (await listDelegations(runtime.harness, parentId, context)).find((d) =>
				decoded.kind === "agent"
					? (d.agentId ?? agentIdFor(d.childId)) === decoded.agentId
					: d.taskId === decoded.taskId,
			);
			if (!entry) throw forbidden("Subagent does not belong to this session");
			return { entry, decoded, parentId };
		};

		const authorizedRevision = self.writable<number>(0);
		const opened = self.open(
			async () => {
				const releasePrincipal = principals.retain(principal);
				try {
					const { decoded, parentId } = await check();
					const shared = await acquireChildReader(parentId, input.target, decoded);
					try {
						if (shared.hub.value) authorizedRevision.set(shared.hub.value);
						let stopped = false;
						let latest = shared.hub.value;
						let pumping = false;
						let dirty = false;
						const syncRevision = () => {
							if (pumping || stopped) return;
							pumping = true;
							void (async () => {
								try {
									do {
										dirty = false;
										const rev = latest;
										try {
											await check();
											if (!stopped && rev) authorizedRevision.set(rev);
										} catch {
											if (!stopped) {
												try {
													authorizedRevision.set(0);
												} catch {}
											}
										}
									} while (dirty && !stopped);
								} finally {
									pumping = false;
									if (dirty && !stopped) syncRevision();
								}
							})();
						};
						const stopHub = shared.hub.subscribe((rev) => {
							latest = rev;
							dirty = true;
							syncRevision();
						});
						return {
							shared,
							decoded,
							parentId,
							close() {
								stopped = true;
								stopHub();
								shared.release();
								releasePrincipal();
							},
						};
					} catch (error) {
						shared.release();
						throw error;
					}
				} catch (error) {
					releasePrincipal();
					throw isChordError(error) ? broken(error) : error;
				}
			},
			(handle) => handle.close(),
		);

		return {
			variant: "ready",
			members: {
				revision: self.derive([authorizedRevision], ([value]) => value),
				chunk: async (request) => {
					await check();
					return opened.value.shared.reader.chunk(request);
				},
				getImage: async ({ entryId, contentIndex, offset }) => {
					await check();
					return opened.value.shared.reader.image(entryId, contentIndex, offset);
				},
				decideApproval: async ({ id, version, decision }) => {
					const { entry, parentId } = await check();
					if (entry.historyThrough !== undefined) throw forbidden("Fork history is read-only");
					const approval = (await runtime.approvals.list(parentId, context)).find(
						(a) => a.id === id && a.childId === entry.childId,
					);
					if (!approval) throw forbidden("Approval does not belong to this agent");
					return runtime.approvals.decide(parentId, approval.delegationTaskId, id, version, decision, context);
				},
				stop: async (request) => {
					const { entry, decoded, parentId } = await check();
					if (entry.historyThrough !== undefined) throw forbidden("Fork history is read-only");
					const taskId = request?.taskId ?? (decoded.kind === "round" ? decoded.taskId : undefined);
					if (taskId === undefined) throw invalid("args", "Select the exact active round to stop");
					const valid = await runtime.harness.commit(async (tx) => {
						const identity = (await tx.doc(SubagentsDoc, parentId)).items.find((a) => a.childId === entry.childId);
						return identity?.activeRoundId === taskId;
					}, context);
					if (!valid) return null;
					await runtime.harness.abortTask(taskId as TaskId, context);
					await runtime.harness.waitForTask(taskId as TaskId, context);
					return null;
				},
			},
		};
	});
}
