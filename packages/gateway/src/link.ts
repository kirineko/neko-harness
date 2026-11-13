/** Bounds around the SDK's native JSON WebSocket link; no second wire protocol. */
import {
	createHost,
	type Host,
	type Link,
	type WebSocketLike,
	type WebSocketLinkOptions,
	webSocketLink,
} from "@earendil-works/chord";
export const MAX_LINK_BYTES = 16 * 1024 * 1024;
/** The socket surface the bound needs; browser, `ws` and Node sockets all satisfy it. */
export type BoundedSocket = Pick<WebSocketLike, "readyState" | "close" | "addEventListener"> & {
	readonly bufferedAmount: number;
	send(data: string | Uint8Array<ArrayBuffer>): void;
	/** Node `ws` sockets only. */
	readonly on?: (event: "message", listener: (data: Uint8Array | ArrayBuffer, isBinary: boolean) => void) => unknown;
};
const asBytes = (data: Uint8Array | ArrayBuffer) => (data instanceof Uint8Array ? data : new Uint8Array(data));
const size = (data: string | Uint8Array) =>
	typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
export function boundedWebSocketLink(
	socket: BoundedSocket,
	max = MAX_LINK_BYTES,
	options?: WebSocketLinkOptions,
): Link {
	let queued = 0,
		incoming = 0,
		receiving = false;
	let native: Link;
	const bridge: WebSocketLike = {
		get readyState() {
			return socket.readyState;
		},
		send(data) {
			if (size(data) + socket.bufferedAmount > max) {
				socket.close(1009, "byte limit");
				throw new Error("Link pending byte limit exceeded");
			}
			socket.send(data as string | Uint8Array<ArrayBuffer>);
		},
		close: (code, reason) => socket.close(code, reason),
		addEventListener(type, handler) {
			if (type === "message") {
				const deliver = (data: string | Uint8Array) => {
					const bytes = size(data);
					if (!receiving) incoming += bytes;
					if (bytes > max || incoming > max) {
						native.close("frame limit exceeded");
						return;
					}
					(handler as (event: { data: unknown }) => void)({ data });
				};
				// `ws`'s `on` event carries the real frame type on every runtime; through addEventListener, Bun reported text frames as Buffers.
				if (socket.on)
					socket.on("message", (data, isBinary) =>
						deliver(isBinary ? asBytes(data) : new TextDecoder().decode(asBytes(data))),
					);
				else
					socket.addEventListener("message", (event) =>
						deliver(
							typeof event.data === "string" || event.data instanceof Uint8Array ? event.data : String(event.data),
						),
					);
			} else
				socket.addEventListener(type, () => {
					if (type === "open") queued = 0;
					try {
						(handler as () => void)();
					} catch {
						native.close("socket error");
					}
				});
		},
	};
	native = webSocketLink(bridge, options);
	socket.addEventListener("error", () => native.close("socket error"));
	return {
		get closed() {
			return native.closed;
		},
		send(frame) {
			if (native.closed) return undefined;
			if (socket.readyState > 1) {
				native.close("socket closed");
				return undefined;
			}
			const bytes = size(JSON.stringify(frame));
			if (bytes > max || bytes + socket.bufferedAmount + queued > max) {
				native.close("pending byte limit exceeded");
				throw new Error("Link byte limit exceeded");
			}
			if (socket.readyState === 0) queued += bytes;
			return native.send(frame);
		},
		receive(handler) {
			receiving = true;
			incoming = 0;
			native.receive(handler);
		},
		onClose: (handler) => native.onClose(handler),
		close: (reason) => native.close(reason),
	};
}
/** A client host whose only peer is the gateway behind `link`; requests the gateway makes itself act as the server. */
export function createClientHost(link: Link, options: { readonly onProtocolMismatch?: () => void } = {}): Host {
	return createHost({
		kind: "client",
		self: { kind: "client" },
		upstream: {
			link,
			principal: { kind: "server" },
			...(options.onProtocolMismatch ? { onProtocolMismatch: options.onProtocolMismatch } : {}),
		},
		onError: () => {},
	});
}
