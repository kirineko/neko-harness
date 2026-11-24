/** Bounded binary WebSocket link and Chord v2 client host initialization. */
import { createHost, type Host, type HostError, type Link } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export const MAX_LINK_BYTES = 16 * 1024 * 1024;

const GATEWAY_LINK = Symbol("neko.gateway.link");

/** A `Link` with observable closed state, multi-listener `onClose`, and transport-level protocol error notice. */
export interface GatewayLink extends Link {
	readonly closed: boolean;
	readonly protocolError?: boolean;
	onProtocolError?(listener: () => void): void;
}

/** Marks a custom `GatewayLink` implementation so `observableLink` returns it unwrapped. */
export function markGatewayLink(link: GatewayLink): void {
	Object.defineProperty(link, GATEWAY_LINK, { value: true });
}

/** Ensures `link` supports multiple `onClose` listeners and `.closed` (Chord's `memoryLinkPair` keeps one listener). */
export function observableLink(link: Link): GatewayLink {
	if (GATEWAY_LINK in link) return link as unknown as GatewayLink;
	let closed = false;
	const closeListeners = new Set<() => void>();
	link.onClose(() => {
		if (closed) return;
		closed = true;
		const snapshot = [...closeListeners];
		closeListeners.clear();
		for (const fn of snapshot) fn();
	});
	const wrapped: GatewayLink = {
		get closed() {
			return closed;
		},
		send(message) {
			if (!closed) link.send(message);
		},
		onMessage(listener) {
			if (!closed) link.onMessage(listener);
		},
		onClose(listener) {
			if (closed) listener();
			else closeListeners.add(listener);
		},
		close() {
			link.close();
		},
	};
	markGatewayLink(wrapped);
	return wrapped;
}

/** The socket surface the bound needs; browser `WebSocket` and Node `ws` sockets satisfy it. */
export type BoundedSocket = {
	readonly readyState: number;
	readonly bufferedAmount: number;
	binaryType?: string;
	send(data: Uint8Array<ArrayBuffer>): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	removeEventListener?(type: "open" | "close" | "error", listener: () => void): void;
	removeEventListener?(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	/** Node `ws` sockets expose `on("message", (data, isBinary) => ...)` with explicit binary flag. */
	readonly on?: (
		event: "message",
		listener: (data: Uint8Array | ArrayBuffer | Buffer[], isBinary: boolean) => void,
	) => unknown;
};

function toUint8Array(data: Uint8Array | ArrayBuffer | Buffer[]): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (data instanceof Uint8Array) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(Buffer.concat(data));
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer) {
		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	return new Uint8Array(bytes);
}

/** Binary-only Chord v2 WebSocket link with inbound/outbound `MAX_LINK_BYTES` guards. */
export function boundedWebSocketLink(socket: BoundedSocket, max = MAX_LINK_BYTES): GatewayLink {
	let closed = false;
	let protocolError = false;
	let queuedOutBytes = 0;
	let pendingInBytes = 0;
	let connectingQueue: Uint8Array<ArrayBuffer>[] | undefined = socket.readyState === 0 ? [] : undefined;
	let pendingIn: Uint8Array[] = [];
	let messageListener: ((message: Uint8Array) => void) | undefined;
	const closeListeners = new Set<() => void>();
	const protocolErrorListeners = new Set<() => void>();

	const finish = (): void => {
		if (closed) return;
		closed = true;
		connectingQueue = undefined;
		queuedOutBytes = 0;
		pendingIn = [];
		pendingInBytes = 0;
		messageListener = undefined;
		socket.removeEventListener?.("open", onOpen);
		socket.removeEventListener?.("message", onBrowserMessage);
		const listeners = [...closeListeners];
		closeListeners.clear();
		protocolErrorListeners.clear();
		for (const fn of listeners) fn();
	};

	const closeSocket = (code?: number, reason?: string): void => {
		if (closed) return;
		finish();
		try {
			if (code !== undefined) socket.close(code, reason);
			else socket.close();
		} catch {
			// Ignore close errors on already-closing sockets.
		}
	};

	const failProtocol = (): void => {
		if (closed) return;
		protocolError = true;
		for (const fn of [...protocolErrorListeners]) fn();
		closeSocket(1003, "binary frames required");
	};

	const deliverBytes = (raw: Uint8Array): void => {
		if (closed) return;
		const bytes = raw.byteLength;
		if (bytes > max) {
			closeSocket(1009, "byte limit");
			return;
		}
		const copy = new Uint8Array(raw);
		if (messageListener === undefined) {
			pendingInBytes += bytes;
			if (pendingInBytes > max) {
				closeSocket(1009, "byte limit");
				return;
			}
			pendingIn.push(copy);
		} else {
			messageListener(copy);
		}
	};

	const onOpen = (): void => {
		if (closed) return;
		const queued = connectingQueue ?? [];
		connectingQueue = undefined;
		queuedOutBytes = 0;
		for (const item of queued) {
			if (closed) return;
			try {
				if (item.byteLength + socket.bufferedAmount > max) {
					closeSocket(1009, "byte limit");
					return;
				}
				socket.send(item);
			} catch {
				closeSocket();
				return;
			}
		}
	};

	const onBrowserMessage = (event: { readonly data: unknown }): void => {
		if (closed) return;
		if (event.data instanceof ArrayBuffer) {
			deliverBytes(new Uint8Array(event.data));
		} else if (event.data instanceof Uint8Array) {
			deliverBytes(event.data);
		} else {
			// Text frames (e.g. Pi <= 1.5 JSON handshake) and non-binary payloads are protocol errors in Chord v2.
			failProtocol();
		}
	};

	const onClose = (event?: unknown): void => {
		const code = typeof event === "object" && event !== null ? (event as { code?: unknown }).code : undefined;
		if (!closed && (code === 1002 || code === 1003 || code === 1007)) {
			protocolError = true;
			for (const fn of [...protocolErrorListeners]) fn();
		}
		socket.removeEventListener?.("close", onClose);
		socket.removeEventListener?.("error", onError);
		finish();
	};

	const onError = (): void => closeSocket();

	if (socket.readyState !== 0 && socket.readyState !== 1) {
		closed = true;
	} else {
		socket.binaryType = "arraybuffer";
		if (socket.readyState === 0) {
			socket.addEventListener("open", onOpen);
		}
		if (socket.on) {
			socket.on("message", (data, isBinary) => {
				if (!isBinary) {
					failProtocol();
					return;
				}
				deliverBytes(toUint8Array(data));
			});
		} else {
			socket.addEventListener("message", onBrowserMessage);
		}
		socket.addEventListener("close", onClose);
		socket.addEventListener("error", onError);
	}

	const link: GatewayLink = {
		get closed() {
			return closed;
		},
		get protocolError() {
			return protocolError;
		},
		onProtocolError(listener) {
			if (protocolError) listener();
			else if (!closed) protocolErrorListeners.add(listener);
		},
		send(message) {
			if (closed) return;
			if (socket.readyState > 1) {
				closeSocket();
				return;
			}
			const bytes = message.byteLength;
			if (bytes > max || bytes + socket.bufferedAmount + queuedOutBytes > max) {
				closeSocket(1009, "byte limit");
				throw new Error("Link byte limit exceeded");
			}
			const view = toArrayBufferView(message);
			if (connectingQueue !== undefined) {
				queuedOutBytes += bytes;
				connectingQueue.push(view);
				return;
			}
			try {
				socket.send(view);
			} catch {
				closeSocket();
			}
		},
		onMessage(listener) {
			if (closed) return;
			messageListener = listener;
			pendingInBytes = 0;
			for (const item of pendingIn.splice(0)) {
				if (closed) return;
				listener(item);
			}
		},
		onClose(listener) {
			if (closed) listener();
			else closeListeners.add(listener);
		},
		close() {
			closeSocket();
		},
	};
	markGatewayLink(link);
	return link;
}

/** A client host whose only peer is the gateway behind `link`; requests the gateway makes itself act as the server. */
export function createClientHost(
	link: Link,
	options: {
		readonly onProtocolMismatch?: () => void;
		readonly onError?: (error: HostError) => void;
	} = {},
): Host {
	const observed = observableLink(link);
	observed.onProtocolError?.(() => options.onProtocolMismatch?.());
	const host = createHost({
		onError: (error) => {
			if (error.kind === "protocol_error") options.onProtocolMismatch?.();
			options.onError?.(error);
		},
	});
	// `load([])` publishes synchronously so immediate `hold` / `get` calls bind without `not_ready`.
	void host.load([], BACKGROUND_CONTEXT);
	host.connect(observed, { principal: { kind: "server" } }, BACKGROUND_CONTEXT);
	return host;
}
