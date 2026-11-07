import type { Context } from "@earendil-works/chord";
import {
	type Conversation,
	ConversationTranscript,
	type ConversationView,
	type EntryId,
	type EntryRecord,
	type TranscriptView,
} from "@earendil-works/pi-durable";

/** A conversation's live view whose `entries` is the whole transcript, not Pi's bounded window. */
export type ConversationFollower = {
	/** The newest view; `entries` holds every entry from the start of the transcript, in ID order. */
	readonly value: ConversationView;
	/** Calls `listener` after each change, once the transcript is complete again; returns the unsubscribe. */
	subscribe(listener: (value: ConversationView) => void): () => void;
	/** One entry of the transcript, if present. */
	entry(id: number): EntryRecord | undefined;
	/** Stops following; the last value stays readable. */
	dispose(): void;
};

/** Entries per page when loading history before the window or filling a gap. */
const PAGE_SIZE = 200;

/**
 * Follow a conversation: Pi's window (`Conversation.watch()`) merged into a `ConversationTranscript` that loads the
 * history before the first window and fills every gap a later window leaves (a stalled listener, an overflow), so
 * frontends keep getting the whole transcript. The watch listener is serialized, so commits arriving while a gap is
 * filled are folded into the next call and never reorder the transcript.
 */
export async function followConversation(conversation: Conversation, context: Context): Promise<ConversationFollower> {
	const transcript = new ConversationTranscript(
		(query, limit, ctx) => conversation.entries(query, limit, undefined, ctx),
		{ pageSize: PAGE_SIZE },
	);
	const watch = await conversation.watch(context);
	const listeners = new Set<(value: ConversationView) => void>();
	let byId: Map<number, EntryRecord> | undefined;
	let value: ConversationView;
	const complete = async (view: TranscriptView): Promise<ConversationView> => {
		while (view.items[0]?.kind === "earlier") {
			const before = view.items;
			view = await transcript.loadEarlier(context);
			if (view.items === before) break;
		}
		for (let gap = view.items.find((item) => item.kind === "gap"); gap; ) {
			const before = view.items;
			view = await transcript.fillGap(gap, context);
			// A fill that adds nothing returns the same items; stop instead of asking again.
			if (view.items === before) break;
			gap = view.items.find((item) => item.kind === "gap");
		}
		const { items, ...rest } = view;
		byId = undefined;
		return { ...rest, entries: items.flatMap((item) => (item.kind === "entry" ? [item.entry] : [])) };
	};
	try {
		value = await complete(transcript.merge(watch.value));
	} catch (error) {
		await watch.stop();
		throw error;
	}
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		value = await complete(transcript.merge(call.value));
		for (const listener of listeners) listener(value);
	});
	return {
		get value() {
			return value;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		entry(id) {
			byId ??= new Map(value.entries.map((entry) => [entry.id, entry]));
			return byId.get(id as EntryId);
		},
		dispose() {
			listeners.clear();
			void watch.stop();
		},
	};
}
