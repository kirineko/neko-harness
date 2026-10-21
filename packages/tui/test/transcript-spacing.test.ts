import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { ImageTranscript } from "../src/components/history-image.ts";

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");

it("spaces top-level items with one blank line, except the first", () => {
	const transcript = new ImageTranscript(() => undefined);
	transcript.addItem(new Text("one", 0, 0));
	transcript.addItem(new Text("two", 0, 0));
	transcript.addItem(new Text("three", 0, 0));
	expect(plain(transcript.render(40))).toBe("one\n\ntwo\n\nthree");
});

it("does not space attached content added via addChild", () => {
	const transcript = new ImageTranscript(() => undefined);
	transcript.addItem(new Text("item", 0, 0));
	transcript.addChild(new Text("attachment", 0, 0));
	expect(plain(transcript.render(40))).toBe("item\nattachment");
});

it("resets spacing after clear", () => {
	const transcript = new ImageTranscript(() => undefined);
	transcript.addItem(new Text("one", 0, 0));
	transcript.clear();
	expect(transcript.itemCount).toBe(0);
	transcript.addItem(new Text("two", 0, 0));
	expect(plain(transcript.render(40))).toBe("two");
});

it("removes an item together with its leading spacer", () => {
	const transcript = new ImageTranscript(() => undefined);
	const first = new Text("one", 0, 0);
	const transient = new Text("streaming", 0, 0);
	transcript.addItem(first);
	transcript.addItem(transient);
	transcript.removeItem(transient);
	expect(transcript.itemCount).toBe(1);
	transcript.addItem(new Text("two", 0, 0));
	expect(plain(transcript.render(40))).toBe("one\n\ntwo");
});
