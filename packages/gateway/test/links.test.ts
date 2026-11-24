import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, it } from "vitest";
import { type BoundedSocket, boundedWebSocketLink, MAX_LINK_BYTES } from "../src/link.ts";
import { UnixLink } from "../src/unix-link.ts";

class FakeSocket extends EventEmitter {
	destroyed = false;
	writableLength = 0;
	sent: Buffer[] = [];
	write(bytes: Buffer) {
		this.sent.push(bytes);
		return true;
	}
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.emit("close");
	}
}

const encodeFrame = (payload: Uint8Array) => {
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.byteLength, 0);
	return Buffer.concat([header, payload]);
};

it("decodes split and joined binary Unix frames in FIFO order, including arbitrary byte sequences", () => {
	const socket = new FakeSocket();
	const link = new UnixLink(socket as unknown as Socket);
	const seen: Uint8Array[] = [];
	const frames = [
		new TextEncoder().encode("中文 host 🌸"),
		new Uint8Array([0x00, 0xff, 0x80, 0x01, 0x02]),
		new Uint8Array([0x42]),
	];
	const bytes = Buffer.concat(frames.map(encodeFrame));
	// Queue one frame before `onMessage` is attached, then deliver split chunks after.
	socket.emit("data", bytes.subarray(0, 6));
	link.onMessage((frame) => seen.push(frame));
	socket.emit("data", bytes.subarray(6, 17));
	socket.emit("data", bytes.subarray(17));
	expect(seen).toEqual(frames);

	link.send(frames[0]!);
	expect(socket.sent[0]).toEqual(encodeFrame(frames[0]!));

	let closesA = 0;
	let closesB = 0;
	link.onClose(() => closesA++);
	link.onClose(() => closesB++);
	link.close();
	link.close();
	socket.emit("close");
	expect(closesA).toBe(1);
	expect(closesB).toBe(1);
	expect(link.closed).toBe(true);
});

it("rejects zero-length, oversized Unix lengths, receive queue overflow, and write queue overflow", () => {
	const zeroSocket = new FakeSocket();
	const zeroLink = new UnixLink(zeroSocket as unknown as Socket);
	const zeroHeader = Buffer.alloc(4);
	zeroHeader.writeUInt32BE(0, 0);
	zeroSocket.emit("data", zeroHeader);
	expect(zeroLink.closed).toBe(true);

	const socket = new FakeSocket();
	const link = new UnixLink(socket as unknown as Socket);
	const header = Buffer.alloc(4);
	header.writeUInt32BE(MAX_LINK_BYTES + 1, 0);
	socket.emit("data", header);
	expect(link.closed).toBe(true);

	const other = new FakeSocket();
	const second = new UnixLink(other as unknown as Socket);
	other.writableLength = MAX_LINK_BYTES;
	expect(() => second.send(new Uint8Array([1, 2, 3]))).toThrow("limit");
	expect(second.closed).toBe(true);
});

class FakeWs implements BoundedSocket {
	readyState = 0;
	bufferedAmount = 0;
	binaryType = "blob";
	sent: Uint8Array[] = [];
	events = new EventEmitter();
	addEventListener(type: string, handler: ((event: { readonly data: unknown }) => void) | (() => void)) {
		this.events.on(type, handler);
	}
	removeEventListener(type: string, handler: ((event: { readonly data: unknown }) => void) | (() => void)) {
		this.events.off(type, handler);
	}
	send(data: Uint8Array<ArrayBuffer>) {
		this.sent.push(new Uint8Array(data));
	}
	close() {
		this.readyState = 3;
		this.events.emit("close");
	}
	open() {
		this.readyState = 1;
		this.events.emit("open");
	}
	binaryMessage(bytes: Uint8Array) {
		const copy = new Uint8Array(bytes);
		this.events.emit("message", { data: copy.buffer });
	}
	textMessage(text: string) {
		this.events.emit("message", { data: text });
	}
}

it("preserves large binary payloads and ignores late sends after normal WS closure", () => {
	const socket = new FakeWs();
	const link = boundedWebSocketLink(socket);
	expect(socket.binaryType).toBe("arraybuffer");
	const payload = new TextEncoder().encode("长文本🌸".repeat(100_000));
	const received: Uint8Array[] = [];
	link.onMessage((value) => received.push(value));
	socket.open();
	link.send(payload);
	socket.binaryMessage(payload);
	expect(received).toEqual([payload]);
	expect(socket.sent[0]).toEqual(payload);
	socket.close();
	expect(() => link.send(new Uint8Array([1, 2]))).not.toThrow();
});

it("closes immediately and flags protocolError on text WebSocket frames", () => {
	const socket = new FakeWs();
	const link = boundedWebSocketLink(socket);
	let protocolMismatch = 0;
	link.onProtocolError?.(() => protocolMismatch++);
	const received: Uint8Array[] = [];
	link.onMessage((value) => received.push(value));
	socket.open();
	socket.textMessage('{"t":"hello","name":"legacy","kind":"host","codeVersion":0}');
	expect(link.closed).toBe(true);
	expect(link.protocolError).toBe(true);
	expect(protocolMismatch).toBe(1);
	expect(received).toEqual([]);
});

it("buffers binary sends before open with bounded outbound and inbound queues", () => {
	const socket = new FakeWs();
	const link = boundedWebSocketLink(socket, 200);
	const ping = new Uint8Array([1, 2, 3, 4]);
	link.send(ping);
	expect(socket.sent).toEqual([]);
	socket.open();
	expect(socket.sent).toEqual([ping]);

	const seen: Uint8Array[] = [];
	link.onMessage((frame) => seen.push(frame));
	const pong = new Uint8Array([9, 8, 7]);
	socket.binaryMessage(pong);
	expect(seen).toEqual([pong]);

	socket.binaryMessage(new Uint8Array(201));
	expect(link.closed).toBe(true);
	expect(seen).toHaveLength(1);

	const slow = new FakeWs();
	const other = boundedWebSocketLink(slow, 100);
	for (let n = 0; n < 3; n++) other.send(new Uint8Array(30));
	expect(() => other.send(new Uint8Array(20))).toThrow("limit");
	expect(other.closed).toBe(true);

	const blocked = new FakeWs();
	blocked.open();
	blocked.bufferedAmount = 95;
	const third = boundedWebSocketLink(blocked, 100);
	expect(() => third.send(new Uint8Array(10))).toThrow("limit");
	expect(third.closed).toBe(true);
});
