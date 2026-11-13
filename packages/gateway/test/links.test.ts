import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { Frame, WebSocketLike } from "@earendil-works/chord";
import { expect, it } from "vitest";
import { boundedWebSocketLink, MAX_LINK_BYTES } from "../src/link.ts";
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
const encoded = (frame: Frame) => {
	const data = Buffer.from(JSON.stringify(frame));
	const header = Buffer.alloc(4);
	header.writeUInt32BE(data.length);
	return Buffer.concat([header, data]);
};
it("decodes split and joined Unix frames in FIFO order, including Unicode", () => {
	const socket = new FakeSocket();
	const link = new UnixLink(socket as unknown as Socket);
	const seen: Frame[] = [];
	link.receive((frame) => seen.push(frame));
	const frames: Frame[] = [
		{ t: "hello", name: "中文 host", kind: "client", codeVersion: 0 },
		{ t: "ping", n: 2 },
		{ t: "pong", n: 3 },
	];
	const bytes = Buffer.concat(frames.map(encoded));
	socket.emit("data", bytes.subarray(0, 2));
	socket.emit("data", bytes.subarray(2, 9));
	socket.emit("data", bytes.subarray(9));
	expect(seen).toEqual(frames);
	link.send(frames[0]!);
	expect(socket.sent[0]).toEqual(encoded(frames[0]!));
	let closes = 0;
	link.onClose(() => closes++);
	link.close();
	link.close();
	socket.emit("close");
	expect(closes).toBe(1);
	expect(link.closed).toBe(true);
});
for (const payload of [Buffer.from("not json"), Buffer.from('{"t":3}'), Buffer.from([0xff])])
	it("closes malformed Unix frames before delivery", () => {
		const socket = new FakeSocket();
		const link = new UnixLink(socket as unknown as Socket);
		let count = 0;
		link.receive(() => count++);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(payload.length);
		socket.emit("data", Buffer.concat([header, payload]));
		expect(link.closed).toBe(true);
		expect(count).toBe(0);
	});
it("rejects oversized Unix lengths and write queues", () => {
	const socket = new FakeSocket();
	const link = new UnixLink(socket as unknown as Socket);
	const header = Buffer.alloc(4);
	header.writeUInt32BE(MAX_LINK_BYTES + 1);
	socket.emit("data", header);
	expect(link.closed).toBe(true);
	const other = new FakeSocket();
	const second = new UnixLink(other as unknown as Socket);
	other.writableLength = MAX_LINK_BYTES;
	expect(() => second.send({ t: "ping", n: 1 })).toThrow("limit");
	expect(second.closed).toBe(true);
});
class FakeWs implements WebSocketLike {
	readyState = 0;
	bufferedAmount = 0;
	sent: string[] = [];
	events = new EventEmitter();
	addEventListener(type: string, handler: ((event: { readonly data: unknown }) => void) | (() => void)) {
		this.events.on(type, handler);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
		this.events.emit("close");
	}
	open() {
		this.readyState = 1;
		this.events.emit("open");
	}
	message(data: string) {
		this.events.emit("message", { data });
	}
}

it("preserves a long Unicode frame and ignores late sends after normal WS closure", () => {
	const socket = new FakeWs();
	const link = boundedWebSocketLink(socket);
	const frame: Frame = { t: "hello", name: "长文本🌸".repeat(100000), kind: "host", codeVersion: 0 };
	const received: Frame[] = [];
	link.receive((value) => received.push(value));
	socket.open();
	link.send(frame);
	socket.events.emit("message", { data: JSON.stringify(frame) });
	expect(received).toEqual([frame]);
	expect(JSON.parse(socket.sent[0]!)).toEqual(frame);
	socket.close();
	expect(() => link.send({ t: "ping", n: 2 })).not.toThrow();
});
it("uses native WS buffering before open with bounded outbound and inbound queues", () => {
	const socket = new FakeWs();
	const link = boundedWebSocketLink(socket, 200);
	link.send({ t: "ping", n: 1 });
	expect(socket.sent).toEqual([]);
	socket.open();
	expect(socket.sent.map((data) => JSON.parse(data))).toEqual([{ t: "ping", n: 1 }]);
	const seen: Frame[] = [];
	link.receive((frame) => seen.push(frame));
	socket.message('{"t":"pong","n":1}');
	expect(seen).toEqual([{ t: "pong", n: 1 }]);
	socket.message("x".repeat(201));
	expect(link.closed).toBe(true);
	expect(seen).toHaveLength(1);
	const slow = new FakeWs();
	const other = boundedWebSocketLink(slow, 100);
	for (let n = 0; n < 3; n++) other.send({ t: "ping", n });
	expect(() => other.send({ t: "hello", name: "x".repeat(70), kind: "client", codeVersion: 0 })).toThrow();
	expect(other.closed).toBe(true);
	const blocked = new FakeWs();
	blocked.open();
	blocked.bufferedAmount = 100;
	const third = boundedWebSocketLink(blocked, 100);
	expect(() => third.send({ t: "ping", n: 1 })).toThrow();
	expect(third.closed).toBe(true);
});
