import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
	ChordError,
	type Context,
	type Ctx,
	type Host,
	type ImplementationOf,
	type LocalContract,
	local,
	opaque,
} from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { type ConversationId, type EntryRecord, UsageDoc } from "@earendil-works/pi-durable";
import {
	type ChatView,
	type JobSummary,
	listDelegations,
	mergeUsage,
	type NekoRuntime,
	type NekoSession,
	prepareImage,
	projectChatView,
	SubagentsDoc,
	summarizeSubagents,
	totalUsage,
} from "@neko-harness/core";
import { workspaceTarget } from "@neko-harness/core/workspace-files";
import { Type } from "typebox";
import { ChatViewSchema, type NekoAttachment, NekoChat } from "./contract.ts";
import { IMAGE_CHUNK_BYTES, ImageUploads } from "./image-uploads.ts";
import type { GatewayPrincipal } from "./principal.ts";
import { installSubagentHost } from "./subagent-host.ts";
export type AttachmentOwner = { active: NekoAttachment | null };
const OwnerInput = Type.Object({});
export const Owner: LocalContract<{
	version: 1;
	input: typeof OwnerInput;
	members: { owner: ReturnType<typeof opaque<AttachmentOwner>> };
}> = local("neko.attachment-owner", {
	version: 1,
	input: OwnerInput,
	members: { owner: opaque<AttachmentOwner>("neko.owner@1") },
});
const Projection = local("neko.projection", {
	version: 1,
	input: Type.Object({ id: Type.String() }),
	members: {
		view: ChatViewSchema,
		reader: opaque<Awaited<ReturnType<typeof openProjection>>>("neko.projection-reader@1"),
	},
});
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
	const view = await session.viewState();
	const history = new Map<number, EntryRecord>();
	let cursor: import("@earendil-works/pi-durable").Cursor | undefined;
	do {
		const page = await session.conversation.entries({ order: "ascending" }, 100, cursor, context);
		for (const entry of page.items) history.set(entry.id, entry);
		cursor = page.next;
	} while (cursor);
	let changed: ((event: null) => void) | undefined;
	const stop = view.subscribe(() => changed?.(null));
	const stopMetadata = runtime.onDirectoryChange(() => changed?.(null));
	let childIds = new Set<number>();
	const stopChildren = runtime.harness.subscribeCommits(({ changes }) => {
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
		async project() {
			for (const entry of view.value.entries) history.set(entry.id, entry);
			const [naming, compaction] = await Promise.all([runtime.namingUsage(session.id), session.compactionRecord()]);
			const projected = projectChatView(
				{
					...view.value,
					entries: [...history.values()].sort((a, b) => a.id - b.id),
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
				{ models: runtime.listModels(), contextEntries: view.value.entries, compaction },
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
			for (const entry of view.value.entries) history.set(entry.id, entry);
			return history.get(id);
		},
		close() {
			stop();
			stopMetadata();
			stopChildren();
			view.dispose();
			history.clear();
		},
	};
}
export function serveSessions(host: Host<GatewayPrincipal>, runtime: NekoRuntime, context: Context) {
	installSubagentHost(host, runtime, context);
	host.serve(Owner, (_input, _principal, self) => {
		const owner = self.resource("owner", {
			version: 1,
			open: () => ({ active: null }) as AttachmentOwner,
			close: (value) => {
				value.active = null;
			},
		});
		return { owner: self.expose(owner) };
	});
	host.serve(Projection, (input, _principal, self) => {
		const view = self.state("view", ChatViewSchema, emptyView);
		const projection = self.resource("projection", {
			version: 1,
			async open({ signal }) {
				const session = await runtime.getConversation(Number(input.id) as NekoSession["id"]);
				if (!session) throw new ChordError("gone", "Session unavailable");
				const opened = await openProjection(runtime, session, context);
				try {
					const initial = await opened.project();
					await host.root((ctx) => view.replace(ctx, initial), { signal });
					return opened;
				} catch (error) {
					opened.close();
					throw error;
				}
			},
			close: (value) => value.close(),
		});
		self.on(
			"view",
			projection,
			(value) => value,
			async (_event, ctx) => {
				view.replace(ctx, await projection.value.project());
			},
		);
		return { view, reader: self.expose(projection) };
	});
	host.serve(NekoChat, (input, principal, self) => {
		const owner = self.get(Owner, {}, { principal });
		const shared = self.get(Projection, { id: input.sessionId });
		const uploads = self.resource("uploads", {
			version: 1,
			open: () => new ImageUploads(),
			close: (value) => value.close(),
		});
		const projection = self.resource("projection", {
			version: 1,
			deps: [owner],
			async open() {
				if (
					owner.owner?.active?.attachmentId !== input.attachmentId ||
					owner.owner.active.sessionId !== input.sessionId
				)
					throw new ChordError("forbidden", "Attachment does not belong to this connection");
				const session = await runtime.getConversation(Number(input.sessionId) as NekoSession["id"]);
				if (!session) throw new ChordError("gone", "Session unavailable");
				return {
					session,
				};
			},
		});
		const safeUpload = <T>(action: () => T): T => {
			try {
				return action();
			} catch (error) {
				throw new ChordError("invalid", error instanceof Error ? error.message : "Image upload failed");
			}
		};
		const behavior: ImplementationOf<typeof NekoChat> = {
			variant: "ready",
			view: shared.view,
			draftImage: async ({ id, offset }) => safeUpload(() => uploads.value.read(id, offset)),
			importImage: async (path, ctx) => {
				const target = await workspaceTarget(shared.view.value!.cwd, path);
				const mimeType = (
					{ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<
						string,
						string
					>
				)[extname(target).toLowerCase()];
				if (!mimeType) throw new Error("Only PNG, JPEG and WebP images are supported");
				const agent = await runtime.getAgent(projection.value.session.id);
				const model = runtime
					.listModels()
					.find((m) => m.provider === agent.model?.provider && m.modelId === agent.model?.modelId);
				if (!model?.input.includes("image")) throw new Error("Current model does not support images");
				const handle = await open(target, "r");
				let id: string | undefined;
				try {
					const info = await handle.stat();
					if (!info.isFile()) throw new Error("Image must be a file");
					ctx.signal?.throwIfAborted();
					id = uploads.value.begin({ name: basename(target), mimeType, size: info.size });
					let offset = 0;
					while (offset < info.size) {
						ctx.signal?.throwIfAborted();
						const buffer = Buffer.alloc(Math.min(IMAGE_CHUNK_BYTES, info.size - offset));
						const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
						if (!bytesRead) throw new Error("Image changed while reading");
						uploads.value.append({ id, offset, data: buffer.subarray(0, bytesRead).toString("base64") });
						offset += bytesRead;
					}
					const after = await handle.stat();
					if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
						throw new Error("Image changed while reading");
					ctx.signal?.throwIfAborted();
					uploads.value.finish(id);
					const raw = uploads.value.resolve([id])[0]!;
					await prepareImage(Buffer.from(raw.content.data, "base64"), mimeType, basename(target), model);
					ctx.signal?.throwIfAborted();
					return { id, name: basename(target) };
				} catch (error) {
					if (id) uploads.value.release(id);
					throw error;
				} finally {
					await handle.close();
				}
			},
			compact: async ({ instructions }) => {
				try {
					await projection.value.session.compact(instructions);
					return null;
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot compact");
				}
			},
			beginImage: async (input) => safeUpload(() => uploads.value.begin(input)),
			appendImage: async (input) => {
				safeUpload(() => uploads.value.append(input));
				return null;
			},
			finishImage: async (id) => {
				safeUpload(() => uploads.value.finish(id));
				return null;
			},
			releaseImage: async (id) => {
				uploads.value.release(id);
				return null;
			},
			getImage: async (input, ctx) => {
				if (
					!Number.isSafeInteger(input.offset) ||
					input.offset < 0 ||
					!Number.isSafeInteger(input.contentIndex) ||
					input.contentIndex < 0
				)
					throw new ChordError("invalid", "Invalid image range");
				const entry = await shared.reader!.entry(input.entryId, withAbortSignal(ctx.signal, context));
				const content = entry?.model?.[0]?.content;
				const image = Array.isArray(content) ? content[input.contentIndex] : undefined;
				if (image?.type !== "image") throw new ChordError("invalid", "Image is not part of this conversation");
				const bytes = Buffer.from(image.data, "base64");
				if (input.offset > bytes.length) throw new ChordError("invalid", "Invalid image range");
				return {
					data: bytes.subarray(input.offset, input.offset + IMAGE_CHUNK_BYTES).toString("base64"),
					total: bytes.length,
					mimeType: image.mimeType,
				};
			},
			submit: async (input) => {
				try {
					const duplicate =
						input.requestId &&
						(await projection.value.session.conversation.commit(
							(tx) => tx.submissionByRequest(projection.value.session.id, input.requestId!),
							context,
						));
					const images = duplicate ? [] : uploads.value.resolve(input.images ?? []);
					await projection.value.session.submit(
						images.length ? [{ type: "text", text: input.content }, ...images.map((i) => i.content)] : input.content,
						{
							imageNames: images.map((i) => i.name),
							...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
							...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
						},
					);
					for (const id of input.images ?? []) uploads.value.release(id);
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot submit message");
				}
				return null;
			},
			abort: async () => {
				await projection.value.session.abort();
				return null;
			},
			withdraw: ({ id }) => projection.value.session.withdraw(id),
			steer: ({ id }) => projection.value.session.steer(id),
			questionGet: async ({ id }) => (await projection.value.session.question(id)) ?? null,
			questionRespond: async ({ id, version, response }) => {
				try {
					return await projection.value.session.respondQuestion(id, version, response);
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot answer the question");
				}
			},
			planGet: async ({ version }) => (await projection.value.session.planRecord(version)) ?? null,
			planRespond: async ({ version, decision }) => {
				try {
					return await projection.value.session.respondPlan(version, decision);
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot decide the plan");
				}
			},
			planMode: async ({ mode }) => {
				try {
					return await projection.value.session.setPlanMode(mode);
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot change plan mode");
				}
			},
			skills: () => runtime.listSkills(projection.value.session.id),
			workspaceDir: async ({ path }, ctx) => {
				try {
					return await projection.value.session.workspaceDir(path, ctx.signal);
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot list the directory");
				}
			},
			workspaceFile: async ({ path }, ctx) => {
				try {
					return await projection.value.session.workspaceFile(path, ctx.signal);
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot read the file");
				}
			},
			changesList: async () => projection.value.session.changes(),
			changeGet: async ({ path }) => (await projection.value.session.change(path)) ?? null,
			jobOutput: async ({ jobId, since }) => {
				try {
					const { job, output } = await projection.value.session.jobOutput(jobId, since);
					return { job: clipJob(job), ...output };
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot read job output");
				}
			},
			jobStop: async ({ jobId }) => {
				try {
					return clipJob(await projection.value.session.stopJob(jobId));
				} catch (error) {
					throw new ChordError("invalid", error instanceof Error ? error.message : "Cannot stop job");
				}
			},
			usage: async () => {
				const usage = totalUsage(await projection.value.session.usage());
				return {
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: usage.cost.total,
				};
			},
			configure: async (change) => {
				const applied = await runtime.configureConversation(projection.value.session.id, change);
				if (!applied) {
					// 句柄仍在路由中但会话已被归档/删除（竞态窗口）：给前端一个可判读的远程错误。
					throw new ChordError("invalid", `Session ${String(projection.value.session.id)} is unavailable or archived`);
				}
				return null;
			},
		};
		// Every call checks the principal's current generation and archival, including stale retained handles.
		const guard = async () => {
			if (owner.owner?.active?.attachmentId !== input.attachmentId || owner.owner.active.sessionId !== input.sessionId)
				throw new ChordError("gone", "Attachment is no longer active");
			if (!(await runtime.getConversation(Number(input.sessionId) as NekoSession["id"])))
				throw new ChordError("gone", "Session unavailable or archived");
		};
		for (const name of Object.keys(
			NekoChat.def.variants.ready.methods,
		) as (keyof typeof NekoChat.def.variants.ready.methods)[]) {
			const method = behavior[name] as (arg: never, ctx: Ctx<GatewayPrincipal>) => unknown;
			(behavior as unknown as Record<string, unknown>)[name] = async (arg: never, ctx: Ctx<GatewayPrincipal>) => {
				await guard();
				ctx.signal.throwIfAborted();
				return method(arg, ctx);
			};
		}
		return behavior;
	});
}
