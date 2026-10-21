import { ChordError, type Ref } from "@earendil-works/chord";
import { agentIdFor } from "@neko-harness/core";
import { byMessage, messageTime } from "@neko-harness/core/session-display";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { RawData, WebSocket } from "ws";
import type {
	NekoAttachment,
	NekoChat,
	NekoSessionDirectory,
	NekoSessionManagement,
	NekoSubagent,
	NekoWorkspaces,
} from "../contract.ts";
import { type SubagentClient, subagentClient } from "../subagent-client.ts";
import { MobileChatProjection, ProjectionError, type ProjectionNotice, type ProjectionSource } from "./projection.ts";
import {
	asJsonRpcRequest,
	buildHelloResult,
	incompatibleNeeds,
	isMobileHelloParams,
	type JsonRpcId,
	MOBILE_API_V1_METHODS,
	MOBILE_CLOSE_INCOMPATIBLE,
	MOBILE_CLOSE_REVOKED,
	MOBILE_CLOSE_SLOW_CONSUMER,
	MOBILE_LIMITS,
	type MobileErrorCode,
	negotiateApiVersion,
} from "./protocol.ts";

/** 待决审批的最小读取面（`runtime.approvals.list` 的形状）。 */
export type MobileApprovalRecord = {
	readonly id: number;
	readonly version: string;
	readonly childId: number;
	readonly delegationTaskId: number;
	readonly command: string;
	readonly cwd: string;
	readonly timeout: number | null;
	readonly status: "pending" | "allowed" | "denied" | "cancelled";
	readonly createdAt: number;
};

/** 现有契约未暴露的只读查询，由 gateway 在校验 attachment 归属后直接读 runtime（design D6）。 */
export type MobileRuntimeBridge = {
	listApprovals(sessionId: string): Promise<readonly MobileApprovalRecord[]>;
	submissionAccepted(sessionId: string, requestId: string): Promise<boolean>;
};

export type MobileAdapterOptions = {
	readonly socket: WebSocket;
	readonly connectionId: string;
	readonly deviceId: string;
	readonly grantRevision: number;
	readonly serverId: string;
	readonly serverName: string;
	readonly services: () => MobileServices;
	readonly runtime?: MobileRuntimeBridge;
	/** 设备记录仍存在且 grantRevision 未变（design D7）；缺省视为始终有效。 */
	readonly authorized?: () => boolean;
	readonly onClose: () => void;
	readonly onError?: (error: Error) => void;
};

/** per-phone 复用的桌面服务句柄（白名单：目录/管理/工作区/聊天/子 agent，见 design D6）。 */
export type MobileServices = {
	readonly directory: Ref<typeof NekoSessionDirectory>;
	readonly management: Ref<typeof NekoSessionManagement>;
	readonly workspaces: Ref<typeof NekoWorkspaces>;
	readonly openChat?: (attachment: NekoAttachment) => Ref<typeof NekoChat>;
	readonly openSubagent?: (
		input: NekoAttachment & { readonly taskId?: number; readonly agentId?: string },
	) => Ref<typeof NekoSubagent>;
};

const CLOSE_INVALID_JSON = 1003;
const CLOSE_PROTOCOL_ERROR = 1002;
const ACTIVE_ROUND = new Set(["queued", "running"]);

/** 业务方法抛出的稳定错误，dispatch 统一映射为 JSON-RPC error。 */
class MobileMethodError extends Error {
	readonly mobileCode: MobileErrorCode;

	constructor(code: MobileErrorCode, message: string) {
		super(message);
		this.name = "MobileMethodError";
		this.mobileCode = code;
	}
}

function chordToMobileCode(error: ChordError): MobileErrorCode {
	switch (error.code) {
		case "gone":
			return "gone";
		case "invalid":
			return "invalid_params";
		case "forbidden":
			return "gone";
		default:
			return "internal";
	}
}

/** ChordError → 稳定错误码；`invalid` 可按调用场景改为 `rejected`（电脑端拒绝受理，原因原样返回）。 */
async function remote<T>(work: () => Promise<T>, invalidAs: MobileErrorCode = "invalid_params"): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof MobileMethodError) throw error;
		if (error instanceof ChordError) {
			const code = chordToMobileCode(error);
			throw new MobileMethodError(code === "invalid_params" ? invalidAs : code, error.message);
		}
		throw error;
	}
}

function rawDataToBuffer(data: RawData): Buffer {
	if (typeof data === "string") return Buffer.from(data, "utf8");
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}

function baseName(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, "");
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

type ChatState = {
	readonly subscriptionId: string;
	readonly sessionId: string;
	readonly attachment: NekoAttachment;
	readonly chat: Ref<typeof NekoChat>;
	readonly projection: MobileChatProjection;
	/** 释放视图与审批订阅；快照同步建立后赋值。 */
	cleanup: () => void;
	approvalsKey: string;
	approvalsRevision: number;
	approvalsRunning: boolean;
	approvalsDirty: boolean;
	/** Last revisions told to the app; a view change with a higher one sends the matching `*.changed`. */
	todosRevision: number;
	questionsRevision: number;
	planRevision: number;
};

type SubagentState = {
	readonly subscriptionId: string;
	readonly chatSubscriptionId: string;
	readonly agentId: string;
	readonly client: SubagentClient;
	readonly projection: MobileChatProjection;
	readonly stop: () => void;
};

export class MobileAdapter {
	readonly connectionId: string;
	readonly deviceId: string;
	readonly grantRevision: number;

	private readonly socket: WebSocket;
	private readonly serverId: string;
	private readonly serverName: string;
	private readonly services: () => MobileServices;
	private readonly runtime: MobileRuntimeBridge | undefined;
	private readonly authorized: () => boolean;
	private readonly onClose: () => void;
	private readonly onError: ((error: Error) => void) | undefined;
	private saidHello = false;
	private disposed = false;
	private inFlight = 0;
	private sequence = 0;
	private attachGeneration = 0;
	private subagentGeneration = 0;
	private chatState: ChatState | undefined;
	private subagentState: SubagentState | undefined;

	constructor(options: MobileAdapterOptions) {
		this.socket = options.socket;
		this.connectionId = options.connectionId;
		this.deviceId = options.deviceId;
		this.grantRevision = options.grantRevision;
		this.serverId = options.serverId;
		this.serverName = options.serverName;
		this.services = options.services;
		this.runtime = options.runtime;
		this.authorized = options.authorized ?? (() => true);
		this.onClose = options.onClose;
		this.onError = options.onError;
	}

	start(): void {
		this.socket.on("message", (data: RawData) => this.handleMessage(data));
		this.socket.on("close", () => this.dispose());
		this.socket.on("error", () => this.dispose());
	}

	close(code: number, reason: string): void {
		if (this.disposed) return;
		try {
			this.socket.close(code, reason);
		} catch {
			this.socket.terminate();
		}
	}

	sendNotification(method: string, params: unknown): void {
		if (!this.saidHello) return;
		this.send({ jsonrpc: "2.0", method, params });
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.attachGeneration += 1;
		// 断线只释放观察与查询；已受理的回答、子任务与待决审批继续由电脑处理（design D7）。
		this.closeSubagent();
		this.releaseChat();
		this.onClose();
	}

	private handleMessage(data: RawData): void {
		let message: unknown;
		try {
			message = JSON.parse(rawDataToBuffer(data).toString("utf8"));
		} catch {
			this.close(CLOSE_INVALID_JSON, "invalid_json");
			return;
		}
		this.dispatch(message);
	}

	private dispatch(message: unknown): void {
		const request = asJsonRpcRequest(message);
		if (request === undefined) {
			this.close(CLOSE_PROTOCOL_ERROR, "invalid_request");
			return;
		}
		if (request.method === "server.hello") {
			this.handleHello(request.id, request.params);
			return;
		}
		if (!this.saidHello) {
			this.close(CLOSE_PROTOCOL_ERROR, "hello_required");
			return;
		}
		if (!this.authorized()) {
			this.close(MOBILE_CLOSE_REVOKED, "revoked");
			return;
		}
		if (this.inFlight >= MOBILE_LIMITS.maxConcurrentRequests) {
			this.sendError(request.id, -32_000, "too many concurrent requests", { code: "busy_limit" });
			return;
		}
		this.inFlight += 1;
		void this.handleMethod(request.id, request.method, request.params)
			.catch((error: unknown) => {
				if (this.disposed) return;
				if (error instanceof MobileMethodError) {
					this.sendError(request.id, -32_000, error.message, { code: error.mobileCode });
					return;
				}
				if (error instanceof ProjectionError) {
					this.sendError(request.id, -32_000, error.message, { code: error.code });
					return;
				}
				if (error instanceof ChordError) {
					this.sendError(request.id, -32_000, error.message, { code: chordToMobileCode(error) });
					return;
				}
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
				this.sendError(request.id, -32_603, "internal", { code: "internal" });
			})
			.finally(() => {
				this.inFlight -= 1;
			});
	}

	private async handleMethod(id: JsonRpcId, method: string, rawParams: unknown): Promise<void> {
		// JSON-RPC 允许省略 params；无参方法统一按 null 校验。
		const params = rawParams === undefined ? null : rawParams;
		const spec = MOBILE_API_V1_METHODS[method] as { readonly params: TSchema; readonly result: TSchema } | undefined;
		if (spec === undefined || method === "server.hello") {
			this.sendError(id, -32_601, "method not found", { code: "not_found" });
			return;
		}
		if (!Check(spec.params, params)) {
			this.sendError(id, -32_602, "invalid params", { code: "invalid_params" });
			return;
		}
		const result = await this.invoke(method, params as never);
		if (!Check(spec.result, result)) {
			this.onError?.(new Error(`mobile result for ${method} does not match its schema`));
			this.sendError(id, -32_603, "internal result mismatch", { code: "internal" });
			return;
		}
		this.sendResult(id, result);
	}

	private async invoke(method: string, params: never): Promise<unknown> {
		switch (method) {
			case "workspaces.list":
				return this.workspacesList();
			case "sessions.list":
				return this.sessionsList(params);
			case "sessions.create":
				return this.sessionsCreate(params);
			case "chat.attach":
				return this.chatAttach(params);
			case "chat.detach":
				return this.chatDetach(params);
			case "chat.history":
				return this.pageHistory(this.requireChat(params).projection, params);
			case "chat.content":
				return this.chatContent(params);
			case "chat.submit":
				return this.chatSubmit(params);
			case "chat.submissionStatus":
				return this.chatSubmissionStatus(params);
			case "chat.steer":
				return this.chatSteer(params);
			case "chat.withdraw":
				return this.chatWithdraw(params);
			case "chat.abort":
				return this.chatAbort(params);
			case "subagents.open":
				return this.subagentsOpen(params);
			case "subagents.history":
				return this.pageHistory(this.requireSubagent(params).projection, params);
			case "subagents.close":
				return this.subagentsClose(params);
			case "subagents.stop":
				return this.subagentsStop(params);
			case "approvals.list":
				return { approvals: await this.pendingApprovals(this.requireChat(params)) };
			case "approvals.get":
				return this.approvalsGet(params);
			case "approvals.decide":
				return this.approvalsDecide(params);
			case "todos.get":
				return this.todosGet(params);
			case "questions.list":
				return this.questionsList(params);
			case "questions.get":
				return this.questionsGet(params);
			case "questions.respond":
				return this.questionsRespond(params);
			case "plan.get":
				return this.planGet(params);
			case "plan.respond":
				return this.planRespond(params);
			case "plan.exit":
				return this.planExit(params);
			case "media.read":
				return this.mediaRead(params);
			default:
				throw new MobileMethodError("not_found", "method not found");
		}
	}

	private pageHistory(projection: MobileChatProjection, params: { before: string; limit?: number }) {
		return projection.history(params.before, params.limit);
	}

	/** 副作用前复核授权：撤销后到达的请求失败，已进入底层服务的请求按原语义结算（design D7）。 */
	private assertAuthorized(): void {
		if (this.disposed || !this.authorized()) {
			this.close(MOBILE_CLOSE_REVOKED, "revoked");
			throw new MobileMethodError("revoked", "device authorization was revoked");
		}
	}

	// ——— workspaces / sessions ———

	private async workspacesList(): Promise<unknown> {
		const { workspaces } = this.services();
		await workspaces.ready;
		const state = workspaces.state.value;
		return {
			workspaces: state.workspaces.map((workspace) => ({ root: workspace.path, name: baseName(workspace.path) })),
		};
	}

	private async registeredWorkspaceRoots(): Promise<string[]> {
		const { workspaces } = this.services();
		await workspaces.ready;
		return workspaces.state.value.workspaces.map((workspace) => workspace.path);
	}

	private async sessionsList(params: { workspace: string; query?: string; cursor?: string }): Promise<unknown> {
		const roots = await this.registeredWorkspaceRoots();
		if (!roots.includes(params.workspace))
			throw new MobileMethodError("invalid_params", `unknown workspace: ${params.workspace}`);
		const offset = params.cursor === undefined ? 0 : Number.parseInt(params.cursor, 10);
		if (!Number.isInteger(offset) || offset < 0) throw new MobileMethodError("invalid_params", "invalid cursor");
		const { directory: directoryRef } = this.services();
		await directoryRef.ready;
		const directory = directoryRef.state.value;
		let sessions = directory.sessions.filter((session) => session.workspaceRoot === params.workspace);
		if (params.query !== undefined) {
			const query = params.query.toLowerCase();
			sessions = sessions.filter(
				(session) =>
					session.title.toLowerCase().includes(query) || session.firstPromptPreview.toLowerCase().includes(query),
			);
		}
		sessions = [...sessions].sort(byMessage);
		const page = sessions.slice(offset, offset + MOBILE_LIMITS.pageItems);
		return {
			sessions: page.map((session) => ({
				id: session.id,
				workspace: session.workspaceRoot,
				title: session.title,
				preview: session.firstPromptPreview,
				lastUsedAt: Math.round(session.lastUsedAt),
				lastMessageAt: Math.round(messageTime(session)),
				archived: false,
				...(session.awaitingAnswer === undefined ? {} : { awaitingAnswer: session.awaitingAnswer }),
				...(session.awaitingPlan === undefined ? {} : { awaitingPlan: session.awaitingPlan }),
			})),
			...(offset + page.length < sessions.length ? { nextCursor: String(offset + page.length) } : {}),
		};
	}

	private async sessionsCreate(params: { workspace: string }): Promise<unknown> {
		const roots = await this.registeredWorkspaceRoots();
		if (!roots.includes(params.workspace))
			throw new MobileMethodError("invalid_params", `unknown workspace: ${params.workspace}`);
		this.assertAuthorized();
		const created = await remote(() => this.services().management.create({ cwd: params.workspace }));
		return {
			id: created.id,
			workspace: created.workspaceRoot,
			title: created.title,
			preview: created.firstPromptPreview,
			lastUsedAt: Math.round(created.lastUsedAt),
			lastMessageAt: Math.round(messageTime(created)),
			archived: false,
			...(created.awaitingAnswer === undefined ? {} : { awaitingAnswer: created.awaitingAnswer }),
			...(created.awaitingPlan === undefined ? {} : { awaitingPlan: created.awaitingPlan }),
		};
	}

	// ——— chat ———

	private nextId(prefix: string): string {
		this.sequence += 1;
		return `${prefix}-${this.connectionId.slice(0, 8)}-${this.sequence}`;
	}

	private requireChat(params: { subscriptionId?: string }): ChatState {
		const state = this.chatState;
		if (state === undefined || state.subscriptionId !== params.subscriptionId)
			throw new MobileMethodError("gone", "subscription is no longer active");
		return state;
	}

	private releaseChat(): void {
		const state = this.chatState;
		if (state === undefined) return;
		this.chatState = undefined;
		state.projection.dispose();
		state.cleanup();
		state.chat.release();
	}

	private async chatAttach(params: { sessionId: string }): Promise<unknown> {
		const services = this.services();
		if (services.openChat === undefined) throw new MobileMethodError("not_found", "chat is not available");
		const generation = ++this.attachGeneration;
		this.closeSubagent();
		this.releaseChat();
		const attachment = await remote(() => services.management.attach(params.sessionId));
		if (generation !== this.attachGeneration || this.disposed)
			throw new MobileMethodError("gone", "superseded by a newer attach");
		const chat = services.openChat(attachment);
		const stopView = chat.view.subscribe(() => {});
		try {
			await remote(() => chat.ready);
		} catch (error) {
			stopView();
			chat.release();
			throw error;
		}
		if (generation !== this.attachGeneration || this.disposed) {
			stopView();
			chat.release();
			throw new MobileMethodError("gone", "superseded by a newer attach");
		}
		// 审批集合先于快照读取；快照之后到最终响应之间不再有 await，补丁不会先于响应送达。
		const approvalsKey = await this.approvalsKey(attachment.sessionId).catch(() => "");
		if (generation !== this.attachGeneration || this.disposed) {
			stopView();
			chat.release();
			throw new MobileMethodError("gone", "superseded by a newer attach");
		}
		const subscriptionId = this.nextId("chat");
		const source: ProjectionSource = {
			get value() {
				return chat.view.value;
			},
			subscribe: (listener) => chat.view.subscribe(() => listener()),
		};
		const projection = new MobileChatProjection({
			subscriptionId,
			owner: { sessionId: attachment.sessionId },
			source,
			onNotice: (notice) => this.forwardNotice("chat", subscriptionId, notice),
		});
		const state: ChatState = {
			subscriptionId,
			sessionId: attachment.sessionId,
			attachment,
			chat,
			projection,
			cleanup: stopView,
			approvalsKey,
			approvalsRevision: 0,
			approvalsRunning: false,
			approvalsDirty: false,
			todosRevision: chat.view.value?.todos?.revision ?? 0,
			questionsRevision: chat.view.value?.questions?.revision ?? 0,
			planRevision: chat.view.value?.plan?.revision ?? 0,
		};
		this.chatState = state;
		const snapshot = projection.snapshot();
		const stopApprovals = chat.view.subscribe(() => this.refreshApprovals(state));
		const stopInteractions = chat.view.subscribe(() => this.refreshInteractions(state));
		state.cleanup = () => {
			stopApprovals();
			stopInteractions();
			stopView();
		};
		return { subscriptionId, sessionId: attachment.sessionId, snapshot };
	}

	private forwardNotice(kind: "chat" | "subagents", subscriptionId: string, notice: ProjectionNotice): void {
		const idField = kind === "chat" ? "subscriptionId" : "subagentSubscriptionId";
		const method = `${kind}.${notice.kind}`;
		this.sendNotification(method, { [idField]: subscriptionId, ...notice.params });
	}

	private async chatDetach(params: { subscriptionId: string }): Promise<null> {
		if (this.chatState?.subscriptionId !== params.subscriptionId) return null;
		this.attachGeneration += 1;
		this.closeSubagent();
		this.releaseChat();
		await remote(() => this.services().management.detach(null)).catch(() => undefined);
		return null;
	}

	private chatContent(params: {
		ref: { sessionId: string; agentId?: string; key: string; field: string; digest: string };
		offset: number;
	}): unknown {
		const { ref } = params;
		let projection: MobileChatProjection;
		if (ref.agentId !== undefined) {
			const state = this.subagentState;
			if (state === undefined || state.agentId !== ref.agentId || this.chatState?.sessionId !== ref.sessionId)
				throw new MobileMethodError("gone", "subagent view is no longer open");
			projection = state.projection;
		} else {
			if (this.chatState?.sessionId !== ref.sessionId)
				throw new MobileMethodError("gone", "session is no longer attached");
			projection = this.chatState.projection;
		}
		const chunk = projection.content(ref, params.offset);
		const nextOffset = params.offset + chunk.bytes.length;
		return {
			data: chunk.bytes.toString("base64"),
			nextOffset,
			total: chunk.total,
			done: nextOffset >= chunk.total,
		};
	}

	private async chatSubmit(params: {
		subscriptionId: string;
		requestId: string;
		text: string;
		mode?: "steer";
	}): Promise<unknown> {
		const state = this.requireChat(params);
		const busy = state.chat.view.value?.busy ?? false;
		this.assertAuthorized();
		await remote(
			() =>
				state.chat.submit({
					content: params.text,
					requestId: params.requestId,
					...(params.mode === "steer" ? { whenBusy: "steer" as const } : {}),
				}),
			"rejected",
		);
		return { accepted: true, queued: busy && params.mode !== "steer" };
	}

	private async chatSubmissionStatus(params: { subscriptionId: string; requestId: string }): Promise<unknown> {
		const state = this.requireChat(params);
		if (this.runtime === undefined) return { status: "unknown" };
		const accepted = await this.runtime.submissionAccepted(state.sessionId, params.requestId);
		return { status: accepted ? "accepted" : "unknown" };
	}

	private async chatSteer(params: { subscriptionId: string; id: number }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		return remote(() => state.chat.steer({ id: params.id }), "rejected");
	}

	private async chatWithdraw(params: { subscriptionId: string; id: number }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		return remote(() => state.chat.withdraw({ id: params.id }), "rejected");
	}

	private async chatAbort(params: { subscriptionId: string }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		await remote(() => state.chat.abort(null));
		return { accepted: true };
	}

	// ——— approvals ———

	private async approvalRecords(state: ChatState): Promise<readonly MobileApprovalRecord[]> {
		if (this.runtime === undefined) return [];
		return this.runtime.listApprovals(state.sessionId);
	}

	private async pendingApprovals(state: ChatState): Promise<Record<string, unknown>[]> {
		const records = (await this.approvalRecords(state)).filter((record) => record.status === "pending");
		const rounds = state.chat.view.value?.subagents ?? [];
		return records.map((record) => {
			const round = rounds.find((candidate) => candidate.taskId === record.delegationTaskId);
			return {
				id: record.id,
				version: record.version,
				taskId: record.delegationTaskId,
				agentId: round?.agentId ?? agentIdFor(record.childId),
				...(round === undefined ? {} : { title: round.title }),
				command: record.command,
				cwd: record.cwd,
				...(record.timeout === null ? {} : { timeoutSeconds: record.timeout }),
				requestedAt: record.createdAt,
			};
		});
	}

	private async approvalsKey(sessionId: string): Promise<string> {
		const records = this.runtime === undefined ? [] : await this.runtime.listApprovals(sessionId);
		return records
			.filter((record) => record.status === "pending")
			.map((record) => `${record.id}:${record.version}`)
			.sort()
			.join(",");
	}

	/** 视图每次变化后复查待决集合（审批文档变更会驱动共享视图刷新），变化时通知 approvals.changed。 */
	private refreshApprovals(state: ChatState): void {
		if (state.approvalsRunning) {
			state.approvalsDirty = true;
			return;
		}
		state.approvalsRunning = true;
		void (async () => {
			try {
				do {
					state.approvalsDirty = false;
					const key = await this.approvalsKey(state.sessionId);
					if (this.chatState !== state) return;
					if (key !== state.approvalsKey) {
						state.approvalsKey = key;
						state.approvalsRevision += 1;
						this.sendNotification("approvals.changed", {
							subscriptionId: state.subscriptionId,
							revision: state.approvalsRevision,
						});
					}
				} while (state.approvalsDirty);
			} catch (error) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			} finally {
				state.approvalsRunning = false;
			}
		})();
	}

	private async approvalsGet(params: { subscriptionId: string; id: number }): Promise<unknown> {
		const state = this.requireChat(params);
		const approval = (await this.pendingApprovals(state)).find((candidate) => candidate.id === params.id);
		if (approval === undefined) throw new MobileMethodError("not_found", "approval is not pending");
		return approval;
	}

	private async approvalsDecide(params: {
		subscriptionId: string;
		taskId: number;
		id: number;
		version: string;
		decision: "allow" | "deny";
	}): Promise<unknown> {
		const state = this.requireChat(params);
		const record = (await this.approvalRecords(state)).find(
			(candidate) => candidate.id === params.id && candidate.delegationTaskId === params.taskId,
		);
		if (record === undefined) throw new MobileMethodError("not_found", "approval not found in this session");
		// 已被其他前端结算或已失效：返回实际终态，不再调用决定。
		if (record.status !== "pending" || record.version !== params.version) return { status: record.status };
		const openSubagent = this.services().openSubagent;
		if (openSubagent === undefined) throw new MobileMethodError("not_found", "approvals are not available");
		this.assertAuthorized();
		const handle = openSubagent({ ...state.attachment, taskId: params.taskId });
		try {
			const status = await remote(() =>
				handle.decideApproval({
					id: params.id,
					version: params.version,
					decision: params.decision === "allow" ? "allowed" : "denied",
				}),
			);
			return { status };
		} finally {
			handle.release();
		}
	}

	// ——— todos / questions / plan ———

	/** The snapshot's revision is taken with the status in one step, so a later change always sends a notice. */
	private refreshInteractions(state: ChatState): void {
		if (this.chatState !== state) return;
		const view = state.chat.view.value;
		const todos = view?.todos?.revision;
		if (todos !== undefined && todos > state.todosRevision) {
			state.todosRevision = todos;
			this.sendNotification("todos.changed", { subscriptionId: state.subscriptionId, revision: todos });
		}
		const questions = view?.questions?.revision;
		if (questions !== undefined && questions > state.questionsRevision) {
			state.questionsRevision = questions;
			this.sendNotification("questions.changed", { subscriptionId: state.subscriptionId, revision: questions });
		}
		const plan = view?.plan?.revision;
		if (plan !== undefined && plan > state.planRevision) {
			state.planRevision = plan;
			this.sendNotification("plan.changed", { subscriptionId: state.subscriptionId, revision: plan });
		}
	}

	private async todosGet(params: { subscriptionId: string }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		const todos = state.chat.view.value?.todos;
		if (todos === undefined) throw new MobileMethodError("not_found", "todos are not available");
		return todos;
	}

	private async questionsList(params: { subscriptionId: string }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		const questions = state.chat.view.value?.questions;
		if (questions === undefined) throw new MobileMethodError("not_found", "questions are not available");
		return questions;
	}

	private async questionsGet(params: { subscriptionId: string; id: number }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		if (state.chat.view.value?.questions === undefined)
			throw new MobileMethodError("not_found", "questions are not available");
		const record = await remote(() => state.chat.questionGet({ id: params.id }));
		if (record === null) throw new MobileMethodError("not_found", "question not found in this session");
		return record;
	}

	private async questionsRespond(params: {
		subscriptionId: string;
		id: number;
		version: string;
		response: unknown;
	}): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		if (state.chat.view.value?.questions === undefined)
			throw new MobileMethodError("not_found", "questions are not available");
		return remote(
			() =>
				state.chat.questionRespond({
					id: params.id,
					version: params.version,
					response: params.response as never,
				}),
			"rejected",
		);
	}

	private async planGet(params: { subscriptionId: string; version: string }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		if (state.chat.view.value?.plan === undefined)
			throw new MobileMethodError("not_found", "plan mode is not available");
		const record = await remote(() => state.chat.planGet({ version: params.version }));
		if (record === null) throw new MobileMethodError("not_found", "plan not found in this session");
		return record;
	}

	/** The phone can only leave plan mode (cancelling a waiting plan); entering it stays on the desktop. */
	private async planExit(params: { subscriptionId: string }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		if (state.chat.view.value?.plan === undefined)
			throw new MobileMethodError("not_found", "plan mode is not available");
		const view = await remote(() => state.chat.planMode({ mode: "normal" }), "rejected");
		return { mode: "normal", revision: view.revision };
	}

	/** Approve or ask for changes on a waiting plan. */
	private async planRespond(params: { subscriptionId: string; version: string; decision: unknown }): Promise<unknown> {
		const state = this.requireChat(params);
		this.assertAuthorized();
		if (state.chat.view.value?.plan === undefined)
			throw new MobileMethodError("not_found", "plan mode is not available");
		return remote(
			() => state.chat.planRespond({ version: params.version, decision: params.decision as never }),
			"rejected",
		);
	}

	// ——— subagents ———

	private requireSubagent(params: { subagentSubscriptionId?: string }): SubagentState {
		const state = this.subagentState;
		if (state === undefined || state.subscriptionId !== params.subagentSubscriptionId)
			throw new MobileMethodError("gone", "subagent subscription is no longer active");
		if (this.chatState?.subscriptionId !== state.chatSubscriptionId) {
			this.closeSubagent();
			throw new MobileMethodError("gone", "session is no longer attached");
		}
		return state;
	}

	private closeSubagent(): void {
		this.subagentGeneration += 1;
		const state = this.subagentState;
		if (state === undefined) return;
		this.subagentState = undefined;
		state.projection.dispose();
		state.stop();
	}

	private async subagentsOpen(params: { subscriptionId: string; agentId?: string; taskId?: number }): Promise<unknown> {
		const chat = this.requireChat(params);
		if ((params.agentId === undefined) === (params.taskId === undefined))
			throw new MobileMethodError("invalid_params", "specify exactly one of agentId or taskId");
		const openSubagent = this.services().openSubagent;
		if (openSubagent === undefined) throw new MobileMethodError("not_found", "subagents are not available");
		const rounds = chat.chat.view.value?.subagents ?? [];
		const round =
			params.taskId !== undefined
				? rounds.find((candidate) => candidate.taskId === params.taskId)
				: rounds.find((candidate) => (candidate.agentId ?? agentIdFor(candidate.childId)) === params.agentId);
		if (round === undefined) throw new MobileMethodError("not_found", "subagent does not belong to this session");
		const readonly = round.historyThrough !== undefined;
		// 分叉历史只读且按轮次固定；其余按身份打开，连续展示全部轮次。
		const agentId = readonly ? `round-${round.taskId}` : (round.agentId ?? agentIdFor(round.childId));
		this.closeSubagent();
		const generation = ++this.subagentGeneration;
		const client = subagentClient(() =>
			openSubagent(readonly ? { ...chat.attachment, taskId: round.taskId } : { ...chat.attachment, agentId: agentId }),
		);
		const listeners = new Set<() => void>();
		const keepAlive = client.view.subscribe(() => {
			for (const listener of listeners) listener();
		});
		await new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const poll = () => {
				if (client.view.value !== undefined) return resolve();
				if (client.error !== undefined) return reject(new MobileMethodError("gone", client.error));
				if (Date.now() - started > 10_000) return reject(new MobileMethodError("internal", "subagent view timed out"));
				setTimeout(poll, 25);
			};
			poll();
		}).catch((error: unknown) => {
			keepAlive();
			throw error;
		});
		if (this.chatState !== chat || this.disposed || generation !== this.subagentGeneration) {
			keepAlive();
			throw new MobileMethodError("gone", "session is no longer attached");
		}
		const subscriptionId = this.nextId("agent");
		const source: ProjectionSource = {
			get value() {
				return client.view.value;
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			older: async (before) => {
				const page = await remote(() => client.history({ before }));
				return { items: page.items, next: page.next };
			},
		};
		const projection = new MobileChatProjection({
			subscriptionId,
			owner: { sessionId: chat.sessionId, agentId },
			source,
			readonly,
			onNotice: (notice) => this.forwardNotice("subagents", subscriptionId, notice),
		});
		this.subagentState = {
			subscriptionId,
			chatSubscriptionId: chat.subscriptionId,
			agentId,
			client,
			projection,
			stop: () => {
				listeners.clear();
				keepAlive();
			},
		};
		return { subagentSubscriptionId: subscriptionId, agentId, snapshot: projection.snapshot() };
	}

	private subagentsClose(params: { subagentSubscriptionId: string }): null {
		if (this.subagentState?.subscriptionId === params.subagentSubscriptionId) this.closeSubagent();
		return null;
	}

	private async subagentsStop(params: { subscriptionId: string; taskId: number }): Promise<unknown> {
		const chat = this.requireChat(params);
		const round = (chat.chat.view.value?.subagents ?? []).find((candidate) => candidate.taskId === params.taskId);
		if (round === undefined) throw new MobileMethodError("not_found", "round does not belong to this session");
		if (round.historyThrough !== undefined) throw new MobileMethodError("invalid_params", "fork history is read-only");
		if (!ACTIVE_ROUND.has(round.status)) throw new MobileMethodError("gone", "round is no longer active");
		const openSubagent = this.services().openSubagent;
		if (openSubagent === undefined) throw new MobileMethodError("not_found", "subagents are not available");
		this.assertAuthorized();
		const handle = openSubagent({ ...chat.attachment, taskId: params.taskId });
		try {
			await remote(() => handle.stop({ taskId: params.taskId }));
		} finally {
			handle.release();
		}
		return { stopped: true };
	}

	// ——— media ———

	private async mediaRead(params: {
		subscriptionId: string;
		agentId?: string;
		entryId: number;
		contentIndex: number;
		offset: number;
	}): Promise<unknown> {
		const chat = this.requireChat(params);
		const input = { entryId: params.entryId, contentIndex: params.contentIndex, offset: params.offset };
		let chunk: { data: string; total: number; mimeType: string };
		if (params.agentId !== undefined) {
			const state = this.subagentState;
			if (state === undefined || state.agentId !== params.agentId || state.chatSubscriptionId !== chat.subscriptionId)
				throw new MobileMethodError("gone", "subagent view is no longer open");
			chunk = await remote(() => state.client.getImage(input));
		} else {
			chunk = await remote(() => chat.chat.getImage(input));
		}
		// 上游按 256 KiB 分块；移动端按公布的 chunkBytes 重切以满足单帧限制。
		const bytes = Buffer.from(chunk.data, "base64").subarray(0, MOBILE_LIMITS.chunkBytes);
		const nextOffset = params.offset + bytes.length;
		this.assertAuthorized();
		return {
			data: bytes.toString("base64"),
			nextOffset,
			total: chunk.total,
			done: nextOffset >= chunk.total,
			mimeType: chunk.mimeType,
		};
	}

	// ——— transport ———

	private handleHello(id: JsonRpcId, params: unknown): void {
		if (!isMobileHelloParams(params)) {
			this.sendError(id, -32_602, "invalid hello params", { code: "invalid_params" });
			this.close(CLOSE_PROTOCOL_ERROR, "invalid_hello");
			return;
		}
		const apiVersion = negotiateApiVersion(params.apiVersions);
		if (apiVersion === undefined) {
			this.sendError(id, -32_000, "no common api version", {
				code: "incompatible",
				needs: incompatibleNeeds(params.apiVersions),
			});
			this.close(MOBILE_CLOSE_INCOMPATIBLE, "incompatible");
			return;
		}
		this.saidHello = true;
		this.sendResult(id, buildHelloResult(this.serverId, this.serverName, apiVersion));
	}

	private send(payload: unknown): void {
		if (this.disposed) return;
		this.socket.send(JSON.stringify(payload));
		// 慢消费者：发送缓冲超限时关闭连接，App 重连后取最新快照（design D8）。
		if (this.socket.bufferedAmount > MOBILE_LIMITS.maxSendBufferBytes) {
			this.close(MOBILE_CLOSE_SLOW_CONSUMER, "slow_consumer");
			this.dispose();
		}
	}

	private sendResult(id: JsonRpcId, result: unknown): void {
		this.send({ jsonrpc: "2.0", id, result });
	}

	private sendError(
		id: JsonRpcId,
		code: number,
		message: string,
		data: { code: MobileErrorCode } & Record<string, unknown>,
	): void {
		this.send({ jsonrpc: "2.0", id, error: { code, message, data } });
	}
}
