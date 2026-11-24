import { lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { type GatewayLink, MAX_LINK_BYTES, markGatewayLink } from "./link.ts";

/** Length-prefixed binary Chord frames over a Unix socket, with bounded receive and socket write queues. */
export class UnixLink implements GatewayLink {
	#closed = false;
	#protocolError = false;
	#receivedFrame = false;
	#pendingBytes = 0;
	#socket: Socket;
	#buffer = Buffer.alloc(0);
	#listener: ((message: Uint8Array) => void) | undefined;
	#queued: Uint8Array[] = [];
	#closeListeners = new Set<() => void>();
	#protocolErrorListeners = new Set<() => void>();

	constructor(socket: Socket) {
		markGatewayLink(this);
		this.#socket = socket;
		socket.on("data", (data) => this.#data(data));
		socket.on("error", () => this.close());
		socket.on("close", () => this.#finish());
		if (socket.destroyed) this.#finish();
	}

	get closed(): boolean {
		return this.#closed;
	}

	get protocolError(): boolean {
		return this.#protocolError;
	}

	onProtocolError(listener: () => void): void {
		if (this.#protocolError) listener();
		else if (!this.#closed) this.#protocolErrorListeners.add(listener);
	}

	#data(data: Buffer): void {
		if (this.#closed) return;
		this.#buffer = Buffer.concat([this.#buffer, data]);
		while (this.#buffer.length >= 4) {
			const size = this.#buffer.readUInt32BE(0);
			if (size === 0 || size > MAX_LINK_BYTES) {
				if (!this.#receivedFrame) {
					this.#protocolError = true;
					for (const fn of [...this.#protocolErrorListeners]) fn();
				}
				this.close();
				return;
			}
			if (this.#buffer.length < 4 + size) break;
			this.#receivedFrame = true;
			const payload = new Uint8Array(this.#buffer.subarray(4, 4 + size));
			this.#buffer = this.#buffer.subarray(4 + size);
			if (this.#listener === undefined) {
				this.#pendingBytes += size;
				if (this.#pendingBytes > MAX_LINK_BYTES) {
					this.close();
					return;
				}
				this.#queued.push(payload);
			} else {
				this.#listener(payload);
				if (this.#closed) return;
			}
		}
		if (this.#buffer.length > MAX_LINK_BYTES + 4) this.close();
	}

	send(message: Uint8Array): void {
		if (this.#closed) return;
		if (
			message.byteLength === 0 ||
			message.byteLength > MAX_LINK_BYTES ||
			this.#socket.writableLength + message.byteLength + 4 > MAX_LINK_BYTES
		) {
			this.close();
			throw new Error("Link byte limit exceeded");
		}
		const header = Buffer.alloc(4);
		header.writeUInt32BE(message.byteLength, 0);
		this.#socket.write(Buffer.concat([header, message]));
	}

	onMessage(listener: (message: Uint8Array) => void): void {
		if (this.#closed) return;
		this.#listener = listener;
		this.#pendingBytes = 0;
		for (const message of this.#queued.splice(0)) {
			if (this.#closed) return;
			listener(message);
		}
	}

	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#closeListeners.add(listener);
	}

	close(): void {
		if (this.#closed) return;
		this.#finish();
		this.#socket.destroy();
	}

	#finish(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffer = Buffer.alloc(0);
		this.#queued = [];
		this.#listener = undefined;
		const listeners = [...this.#closeListeners];
		this.#closeListeners.clear();
		this.#protocolErrorListeners.clear();
		for (const fn of listeners) fn();
	}
}

export async function createUnixLink(path: string, signal?: AbortSignal): Promise<GatewayLink> {
	const socket = connect({ path, ...(signal ? { signal } : {}) });
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return new UnixLink(socket);
}

export function createUnixListener(options: { path: string; onError?: (error: Error) => void }) {
	let server: Server | undefined;
	const links = new Set<GatewayLink>();
	let bound = false;
	return {
		async start(accept: (link: GatewayLink) => void) {
			await mkdir(dirname(options.path), { recursive: true });
			try {
				const stat = await lstat(options.path);
				if (!stat.isSocket()) throw new Error("Socket path is not a socket");
				const active = await new Promise<boolean>((resolve) => {
					const socket = connect(options.path);
					const timer = setTimeout(() => {
						socket.destroy();
						resolve(true);
					}, 1000);
					socket.once("connect", () => {
						clearTimeout(timer);
						socket.destroy();
						resolve(true);
					});
					socket.once("error", (error) => {
						clearTimeout(timer);
						socket.destroy();
						resolve(!["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""));
					});
				});
				if (active) throw new Error("Gateway already running at this socket");
				await unlink(options.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			server = createServer((socket) => {
				const link = new UnixLink(socket);
				links.add(link);
				link.onClose(() => links.delete(link));
				accept(link);
			});
			await new Promise<void>((resolve, reject) => {
				server!.once("error", reject);
				server!.listen(options.path, () => {
					bound = true;
					resolve();
				});
			});
			server.on("error", (error) => options.onError?.(error));
		},
		async close() {
			for (const link of links) link.close();
			links.clear();
			const previous = server;
			server = undefined;
			if (previous) await new Promise<void>((resolve) => previous.close(() => resolve()));
			if (bound) {
				bound = false;
				await unlink(options.path).catch(() => {});
			}
		},
	};
}
