import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import { hostname, type NetworkInterfaceInfo } from "node:os";
import { type Link, memoryLinkPair } from "@earendil-works/chord";
import { type WebSocket, WebSocketServer } from "ws";
import { NekoChat, NekoSessionDirectory, NekoSessionManagement, NekoSubagent, NekoWorkspaces } from "../contract.ts";
import { createClientHost } from "../link.ts";
import { type GatewayPrincipal, isMobilePrincipal } from "../principal.ts";
import { MobileAdapter, type MobileRuntimeBridge, type MobileServices } from "./adapter.ts";
import { MobileAuth } from "./auth.ts";
import { MobileCertificate } from "./certificate.ts";
import { isIpv4Literal, mobileListenCandidates, prioritizeListenCandidate } from "./network.ts";
import { MobilePairing, type MobilePairingResult, PAIRING_BODY_LIMIT_BYTES, pairingBodyTooLarge } from "./pairing.ts";
import { MOBILE_CLOSE_REVOKED, MOBILE_LIMITS } from "./protocol.ts";
import { RelayError, type RelayHandle, startWindowsRelay } from "./relay.ts";
import { type MobileDeviceRecord, MobileStore } from "./store.ts";
import { detectWsl, primaryWslAddress, WindowsAddressDiscovery, type WslEnvironment, wslOwnAddresses } from "./wsl.ts";

export { mobileListenCandidates, prioritizeListenCandidate };

export type MobileListenMode = "direct" | "wsl-relay";

export type MobileListenerState =
	| { readonly status: "disabled" }
	| { readonly status: "starting" }
	| {
			readonly status: "listening";
			/** 宣告地址：手机实际连接的地址（二维码使用）。 */
			readonly address: string;
			readonly port: number;
			/** 仅 WSL 中继模式出现：WSL 内部的实际监听地址。 */
			readonly bindAddress?: string;
			/** 仅 WSL 中继模式出现；缺省表示直接监听。 */
			readonly mode?: MobileListenMode;
	  }
	| { readonly status: "error"; readonly error: string }
	| { readonly status: "stopping" };

export type MobileChordBridge = {
	accept(link: Link, options: { readonly principal: GatewayPrincipal; readonly kind: "client" }): void;
	invalidatePrincipal(match: (principal: GatewayPrincipal) => boolean): Promise<void>;
};

export type MobileGatewayOptions = {
	readonly nekoDir: string;
	readonly serverId: string;
	readonly serverName?: string;
	readonly onError?: (error: Error) => void;
	readonly chord: MobileChordBridge;
	/** 受理状态与审批列表的只读查询（design D6）；缺省时这些查询返回空/unknown。 */
	readonly runtime?: MobileRuntimeBridge;
	/** 网络环境探测与中继注入点（测试用）；缺省按真实环境。 */
	readonly network?: MobileNetworkHooks;
};

export type MobileNetworkHooks = {
	/** WSL 环境信息；null 表示强制按非 WSL 处理。 */
	readonly wsl?: WslEnvironment | null;
	readonly windowsCandidates?: () => Promise<string[]>;
	readonly startRelay?: typeof startWindowsRelay;
	readonly localInterfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
	/** 端口被占用时重试中继启动的总时长（毫秒）。 */
	readonly relayPortRetryMs?: number;
	readonly relayPortRetryIntervalMs?: number;
};

const RELAY_PORT_RETRY_MS = 10_000;
const RELAY_PORT_RETRY_INTERVAL_MS = 1_000;

function defaultServerName(): string {
	const name = hostname().trim();
	return (name === "" ? "neko-computer" : name).slice(0, 64);
}

function assertListenAddress(address: string): string {
	if (!isIpv4Literal(address)) throw new Error(`mobile listen address must be an IPv4 literal, got "${address}"`);
	if (address === "0.0.0.0") throw new Error("mobile listen address must not be 0.0.0.0");
	return address;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

const WSL_INTEROP_UNAVAILABLE =
	"WSL 的 Windows 互操作不可用（找不到 powershell.exe），无法读取 Windows 局域网地址。请启用 WSL 互操作，或直接在 Windows 上运行 neko。";

function describeRelayError(error: unknown, address: string, port: number, bindAddress: string): string {
	if (!(error instanceof RelayError)) return `Windows 中继启动失败：${toMessage(error)}`;
	switch (error.code) {
		case "port_in_use":
			return `Windows 上 ${address}:${port} 已被占用，请更换端口或释放该端口后重试。`;
		case "target_unreachable":
			return `Windows 无法连接到 WSL 内的监听地址 ${bindAddress}:${port}（${error.message}）。`;
		case "timeout":
			return "Windows 中继启动超时，请稍后重试。";
		case "listen_failed":
			return `Windows 中继无法在 ${address}:${port} 上监听：${error.message}`;
		default:
			return `Windows 中继启动失败：${error.message}`;
	}
}

export type MobileAdminDevice = Pick<MobileDeviceRecord, "deviceId" | "name" | "pairedAt" | "lastSeenAt"> & {
	readonly online: boolean;
};

export type MobileAdminState = {
	readonly state: MobileListenerState;
	candidates: string[];
	readonly port: number;
	readonly certificate: { readonly fingerprint: string; readonly expiresAt: number } | null;
	devices: MobileAdminDevice[];
	/** 手机最近一次成功接入的宣告地址；从未接入为 null。 */
	readonly lastConnectedAddress: string | null;
	/** WSL 环境信息；非 WSL 为 null。 */
	readonly wsl: { readonly interop: boolean; readonly error: string | null } | null;
};

function toMessage(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" && code !== "" ? `${code}: ${error.message}` : error.message;
	}
	return String(error);
}

/** Some runtimes (seen with Bun on Windows) report an IPv4 listener as an IPv4-mapped IPv6 address. */
function normalizeLocalAddress(address: string | undefined): string | undefined {
	const mapped = address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : undefined;
	return mapped !== undefined && isIpv4Literal(mapped) ? mapped : address;
}

export class MobileGateway {
	private readonly serverId: string;
	private readonly serverName: string;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly chord: MobileChordBridge;
	private runtime: MobileRuntimeBridge | undefined;
	private readonly storeHandle: MobileStore | undefined;
	private readonly storeFailure: string | undefined;
	private certificate: MobileCertificate | undefined;
	private pairingValue: MobilePairing | undefined;
	private authValue: MobileAuth | undefined;
	private server: HttpsServer | undefined;
	private wss: WebSocketServer | undefined;
	private readonly sockets = new Set<Socket>();
	private readonly connections = new Map<string, MobileAdapter>();
	private stateValue: MobileListenerState;
	private queue: Promise<unknown> = Promise.resolve();
	private closing: Promise<void> | undefined;
	private relay: RelayHandle | undefined;
	private readonly wslEnvironment: WslEnvironment | undefined;
	private readonly windowsAddresses: (() => Promise<string[]>) | undefined;
	private readonly startRelay: typeof startWindowsRelay;
	private readonly localInterfaces: (() => NodeJS.Dict<NetworkInterfaceInfo[]>) | undefined;
	private readonly relayPortRetryMs: number;
	private readonly relayPortRetryIntervalMs: number;

	private constructor(
		serverId: string,
		serverName: string,
		onError: ((error: Error) => void) | undefined,
		chord: MobileChordBridge,
		store: MobileStore | undefined,
		storeFailure: string | undefined,
		initial: MobileListenerState,
		network: MobileNetworkHooks = {},
	) {
		this.wslEnvironment = network.wsl === null ? undefined : (network.wsl ?? detectWsl());
		const powershell = this.wslEnvironment?.powershell;
		if (network.windowsCandidates !== undefined) this.windowsAddresses = network.windowsCandidates;
		else if (powershell !== undefined) {
			const discovery = new WindowsAddressDiscovery({ powershell });
			this.windowsAddresses = () => discovery.candidates();
		}
		this.startRelay = network.startRelay ?? startWindowsRelay;
		this.localInterfaces = network.localInterfaces;
		this.relayPortRetryMs = network.relayPortRetryMs ?? RELAY_PORT_RETRY_MS;
		this.relayPortRetryIntervalMs = network.relayPortRetryIntervalMs ?? RELAY_PORT_RETRY_INTERVAL_MS;
		this.serverId = serverId;
		this.serverName = serverName;
		this.onError = onError;
		this.chord = chord;
		this.storeHandle = store;
		this.storeFailure = storeFailure;
		this.stateValue = initial;
	}

	static async create(options: MobileGatewayOptions): Promise<MobileGateway> {
		let store: MobileStore | undefined;
		let storeFailure: string | undefined;
		try {
			store = await MobileStore.open(options.nekoDir);
		} catch (error) {
			storeFailure = toMessage(error);
		}
		const gateway = new MobileGateway(
			options.serverId,
			options.serverName ?? defaultServerName(),
			options.onError,
			options.chord,
			store,
			storeFailure,
			storeFailure === undefined
				? { status: "disabled" }
				: { status: "error", error: `mobile store unavailable: ${storeFailure}` },
			options.network,
		);
		gateway.runtime = options.runtime;
		if (store !== undefined) {
			const config = store.getState();
			if (config.enabled) {
				if (config.address === null) {
					gateway.stateValue = { status: "error", error: "mobile listener is enabled without a configured address" };
				} else {
					try {
						await gateway.startListening(config.address, config.port);
					} catch {
						// startListening 已置 error 状态；持久配置保持 enabled，重启后按配置重试。
					}
				}
			}
		}
		return gateway;
	}

	get state(): MobileListenerState {
		return this.stateValue;
	}

	get store(): MobileStore | undefined {
		return this.storeHandle;
	}

	enable(input: { address: string; port?: number }): Promise<MobileListenerState> {
		return this.enqueue(async () => {
			if (this.closing !== undefined) throw new Error("mobile gateway is closed");
			const address = assertListenAddress(input.address);
			const store = this.requireStore();
			const port = input.port ?? store.getState().port;
			await store.updateConfig({ enabled: true, address, port });
			await this.startListening(address, port);
			return this.stateValue;
		});
	}

	disable(): Promise<MobileListenerState> {
		return this.enqueue(async () => {
			if (this.closing !== undefined) throw new Error("mobile gateway is closed");
			const store = this.requireStore();
			await store.updateConfig({ enabled: false });
			this.pairingValue?.invalidate();
			await this.stopListening();
			this.stateValue = { status: "disabled" };
			return this.stateValue;
		});
	}

	close(): Promise<void> {
		if (this.closing === undefined) {
			this.closing = this.enqueue(async () => {
				this.stateValue = { status: "stopping" };
				this.pairingValue?.invalidate();
				this.notificationCleanup?.();
				this.notificationCleanup = undefined;
				await this.stopListening().catch((error: unknown) => this.onError?.(toError(error)));
				this.stateValue = { status: "disabled" };
			});
		}
		return this.closing;
	}

	createPairing(): { readonly pairingText: string; readonly expiresAt: number } {
		return this.pairing().createPairing();
	}

	cancelPairing(): void {
		this.pairingValue?.invalidate();
	}

	deviceOnline(deviceId: string): boolean {
		for (const connection of this.connections.values()) {
			if (connection.deviceId === deviceId) return true;
		}
		return false;
	}

	async adminState(): Promise<MobileAdminState> {
		const store = this.requireStore();
		const config = store.getState();
		let candidates: string[];
		let wsl: MobileAdminState["wsl"] = null;
		if (this.wslEnvironment === undefined) {
			candidates = mobileListenCandidates();
		} else {
			candidates = [];
			let error: string | null = null;
			if (this.windowsAddresses === undefined) error = WSL_INTEROP_UNAVAILABLE;
			else {
				try {
					candidates = await this.windowsAddresses();
				} catch (caught) {
					error = `读取 Windows 局域网地址失败：${toMessage(caught)}`;
				}
			}
			wsl = { interop: this.windowsAddresses !== undefined, error };
		}
		return {
			state: this.stateValue,
			candidates: prioritizeListenCandidate(candidates, config.lastConnectedAddress),
			port: config.port,
			certificate:
				this.certificate === undefined
					? null
					: { fingerprint: this.certificate.fingerprint, expiresAt: this.certificate.expiresAt },
			devices: config.devices.map((device) => ({
				deviceId: device.deviceId,
				name: device.name,
				pairedAt: device.pairedAt,
				lastSeenAt: device.lastSeenAt,
				online: this.deviceOnline(device.deviceId),
			})),
			lastConnectedAddress: config.lastConnectedAddress,
			wsl,
		};
	}

	async regenerateCertificate(): Promise<{ readonly fingerprint: string; readonly expiresAt: number }> {
		const store = this.requireStore();
		const certificate = this.certificate ?? (await MobileCertificate.load(store, this.serverId));
		// 证书与授权写入先完成；任何一步失败都向调用方报错，不动现有连接。
		const material = await certificate.regenerate();
		await store.clearMobileAuthorizations();
		this.certificate = certificate;
		this.pairingValue?.invalidate();
		await this.chord.invalidatePrincipal(isMobilePrincipal);
		for (const connection of [...this.connections.values()]) connection.close(MOBILE_CLOSE_REVOKED, "revoked");
		const current = this.stateValue;
		if (current.status === "listening") {
			await this.enqueue(async () => {
				await this.startListening(current.address, current.port, true);
			});
		}
		return { fingerprint: material.fingerprint, expiresAt: material.expiresAt };
	}

	private pairing(): MobilePairing {
		if (this.pairingValue === undefined) {
			this.pairingValue = new MobilePairing({
				serverId: this.serverId,
				serverName: this.serverName,
				store: this.storeHandle,
				certificate: () => this.certificate,
				isListening: () => {
					const state = this.stateValue;
					return state.status === "listening" ? { address: state.address, port: state.port } : undefined;
				},
				onPaired: (device) => this.handleDevicePaired(device),
			});
		}
		return this.pairingValue;
	}

	private auth(): MobileAuth {
		if (this.authValue === undefined) {
			this.authValue = new MobileAuth({ store: this.storeHandle });
		}
		return this.authValue;
	}

	private handleDevicePaired(device: MobileDeviceRecord): void {
		this.invalidateConnections(device.deviceId, device.grantRevision).catch((error: unknown) =>
			this.onError?.(toError(error)),
		);
	}

	/** 撤销设备（design D7）：先持久删除，再释放 chord 记录并关闭该设备的移动 WS（4401）。 */
	async revoke(deviceId: string): Promise<boolean> {
		const store = this.requireStore();
		const existing = store.getState().devices.some((device) => device.deviceId === deviceId);
		if (!existing) return false;
		await store.removeDevice(deviceId);
		await this.invalidateConnections(deviceId);
		return true;
	}

	private async invalidateConnections(deviceId: string, exceptGrantRevision?: number): Promise<void> {
		const match = (principal: unknown): boolean => {
			if (typeof principal !== "object" || principal === null) return false;
			const record = principal as Record<string, unknown>;
			return (
				record.kind === "mobile" &&
				record.deviceId === deviceId &&
				(exceptGrantRevision === undefined || record.grantRevision !== exceptGrantRevision)
			);
		};
		await this.chord.invalidatePrincipal(match);
		for (const connection of [...this.connections.values()]) {
			if (
				connection.deviceId === deviceId &&
				(exceptGrantRevision === undefined || connection.grantRevision !== exceptGrantRevision)
			) {
				connection.close(MOBILE_CLOSE_REVOKED, "revoked");
			}
		}
	}

	private attachConnection(
		socket: WebSocket,
		auth: { deviceId: string; grantRevision: number; remoteAddress: string },
		localAddress: string | undefined,
	): void {
		const connectionId = randomUUID();
		const [serverEnd, clientEnd] = memoryLinkPair();
		this.chord.accept(serverEnd, {
			principal: { connectionId, kind: "mobile", deviceId: auth.deviceId, grantRevision: auth.grantRevision },
			kind: "client",
		});
		const store = this.storeHandle;
		if (store?.getState().devices.some((device) => device.deviceId === auth.deviceId)) {
			void store.touchDevice(auth.deviceId, Date.now()).catch((error: unknown) => this.onError?.(toError(error)));
		}
		// 学习有效地址：手机经此入口接入即证明该本地地址可达，排序到候选最前（重复值不落盘）。
		const learned = this.advertisedAddress(localAddress);
		if (store !== undefined && typeof learned === "string" && isIpv4Literal(learned)) {
			if (store.getState().lastConnectedAddress !== learned) {
				void store.rememberConnectedAddress(learned).catch((error: unknown) => this.onError?.(toError(error)));
			}
		}
		const clientHost = createClientHost(clientEnd);
		let servicesValue: MobileServices | undefined;
		const adapter = new MobileAdapter({
			socket,
			connectionId,
			deviceId: auth.deviceId,
			grantRevision: auth.grantRevision,
			serverId: this.serverId,
			serverName: this.serverName,
			services: () => {
				if (servicesValue === undefined) {
					servicesValue = {
						directory: clientHost.hold(NekoSessionDirectory, {}),
						management: clientHost.hold(NekoSessionManagement, {}),
						workspaces: clientHost.hold(NekoWorkspaces, {}),
						openChat: (attachment) => clientHost.hold(NekoChat, attachment),
						openSubagent: (input) => clientHost.hold(NekoSubagent, input),
					};
				}
				return servicesValue;
			},
			...(this.runtime === undefined ? {} : { runtime: this.runtime }),
			authorized: () =>
				store
					?.getState()
					.devices.some((device) => device.deviceId === auth.deviceId && device.grantRevision === auth.grantRevision) ??
				false,
			onClose: () => {
				this.connections.delete(connectionId);
				void clientHost.close().catch(() => undefined);
			},
			onError: this.onError,
		});
		this.connections.set(connectionId, adapter);
		this.ensureNotifications();
		adapter.start();
	}

	private notificationCleanup: (() => void) | undefined;

	/** 共享一份桌面状态订阅（初始快照不广播），把变更通知发给全部已连接手机。 */
	private ensureNotifications(): void {
		if (this.notificationCleanup !== undefined) return;
		const [serverEnd, clientEnd] = memoryLinkPair();
		this.chord.accept(serverEnd, {
			principal: { kind: "local", connectionId: "mobile-notification-hub" },
			kind: "client",
		});
		const host = createClientHost(clientEnd);
		const directory = host.hold(NekoSessionDirectory, {});
		const workspaces = host.hold(NekoWorkspaces, {});
		const last = { directory: -1, workspaces: -1 };
		const unsubscribe = [
			directory.state.subscribe(() => {
				const value = directory.state.value;
				if (value === undefined || value.revision === last.directory) return;
				const priming = last.directory === -1;
				last.directory = value.revision;
				if (!priming) this.broadcastNotification("sessions.changed", { revision: value.revision });
			}),
			workspaces.state.subscribe(() => {
				const value = workspaces.state.value;
				if (value === undefined || value.revision === last.workspaces) return;
				const priming = last.workspaces === -1;
				last.workspaces = value.revision;
				if (!priming) this.broadcastNotification("workspaces.changed", { revision: value.revision });
			}),
		];
		this.notificationCleanup = () => {
			for (const off of unsubscribe) off();
			void host.close().catch(() => undefined);
		};
	}

	private broadcastNotification(method: string, params: unknown): void {
		for (const connection of this.connections.values()) connection.sendNotification(method, params);
	}

	/** 中继模式下连接的本地地址是 WSL 内部地址，记录与排序一律使用宣告地址。 */
	private advertisedAddress(localAddress: string | undefined): string | undefined {
		const normalized = normalizeLocalAddress(localAddress);
		const state = this.stateValue;
		if (state.status === "listening" && state.mode === "wsl-relay" && normalized === state.bindAddress) {
			return state.address;
		}
		return normalized;
	}

	private requireStore(): MobileStore {
		if (this.storeHandle === undefined)
			throw new Error(`mobile store is unavailable: ${this.storeFailure ?? "unknown error"}`);
		return this.storeHandle;
	}

	private async startListening(address: string, port: number, force = false): Promise<void> {
		const current = this.stateValue;
		if (!force && current.status === "listening" && current.address === address && current.port === port) return;
		await this.stopListening();
		this.stateValue = { status: "starting" };
		try {
			const plan = await this.planListen(address);
			const certificate = await this.certificateValue();
			const server = createServer({ cert: certificate.certPem, key: certificate.keyPem }, (request, response) => {
				this.handleRequest(request, response);
			});
			const wss = new WebSocketServer({ noServer: true, maxPayload: MOBILE_LIMITS.maxFrameBytes });
			server.on("connection", (socket: Socket) => {
				this.sockets.add(socket);
				socket.on("close", () => this.sockets.delete(socket));
			});
			server.on("upgrade", (request, socket: Socket, head) => {
				this.handleUpgrade(request, socket, head);
			});
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					server.off("error", onFailure);
					server.off("listening", onListening);
				};
				const onFailure = (error: Error) => {
					cleanup();
					reject(error);
				};
				const onListening = () => {
					cleanup();
					resolve();
				};
				server.once("error", onFailure);
				server.once("listening", onListening);
				server.listen(port, plan.bindAddress);
			});
			this.server = server;
			this.wss = wss;
			server.on("error", (error) => {
				this.stateValue = { status: "error", error: toMessage(error) };
				this.onError?.(error);
				void this.stopListening().catch(() => undefined);
			});
			if (plan.mode === "wsl-relay") await this.startRelayFor(address, port, plan.bindAddress);
			this.stateValue =
				plan.mode === "wsl-relay"
					? { status: "listening", address, port, mode: "wsl-relay", bindAddress: plan.bindAddress }
					: { status: "listening", address, port };
		} catch (error) {
			await this.stopListening().catch(() => undefined);
			this.stateValue = { status: "error", error: toMessage(error) };
			throw error;
		}
	}

	/** 决定监听方式：非 WSL 直接监听；WSL 下只接受 Windows 侧可用局域网地址，NAT 时经中继（design D3）。 */
	private async planListen(address: string): Promise<{ mode: MobileListenMode; bindAddress: string }> {
		if (this.wslEnvironment === undefined) return { mode: "direct", bindAddress: address };
		if (this.windowsAddresses === undefined) throw new Error(WSL_INTEROP_UNAVAILABLE);
		let candidates: string[];
		try {
			candidates = await this.windowsAddresses();
		} catch (error) {
			throw new Error(`读取 Windows 局域网地址失败：${toMessage(error)}`);
		}
		if (!candidates.includes(address)) {
			throw new Error(`${address} 不是当前可用的 Windows 局域网地址，请重新选择后再开启。`);
		}
		const interfaces = this.localInterfaces?.();
		if (wslOwnAddresses(interfaces).includes(address)) return { mode: "direct", bindAddress: address };
		const bindAddress = primaryWslAddress(interfaces);
		if (bindAddress === undefined) throw new Error("WSL 内没有可用的网络地址，无法建立手机入口。");
		return { mode: "wsl-relay", bindAddress };
	}

	private async startRelayFor(address: string, port: number, bindAddress: string): Promise<void> {
		const deadline = Date.now() + this.relayPortRetryMs;
		let relay: RelayHandle;
		for (;;) {
			try {
				relay = await this.startRelay({
					powershell: this.wslEnvironment?.powershell ?? "powershell.exe",
					listenAddress: address,
					listenPort: port,
					targetAddress: bindAddress,
					targetPort: port,
				});
				break;
			} catch (error) {
				// 上一个中继可能仍在退出：端口占用时在有限时间内重试。
				if (
					error instanceof RelayError &&
					error.code === "port_in_use" &&
					Date.now() + this.relayPortRetryIntervalMs < deadline
				) {
					await new Promise((resolve) => setTimeout(resolve, this.relayPortRetryIntervalMs));
					continue;
				}
				throw new Error(describeRelayError(error, address, port, bindAddress));
			}
		}
		this.relay = relay;
		void relay.exited.then((reason) => this.onRelayExited(relay, reason));
	}

	private onRelayExited(relay: RelayHandle, reason: string): void {
		void this.enqueue(async () => {
			if (this.relay !== relay) return;
			this.relay = undefined;
			this.pairingValue?.invalidate();
			await this.stopListening().catch(() => undefined);
			const message = `Windows 中继意外退出（${reason}），请重新开启手机访问。`;
			this.stateValue = { status: "error", error: message };
			this.onError?.(new Error(message));
		});
	}

	private async certificateValue(): Promise<MobileCertificate> {
		if (this.certificate === undefined) {
			this.certificate = await MobileCertificate.load(this.requireStore(), this.serverId);
		}
		return this.certificate;
	}

	private async stopListening(): Promise<void> {
		const relay = this.relay;
		this.relay = undefined;
		if (relay !== undefined) await relay.stop().catch(() => undefined);
		for (const connection of [...this.connections.values()]) connection.close(1001, "listener_stopped");
		const server = this.server;
		const wss = this.wss;
		this.server = undefined;
		this.wss = undefined;
		if (wss !== undefined) {
			for (const client of wss.clients) client.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		}
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		if (server !== undefined) {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}

	private handleRequest(request: IncomingMessage, response: ServerResponse): void {
		if (request.method === "POST" && request.url === "/mobile/v1/pair") {
			void this.handlePair(request, response).catch((error: unknown) => {
				if (!response.headersSent) this.writeJson(response, 500, { code: "internal", message: "pairing failed" });
				else response.end();
				this.onError?.(toError(error));
			});
			return;
		}
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ code: "not_found", message: "unknown path" }));
	}

	private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const { body, oversize } = await this.readBody(request, PAIRING_BODY_LIMIT_BYTES);
		if (oversize) {
			// 不再读取剩余请求体：写完 413 后立即断开连接。
			const result = pairingBodyTooLarge();
			response.writeHead(result.status, { "content-type": "application/json", connection: "close" });
			response.end(JSON.stringify(result.body), () => request.socket.destroy());
			return;
		}
		const result: MobilePairingResult = await this.pairing().redeem(body, request.socket.remoteAddress ?? "");
		this.writeJson(response, result.status, result.body);
	}

	private readBody(
		request: IncomingMessage,
		limit: number,
	): Promise<{ readonly body: Buffer; readonly oversize: boolean }> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			request.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > limit) {
					request.pause();
					resolve({ body: Buffer.alloc(0), oversize: true });
					return;
				}
				chunks.push(chunk);
			});
			request.on("end", () => resolve({ body: Buffer.concat(chunks), oversize: false }));
			request.on("error", reject);
		});
	}

	private writeJson(response: ServerResponse, status: number, body: unknown): void {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	}

	private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const reject = (status: 401 | 429, code: "unauthorized" | "rate_limited") => {
			const message = code === "rate_limited" ? "too many authentication attempts" : "mobile authentication failed";
			socket.on("error", () => undefined);
			socket.end(
				`HTTP/1.1 ${status} ${status === 429 ? "Too Many Requests" : "Unauthorized"}\r\nconnection: close\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ code, message })}`,
			);
		};
		if (request.method !== "GET" || request.url !== "/mobile/v1/ws") {
			reject(401, "unauthorized");
			return;
		}
		const result = this.auth().authenticate(request);
		if (!result.ok) {
			reject(result.status, result.code);
			return;
		}
		const wss = this.wss;
		if (wss === undefined) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			this.attachConnection(ws, result, socket.localAddress);
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}
