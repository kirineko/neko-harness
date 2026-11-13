import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView, EntryQuery, EntryRecord } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { followConversation } from "../src/conversation-follow.ts";
import { InMemoryCredentialStore } from "../src/credentials.ts";
import { createNekoRuntime } from "../src/runtime.ts";

type Listener = (call: { kind: "value"; value: ConversationView; ops: []; retired: false }) => Promise<void>;

/** A conversation whose watch delivers windows the test chooses, over a transcript of entries 1..n. */
function fakeConversation(total: number) {
	const entries: EntryRecord[] = [];
	const extend = (to: number) => {
		for (let id = entries.length + 1; id <= to; id++)
			entries.push({ id, conversationId: 1, kind: "test.entry", createdAt: id } as unknown as EntryRecord);
	};
	extend(total);
	const window = (from: number): ConversationView =>
		({
			conversation: { id: 1 },
			entries: entries.filter((entry) => entry.id >= from),
			...(from > 1 ? { before: from - 1 } : {}),
			docs: {},
		}) as unknown as ConversationView;
	let listener: Listener | undefined;
	let stopped = false;
	const conversation = {
		async watch() {
			return {
				value: window(Math.max(1, entries.length - 49)),
				start(fn: Listener) {
					listener = fn;
				},
				async stop() {
					stopped = true;
				},
			};
		},
		async entries(query: Omit<EntryQuery, "conversationId">, limit: number) {
			const min = query.minEntryId ?? 1;
			const max = query.maxEntryId ?? Number.MAX_SAFE_INTEGER;
			let items = entries.filter((entry) => entry.id >= min && entry.id <= max);
			if (query.order === "descending") items = items.reverse();
			return { items: items.slice(0, limit), next: items.length > limit ? ("more" as never) : undefined };
		},
	} as unknown as Conversation;
	return {
		conversation,
		stopped: () => stopped,
		/** Append entries up to `to` and deliver a window that starts at `from` (a later `from` leaves a gap). */
		async deliver(to: number, from: number) {
			extend(to);
			await listener!({ kind: "value", value: window(from), ops: [], retired: false });
		},
	};
}

const ids = (view: ConversationView): number[] => view.entries.map((entry) => entry.id);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

it("loads the history before Pi's window so the first value holds the whole transcript", async () => {
	const fake = fakeConversation(450);
	const follower = await followConversation(fake.conversation, BACKGROUND_CONTEXT);
	expect(ids(follower.value)).toEqual(range(1, 450));
	expect(follower.value.before).toBeUndefined();
	expect(follower.entry(7)?.id as number | undefined).toBe(7);
	follower.dispose();
	expect(fake.stopped()).toBe(true);
});

it("fills the gap a later window leaves after an overflow, so entries stay complete and in order", async () => {
	const fake = fakeConversation(120);
	const follower = await followConversation(fake.conversation, BACKGROUND_CONTEXT);
	const seen: number[][] = [];
	follower.subscribe((value) => seen.push(ids(value)));
	// Appends that continue the window.
	await fake.deliver(130, 71);
	// An overflow: the next window starts at 560, entries 131..559 are missing until filled.
	await fake.deliver(600, 560);
	expect(seen).toEqual([range(1, 130), range(1, 600)]);
	expect(ids(follower.value)).toEqual(range(1, 600));
	follower.dispose();
});

it("keeps a real conversation's transcript complete past Pi's window while entries are appended", async () => {
	const runtime = await createNekoRuntime({ storage: "memory", credentials: new InMemoryCredentialStore() });
	try {
		const note = (n: number) =>
			runtime.conversation.submit({ type: "write", entry: { kind: "test.note", data: { n } } }, runtime.context);
		for (let n = 0; n < 150; n++) await note(n);
		const follower = await runtime.follow();
		const notes = () =>
			follower.value.entries.flatMap((entry) => (entry.kind === "test.note" ? [(entry.data as { n: number }).n] : []));
		expect(notes()).toEqual(range(0, 149));
		await Promise.all(range(150, 399).map(note));
		for (let i = 0; i < 100 && notes().length < 400; i++) await sleep(10);
		expect(notes().sort((a, b) => a - b)).toEqual(range(0, 399));
		const entryIds = follower.value.entries.map((entry) => entry.id);
		expect(entryIds).toEqual([...entryIds].sort((a, b) => a - b));
		follower.dispose();
	} finally {
		await runtime.close();
	}
});
