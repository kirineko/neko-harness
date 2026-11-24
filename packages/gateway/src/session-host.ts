import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
	broken,
	ChordError,
	type Ctx,
	type FacetHost,
	forbidden,
	type Implementation,
	invalid,
	isChordError,
} from "@earendil-works/chord";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import {
	type ChatView,
	type JobSummary,
	listDelegations,
	mergeUsage,
	type NekoRuntime,
	type NekoSession,
	onCommits,
	prepareImage,
	projectChatView,
	SubagentsDoc,
	summarizeSubagents,
	totalUsage,
} from "@neko-harness/core";
import { workspaceTarget } from "@neko-harness/core/workspace-files";
import { NekoChat } from "./contract.ts";
import { IMAGE_CHUNK_BYTES, ImageUploads } from "./image-uploads.ts";
import type { GatewayPrincipal } from "./principal.ts";
import { createStateHub, type PrincipalAttachments, type StateHub } from "./state-hub.ts";
import { registerSubagentService } from "./subagent-host.ts";

export function toConversationId(sessionId: string): ConversationId {
	const numeric = Number(sessionId);
	if (!Number.isSafeInteger(numeric) || numeric < 1 || String(numeric) !== sessionId)
		throw invalid("args", `Invalid neko session id: ${sessionId}`);
	return numeric as ConversationId;
}

const emptyView: ChatView = {
	model: "",
	agent: { model: null, thinkingLevel: null },
	cwd: "",
	busy: false,
	queued: [],
	status: null,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	items: [],
	streaming: null,
};

/** The job list is broadcast on every change, so a long command is clipped there; output is read on demand. */
const JOB_COMMAND_PREVIEW_CHARS = 1000;
const clipJob = (job: JobSummary): JobSummary =>
	job.command.length > JOB_COMMAND_PREVIEW_CHARS
		? { ...job, command: `${job.command.slice(0, JOB_COMMAND_PREVIEW_CHARS)}…` }
		: job;

/** The resource has one native view subscription for all attachments, released with its last hold. */
async function openProjection(runtime: NekoRuntime, session: NekoSession, context: Context) {
	const view = await session.follow();
	let changed: ((event: null) => void) | undefined;
	const stop = view.subscribe(() => changed?.(null));
	const stopMetadata = runtime.onDirectoryChange(() => changed?.(null));
	let childIds = new Set<number>();
	const stopChildren = onCommits(runtime.harness, ({ changes }) => {
		if (
			changes.some(
				(change) =>
					(change.type === "entry" &&
						change.value.kind === "pi.tool-result" &&
						childIds.has(change.value.conversationId)) ||
					(change.type === "document" &&
						(([
							"app.neko.delegations",
							"app.neko.approvals",
							"app.neko.subagents",
							"app.neko.jobs",
							"app.neko.todos",
							"app.neko.questions",
							"app.neko.plan",
						].includes(change.record.kind) &&
							change.conversationId === session.id) ||
							(change.record.kind === "pi.usage" &&
								change.conversationId !== undefined &&
								childIds.has(change.conversationId)))),
			)
		)
			changed?.(null);
	});
	return {
		subscribe(fn: (event: null) => void) {
			changed = fn;
			fn(null);
			return () => {
				changed = undefined;
			};
		},
		async project(): Promise<ChatView> {
			const [naming, compaction] = await Promise.all([runtime.namingUsage(session.id), session.compactionRecord()]);
			const projected = projectChatView(
				{
					...view.value,
					docs: {
						...view.value.docs,
						"pi.usage": mergeUsage(
							(view.value.docs["pi.usage"] ?? {
								models: {},
								tools: {},
							}) as import("@earendil-works/pi-durable").UsageState,
							naming,
						),
					},
				},
				"",
				{ models: runtime.listModels(), compaction },
			);
			const jobs = (await session.jobs()).map(clipJob);
			const [todos, questions, plan] = await Promise.all([session.todos(), session.questions(), session.plan()]);
			const changes = await session.changeSummary().catch(() => undefined);
			const subagents = await listDelegations(runtime.harness, session.id, context);
			const approvals = await runtime.approvals.list(session.id, context);
			for (const entry of subagents)
				entry.approvalCount =
					entry.historyThrough === undefined
						? approvals.filter((a) => a.delegationTaskId === entry.taskId && a.status === "pending").length
						: 0;
			childIds = new Set(subagents.filter((entry) => entry.historyThrough === undefined).map((entry) => entry.childId));
			let aggregate = await session.usage();
			for (const child of new Map(
				subagents.filter((entry) => entry.historyThrough === undefined).map((r) => [r.childId, r]),
			).values())
				aggregate = mergeUsage(
					aggregate,
					(await runtime.harness.snapshot(UsageDoc, child.childId as ConversationId, context)) ?? {
						models: {},
						tools: {},
					},
				);
			const u = totalUsage(aggregate);
			return {
				...projected,
				jobs,
				todos,
				questions,
				plan,
				...(changes ? { changes } : {}),
				agents: summarizeSubagents(
					subagents,
					(await runtime.harness.snapshot(SubagentsDoc, session.id, context))?.items,
				),
				subagents: subagents.map(({ usageStart: _start, usageEnd: _end, ...entry }) => ({
					...entry,
					report: entry.report?.slice(0, 512) ?? null,
				})),
				taskUsage: {
					input: u.input,
					output: u.output,
					cacheRead: u.cacheRead,
					cacheWrite: u.cacheWrite,
					cost: u.cost.total,
				},
			};
		},
		async entry(id: number, ctx: Context) {
			ctx.abortSignal?.throwIfAborted();
			return view.entry(id);
		},
		close() {
			stop();
			stopMetadata();
			stopChildren();
			view.dispose();
		},
	};
}

type SharedSessionProjection = {
	readonly hub: StateHub<ChatView>;
	readonly opened: Awaited<ReturnType<typeof openProjection>>;
	dispose(): void;
};

const NO_ARG_CHAT_METHODS = new Set<string>(["abort", "continueRun", "skills", "changesList", "usage"]);

export function registerSessionServices(
	host: FacetHost<GatewayPrincipal>,
	runtime: NekoRuntime,
	context: Context,
	principals: PrincipalAttachments,
) {
	registerSubagentService(host, runtime, context, principals);

	const projections = new Map<
		string,
		{ refs: number; promise: Promise<SharedSessionProjection>; value?: SharedSessionProjection }
	>();

	const startProjection = async (sessionId: string): Promise<SharedSessionProjection> => {
		const convId = toConversationId(sessionId);
		const session = await runtime.getConversation(convId);
		if (!session) throw new ChordError({ code: "gone", message: "Session unavailable" });
		const opened = await openProjection(runtime, session, context);
		try {
			const initial = await opened.project();
			const hub = createStateHub<ChatView>(initial);
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
							const next = await opened.project();
							if (!stopped) hub.set(next);
						} while (dirty && !stopped);
					} catch {
						// Ignore transient projection error during session close; next commit retries.
					} finally {
						running = false;
						if (dirty && !stopped) pump();
					}
				})();
			};
			let primed = false;
			const unsubscribe = opened.subscribe(() => {
				if (!primed) {
					primed = true;
					return;
				}
				dirty = true;
				pump();
			});
			return {
				hub,
				opened,
				dispose() {
					stopped = true;
					unsubscribe();
					hub.clear();
					opened.close();
				},
			};
		} catch (error) {
			opened.close();
			throw error;
		}
	};

	const acquireProjection = async (sessionId: string) => {
		let slot = projections.get(sessionId);
		if (!slot) {
			const created: { refs: number; promise: Promise<SharedSessionProjection>; value?: SharedSessionProjection } = {
				refs: 1,
				promise: startProjection(sessionId),
			};
			slot = created;
			projections.set(sessionId, created);
		} else {
			slot.refs += 1;
		}
		try {
			const shared = await slot.promise;
			slot.value = shared;
			if (slot.refs <= 0) {
				if (projections.get(sessionId) === slot) projections.delete(sessionId);
				shared.dispose();
				throw new ChordError({ code: "released", reason: "ended", message: "Projection released" });
			}
			let released = false;
			return {
				...shared,
				release() {
					if (released) return;
					released = true;
					slot.refs -= 1;
					if (slot.refs <= 0 && projections.get(sessionId) === slot) {
						projections.delete(sessionId);
						shared.dispose();
					}
				},
			};
		} catch (error) {
			slot.refs -= 1;
			if (slot.refs <= 0 && projections.get(sessionId) === slot) projections.delete(sessionId);
			throw error;
		}
	};

	host.serve(NekoChat, (input, principal, self) => {
		const view = self.writable<ChatView>(emptyView);
		const handle = self.open(
			async () => {
				const releasePrincipal = principals.retain(principal);
				try {
					const active = principals.get(principal);
					if (active?.attachmentId !== input.attachmentId || active.sessionId !== input.sessionId) {
						throw forbidden("Attachment does not belong to this connection");
					}
					const convId = toConversationId(input.sessionId);
					const session = await runtime.getConversation(convId);
					if (!session) throw new ChordError({ code: "gone", message: "Session unavailable" });
					const shared = await acquireProjection(input.sessionId);
					try {
						view.set(shared.hub.value);
						const stopHub = shared.hub.subscribe((next) => {
							try {
								view.set(next);
							} catch {}
						});
						const uploads = new ImageUploads();
						return {
							session,
							shared,
							uploads,
							close() {
								stopHub();
								uploads.close();
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
			(value) => value.close(),
		);

		const safeUpload = <T>(action: () => T): T => {
			try {
				return action();
			} catch (error) {
				throw invalid("args", error instanceof Error ? error.message : "Image upload failed");
			}
		};

		const members: Implementation<typeof NekoChat, Ctx<GatewayPrincipal>>["members"] = {
			view: self.derive([view], ([v]) => v),
			draftImage: async ({ id, offset }) => safeUpload(() => handle.value.uploads.read(id, offset)),
			importImage: async (path, ctx) => {
				const current = handle.value;
				const target = await workspaceTarget(current.shared.hub.value.cwd, path);
				const mimeType = (
					{ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<
						string,
						string
					>
				)[extname(target).toLowerCase()];
				if (!mimeType) throw new Error("Only PNG, JPEG and WebP images are supported");
				const agent = await runtime.getAgent(current.session.id);
				const model = runtime
					.listModels()
					.find((m) => m.provider === agent.model?.provider && m.modelId === agent.model?.modelId);
				if (!model?.input.includes("image")) throw new Error("Current model does not support images");
				const fileHandle = await open(target, "r");
				let id: string | undefined;
				try {
					const info = await fileHandle.stat();
					if (!info.isFile()) throw new Error("Image must be a file");
					ctx.abortSignal?.throwIfAborted();
					id = current.uploads.begin({ name: basename(target), mimeType, size: info.size });
					let offset = 0;
					while (offset < info.size) {
						ctx.abortSignal?.throwIfAborted();
						const buffer = Buffer.alloc(Math.min(IMAGE_CHUNK_BYTES, info.size - offset));
						const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, offset);
						if (!bytesRead) throw new Error("Image changed while reading");
						current.uploads.append({ id, offset, data: buffer.subarray(0, bytesRead).toString("base64") });
						offset += bytesRead;
					}
					const after = await fileHandle.stat();
					if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
						throw new Error("Image changed while reading");
					ctx.abortSignal?.throwIfAborted();
					current.uploads.finish(id);
					const resolved = current.uploads.resolve([id])[0];
					if (!resolved) throw new Error("Uploaded image missing");
					await prepareImage(Buffer.from(resolved.content.data, "base64"), mimeType, basename(target), model);
					ctx.abortSignal?.throwIfAborted();
					return { id, name: basename(target) };
				} catch (error) {
					if (id) current.uploads.release(id);
					throw error;
				} finally {
					await fileHandle.close();
				}
			},
			compact: async ({ instructions }) => {
				try {
					await handle.value.session.compact(instructions);
					return null;
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot compact");
				}
			},
			beginImage: async (input) => safeUpload(() => handle.value.uploads.begin(input)),
			appendImage: async (input) => {
				safeUpload(() => handle.value.uploads.append(input));
				return null;
			},
			finishImage: async (id) => {
				safeUpload(() => handle.value.uploads.finish(id));
				return null;
			},
			releaseImage: async (id) => {
				handle.value.uploads.release(id);
				return null;
			},
			getImage: async (input, ctx) => {
				if (
					!Number.isSafeInteger(input.offset) ||
					input.offset < 0 ||
					!Number.isSafeInteger(input.contentIndex) ||
					input.contentIndex < 0
				)
					throw invalid("args", "Invalid image range");
				const entryCtx = ctx.abortSignal ? withAbortSignal(ctx.abortSignal, context) : context;
				const entry = await handle.value.shared.opened.entry(input.entryId, entryCtx);
				const content = entry?.model?.[0]?.content;
				const image = Array.isArray(content) ? content[input.contentIndex] : undefined;
				if (image?.type !== "image") throw invalid("args", "Image is not part of this conversation");
				const bytes = Buffer.from(image.data, "base64");
				if (input.offset > bytes.length) throw invalid("args", "Invalid image range");
				return {
					data: bytes.subarray(input.offset, input.offset + IMAGE_CHUNK_BYTES).toString("base64"),
					total: bytes.length,
					mimeType: image.mimeType,
				};
			},
			submit: async (input) => {
				const current = handle.value;
				try {
					const reqId = input.requestId;
					const duplicate =
						reqId &&
						(await current.session.conversation.commit(
							(tx) => tx.submissionByRequest(current.session.id, reqId),
							context,
						));
					const images = duplicate ? [] : current.uploads.resolve(input.images ?? []);
					await current.session.submit(
						images.length ? [{ type: "text", text: input.content }, ...images.map((i) => i.content)] : input.content,
						{
							imageNames: images.map((i) => i.name),
							...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
							...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
						},
					);
					for (const id of input.images ?? []) current.uploads.release(id);
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot submit message");
				}
				return null;
			},
			abort: async () => {
				await handle.value.session.abort();
				return null;
			},
			continueRun: async () => {
				try {
					await handle.value.session.continueRun();
					return null;
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot continue");
				}
			},
			withdraw: ({ id }) => handle.value.session.withdraw(id),
			steer: ({ id }) => handle.value.session.steer(id),
			questionGet: async ({ id }) => (await handle.value.session.question(id)) ?? null,
			questionRespond: async ({ id, version, response }) => {
				try {
					return await handle.value.session.respondQuestion(id, version, response);
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot answer the question");
				}
			},
			planGet: async ({ version }) => (await handle.value.session.planRecord(version)) ?? null,
			planRespond: async ({ version, decision }) => {
				try {
					return await handle.value.session.respondPlan(version, decision);
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot decide the plan");
				}
			},
			planMode: async ({ mode }) => {
				try {
					return await handle.value.session.setPlanMode(mode);
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot change plan mode");
				}
			},
			skills: () => runtime.listSkills(handle.value.session.id),
			workspaceDir: async ({ path }, ctx) => {
				try {
					return await handle.value.session.workspaceDir(path, ctx.abortSignal);
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot list the directory");
				}
			},
			workspaceFile: async ({ path }, ctx) => {
				try {
					return await handle.value.session.workspaceFile(path, ctx.abortSignal);
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot read the file");
				}
			},
			changesList: async () => handle.value.session.changes(),
			changeGet: async ({ path }) => (await handle.value.session.change(path)) ?? null,
			jobOutput: async ({ jobId, since }) => {
				try {
					const { job, output } = await handle.value.session.jobOutput(jobId, since);
					return { job: clipJob(job), ...output };
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot read job output");
				}
			},
			jobStop: async ({ jobId }) => {
				try {
					return clipJob(await handle.value.session.stopJob(jobId));
				} catch (error) {
					throw invalid("args", error instanceof Error ? error.message : "Cannot stop job");
				}
			},
			usage: async () => {
				const usage = totalUsage(await handle.value.session.usage());
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: usage.cost.total,
				};
			},
			configure: async (change) => {
				const current = handle.value;
				const applied = await runtime.configureConversation(current.session.id, change);
				if (!applied) {
					// 句柄仍在路由中但会话已被归档/删除（竞态窗口）：给前端一个可判读的远程错误。
					throw invalid("args", `Session ${String(current.session.id)} is unavailable or archived`);
				}
				return null;
			},
		};

		// Every call checks the principal's current generation and archival, including stale retained handles.
		const guard = async () => {
			const active = principals.get(principal);
			if (active?.attachmentId !== input.attachmentId || active.sessionId !== input.sessionId)
				throw new ChordError({ code: "gone", message: "Attachment is no longer active" });
			if (!(await runtime.getConversation(toConversationId(input.sessionId))))
				throw new ChordError({ code: "gone", message: "Session unavailable or archived" });
		};

		const mutableMembers = members as Record<string, unknown>;
		for (const name of Object.keys(members)) {
			if (name === "view") continue;
			if (NO_ARG_CHAT_METHODS.has(name)) {
				const fn = mutableMembers[name] as (ctx: Ctx<GatewayPrincipal>) => unknown;
				mutableMembers[name] = async (ctx: Ctx<GatewayPrincipal>) => {
					await guard();
					ctx.abortSignal?.throwIfAborted();
					return fn(ctx);
				};
			} else {
				const fn = mutableMembers[name] as (arg: never, ctx: Ctx<GatewayPrincipal>) => unknown;
				mutableMembers[name] = async (arg: never, ctx: Ctx<GatewayPrincipal>) => {
					await guard();
					ctx.abortSignal?.throwIfAborted();
					return fn(arg, ctx);
				};
			}
		}

		return {
			variant: "ready",
			members,
		};
	});
}
