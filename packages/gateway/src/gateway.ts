import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createHost, type Link } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Provider } from "@earendil-works/pi-ai";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import {
	createNekoRuntime,
	DEFAULT_SKILL_MARKET_URL,
	DEFAULT_STORAGE_PATH,
	loadNekoConfig,
	type NekoModelRef,
	type NekoRuntime,
	type SearchProviderId,
} from "@neko-harness/core";
import type { UpdateCheckerOptions } from "@neko-harness/core/application-updates";
import { GATEWAY_HOST } from "./contract.ts";
import { isServerId } from "./identity.ts";
import { createMobileAdminFactory, NekoMobileAdmin } from "./mobile/admin.ts";
import { MobileGateway, type MobileNetworkHooks } from "./mobile/listener.ts";
import { removeGatewayPortFile, writeGatewayPortFile } from "./port-file.ts";
import { type GatewayPrincipal, gatewayPrincipalKey, HOST_PRINCIPAL } from "./principal.ts";
import { createNekoServerServices } from "./server-services.ts";
import { createUnixListener } from "./unix-link.ts";
import { createWsListener, type WsListener } from "./ws-listener.ts";

/** startGateway 选项：CLI flag > neko.config.json > 内置默认；runtime 透传字段见 core。 */
export type NekoGatewayOptions = {
	readonly context?: Context;
	/** neko.config.json 查找起始目录；默认 process.cwd()。 */
	readonly configDir?: string;
	// —— runtime 透传 ——
	readonly storage?: "sqlite" | "memory";
	readonly storagePath?: string;
	readonly apiKey?: string;
	readonly credentialsPath?: string;
	/** 用户未保存选择时的搜索 provider；缺省读取配置 webSearch.provider，再回落 tavily。 */
	readonly searchProvider?: SearchProviderId;
	readonly model?: NekoModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly cwd?: string;
	readonly providers?: readonly Provider[];
	readonly extensions?: readonly Extension[];
	/** 用户级提示词资源根（`<home>/.agents`）；测试覆盖用。 */
	readonly promptHome?: string;
	/** 技能市场 API 地址；缺省读取配置 skills.marketUrl，再回落官方市场。 */
	readonly marketUrl?: string;
	// —— 网关监听地址 ——
	readonly host?: string;
	/** WebSocket 端口；0 = 随机分配；null = 禁用 WS 传输。 */
	readonly port?: number | null;
	/** Unix socket 路径；null = 禁用 Unix 传输。 */
	readonly socketPath?: string | null;
	/** 逻辑服务器身份（pi 握手校验）；默认读取/生成 <数据目录>/gateway-server-id。 */
	readonly serverId?: string;
	/** 移动配对显示的电脑名；默认安全截断的 os.hostname()。 */
	readonly mobileServerName?: string;
	/** 移动入口网络钩子（WSL 探测/中继）；测试注入用，缺省自动探测。 */
	readonly mobileNetwork?: MobileNetworkHooks;
	readonly updates?: UpdateCheckerOptions;
	readonly updateIntervalMs?: number;
	readonly onError?: (error: Error) => void;
};

export type NekoGateway = {
	readonly serverId: string;
	readonly socketPath: string | undefined;
	readonly wsUrl: string | undefined;
	readonly port: number | undefined;
	readonly runtime: NekoRuntime;
	/** 移动入口（design D2）；状态机与启停见 mobile/listener.ts，关闭时最先释放。 */
	readonly mobile: MobileGateway;
	close(): Promise<void>;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8321;
const SERVER_ID_FILENAME = "gateway-server-id";

/**
 * 启动 neko 会话网关：打开 core runtime，以 Chord 宿主模型托管全部会话，
 * 同时提供 Unix socket（本地客户端）与 WebSocket（浏览器/脚本）两种传输，
 * 上传同一份 neko 服务契约（design D3）。
 *
 * 单实例约束（design Risks）：Unix 路径或端口被活跃网关占用时拒绝启动并给出提示；
 * 进程死亡遗留的 stale socket 由网关 Unix listener 自动识别并接管。
 */
export async function startGateway(options: NekoGatewayOptions = {}): Promise<NekoGateway> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const fileConfig = loadNekoConfig(options.configDir);
	const storagePath = options.storagePath ?? fileConfig.storagePath ?? DEFAULT_STORAGE_PATH;
	const host = options.host ?? fileConfig.gateway?.host ?? DEFAULT_HOST;
	const port =
		options.port !== undefined
			? options.port
			: (fileConfig.gateway?.port ?? (process.platform === "win32" ? 0 : DEFAULT_PORT));
	const searchProvider = options.searchProvider ?? fileConfig.webSearch?.provider;
	const marketUrl = options.marketUrl ?? fileConfig.skills?.marketUrl ?? DEFAULT_SKILL_MARKET_URL;
	const nekoDir = dirname(storagePath);
	const serverId = options.serverId ?? (await loadOrCreateServerId(nekoDir));
	const socketPath =
		options.socketPath !== undefined
			? options.socketPath
			: fileConfig.gateway?.socketPath !== undefined
				? fileConfig.gateway.socketPath
				: // Windows 没有可用的 Unix socket 传输（网关未提供 Windows 命名管道传输），默认仅 WS。
					process.platform === "win32"
					? null
					: join(nekoDir, `${serverId}.sock`);

	const runtime = await createNekoRuntime({
		context,
		onReport: (error) => options.onError?.(error instanceof Error ? error : new Error(String(error))),
		storage: options.storage ?? "sqlite",
		...(options.storage !== "memory" ? { storagePath } : {}),
		...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}),
		...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
		...(searchProvider !== undefined ? { searchProvider } : {}),
		...(fileConfig.context !== undefined ? { contextSettings: fileConfig.context } : {}),
		// CLI --model 是本次启动的显式覆盖（source "cli"）；配置文件 defaultModel 只在配置存在时传，
		// core 以 options.model 是否给出区分来源 "config" 与内置 "default"。
		...(fileConfig.defaultModel !== undefined ? { model: fileConfig.defaultModel } : {}),
		...(options.model !== undefined ? { modelOverride: options.model } : {}),
		thinkingLevel: options.thinkingLevel ?? fileConfig.thinkingLevel ?? "high",
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.providers !== undefined ? { providers: options.providers } : {}),
		...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
		...(options.promptHome !== undefined ? { promptHome: options.promptHome } : {}),
	});
	try {
		return await bindGateway(runtime, {
			context,
			host,
			port,
			socketPath,
			serverId,
			nekoDir,
			marketUrl,
			promptHome: options.promptHome,
			updates: options.updates,
			updateIntervalMs: options.updateIntervalMs,
			mobileServerName: options.mobileServerName,
			mobileNetwork: options.mobileNetwork,
			onError: options.onError,
		});
	} catch (error) {
		await runtime.close().catch(() => {});
		throw error;
	}
}

type BindOptions = {
	readonly context: Context;
	readonly host: string;
	readonly port: number | null;
	readonly socketPath: string | null;
	readonly serverId: string;
	readonly updates?: UpdateCheckerOptions;
	readonly updateIntervalMs?: number;
	readonly nekoDir: string;
	readonly marketUrl: string;
	readonly promptHome: string | undefined;
	readonly mobileServerName: string | undefined;
	readonly mobileNetwork: MobileNetworkHooks | undefined;
	readonly onError: ((error: Error) => void) | undefined;
};

async function bindGateway(runtime: NekoRuntime, options: BindOptions): Promise<NekoGateway> {
	const { context, host, port, socketPath, serverId, nekoDir } = options;
	const chord = createHost<GatewayPrincipal>({
		name: GATEWAY_HOST,
		self: HOST_PRINCIPAL,
		dev: true,
		onError: (error) => options.onError?.(error instanceof Error ? error : new Error(String(error))),
		principalKey: gatewayPrincipalKey,
	});
	const serverServices = await createNekoServerServices({
		host: chord,
		runtime,
		context,
		serverId,
		marketUrl: options.marketUrl,
		...(options.updates ? { updates: options.updates } : {}),
		...(options.updateIntervalMs ? { updateIntervalMs: options.updateIntervalMs } : {}),
		...(options.promptHome !== undefined ? { promptHome: options.promptHome } : {}),
	});
	let wsListener: WsListener | undefined;
	const listeners: { start(accept: (link: Link) => void): Promise<void>; close(): Promise<void> }[] = [];
	if (socketPath !== null) listeners.push(createUnixListener({ path: socketPath, onError: options.onError }));
	if (port !== null) {
		wsListener = createWsListener({ host, port, onError: options.onError });
		listeners.push(wsListener);
	}
	try {
		for (const listener of listeners)
			await listener.start((link) =>
				chord.accept(link, {
					principal: { kind: "local", connectionId: randomUUID() },
					onProtocolMismatch: ({ peer }) =>
						options.onError?.(
							new Error(`Rejected a client on Chord protocol ${peer ?? "unknown"}; restart or update it.`),
						),
				}),
			);
	} catch (error) {
		await Promise.allSettled(listeners.map((listener) => listener.close()));
		await chord.close();
		await serverServices.dispose();
		throw toStartupError(error, { socketPath, port, host, serverId });
	}

	// Windows 地址发现（design D3）：ws-only 网关以随机端口启动，把实际地址写入端口文件供前端发现。
	const portFile = process.platform === "win32" && wsListener !== undefined ? { nekoDir, serverId } : undefined;
	if (portFile !== undefined && wsListener !== undefined) {
		await writeGatewayPortFile(portFile.nekoDir, portFile.serverId, `ws://${host}:${wsListener.port}`);
	}

	// 移动入口（design D2）：恢复失败只进入 error 状态，不阻断本地传输与 gateway 启动。
	const mobile = await MobileGateway.create({
		nekoDir,
		serverId,
		serverName: options.mobileServerName,
		onError: options.onError,
		network: options.mobileNetwork,
		chord: {
			accept: (link, acceptOptions) => chord.accept(link, acceptOptions),
			invalidatePrincipal: (match) => chord.invalidatePrincipal(match),
		},
		runtime: {
			listApprovals: (sessionId) => runtime.approvals.list(Number(sessionId) as ConversationId, context),
			async submissionAccepted(sessionId, requestId) {
				const session = await runtime.getConversation(Number(sessionId) as ConversationId);
				if (session === undefined) return false;
				const record = await session.conversation.commit(
					(tx) => tx.submissionByRequest(session.id, requestId),
					context,
				);
				return record !== undefined && record !== null;
			},
		},
	});
	// 本机移动管理（design D5）：仅持 admin token 的服务端专用客户端可 get；不进入 createGatewayConnection。
	chord.serve(NekoMobileAdmin, createMobileAdminFactory({ mobile, store: mobile.store }));

	let closing: Promise<void> | undefined;
	const gateway: NekoGateway = {
		serverId,
		socketPath: socketPath ?? undefined,
		wsUrl: wsListener === undefined ? undefined : `ws://${host}:${wsListener.port}`,
		port: wsListener?.port,
		runtime,
		mobile,
		async close() {
			if (closing) return closing;
			closing = (async () => {
				await mobile.close();
				if (portFile !== undefined) await removeGatewayPortFile(portFile.nekoDir, portFile.serverId).catch(() => {});
				await Promise.all(listeners.map((listener) => listener.close()));
				await chord.close();
				await serverServices.dispose();
				await runtime.close();
			})();
			return closing;
		},
	};
	void runtime.closed
		.then(async (result) => {
			if (result.reason === "failed") {
				options.onError?.(new Error("Gateway storage failed"));
				await gateway.close();
			}
		})
		.catch((error) => options.onError?.(error instanceof Error ? error : new Error(String(error))));
	return gateway;
}

/** 活跃实例占用/stale 识别由 Chord Unix listener 负责；此处把错误翻译为可操作的提示。 */
function toStartupError(
	error: unknown,
	info: { socketPath: string | null; port: number | null; host: string; serverId: string },
): Error {
	const message = error instanceof Error ? error.message : String(error);
	// 默认 socket 命名为 <serverId>.sock：占用方能从文件名推出现有实例的 serverId。
	const existingServerId = info.socketPath === null ? undefined : serverIdFromSocketPath(info.socketPath);
	const existingAddress =
		info.socketPath !== null
			? `Unix socket ${info.socketPath}${existingServerId !== undefined ? `（serverId: ${existingServerId}）` : ""}`
			: // Windows 无 Unix 传输：已有实例通过端口文件发布 ws 地址。
				process.platform === "win32"
				? `端口文件 <数据目录>/${info.serverId}.port 中的 ws 地址`
				: "Unix socket（未启用）";
	const connectHint = `如需连接已有实例：${existingAddress}，或停掉占用方后重试。`;
	if (message.includes("already running")) {
		return new Error(
			`neko gateway 启动失败：${message}\n该地址已被一个活跃网关占用，不能启动第二个实例。\n${connectHint}`,
		);
	}
	if ("code" in (error as object) && (error as { code?: string }).code === "EADDRINUSE") {
		return new Error(
			`neko gateway 启动失败：${info.host}:${info.port ?? "?"} 已被占用（EADDRINUSE）。\n${connectHint}`,
		);
	}
	return error instanceof Error ? error : new Error(message);
}

function serverIdFromSocketPath(socketPath: string): string | undefined {
	const name = basename(socketPath);
	if (!name.endsWith(".sock")) return undefined;
	const candidate = name.slice(0, -".sock".length);
	return isServerId(candidate) ? candidate : undefined;
}

async function loadOrCreateServerId(nekoDir: string): Promise<string> {
	const file = join(nekoDir, SERVER_ID_FILENAME);
	try {
		const existing = (await readFile(file, "utf8")).trim();
		if (existing !== "") return existing;
	} catch {
		// 首次启动：生成并持久化，重启后保持逻辑身份稳定（stale socket 识别依赖它）。
	}
	const created = randomUUID();
	await mkdir(nekoDir, { recursive: true, mode: 0o700 });
	await writeFile(file, `${created}\n`, { mode: 0o600 });
	return created;
}
