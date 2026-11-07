import type { Context } from "@earendil-works/chord";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextEdit, ConversationId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { onCommits } from "./commits.ts";
import type { EffectiveContextSettings } from "./context-settings.ts";

/** Application entry that carries the context edits; invisible to every frontend. */
export const PRUNE_ENTRY_KIND = "app.neko.context-prune";

/** Tokens per character from DeepSeek's token usage guide: about 0.3 for English text and 0.6 for Chinese. */
const TOKENS_PER_LATIN_CHAR = 0.3;
const TOKENS_PER_CJK_CHAR = 0.6;
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/** Estimated tokens of a text; only used to size a prune batch against the model window. */
export function estimateTokens(text: string): number {
	const cjk = text.match(CJK)?.length ?? 0;
	return cjk * TOKENS_PER_CJK_CHAR + (text.length - cjk) * TOKENS_PER_LATIN_CHAR;
}

export type PruneSettings = EffectiveContextSettings["pruning"];

export type PrunePlan = {
	readonly edits: readonly ContextEdit[];
	/** Entry ids that were replaced, for the entry's data. */
	readonly targets: readonly number[];
	readonly savedChars: number;
	/** Estimated tokens the plan frees. */
	readonly savedTokens: number;
};

const isToolResult = (entry: EntryRecord): entry is EntryRecord & { model: readonly [ToolResultMessage] } => {
	const message = entry.model?.[0];
	return entry.kind === "pi.tool-result" && message?.role === "toolResult";
};

const resultTexts = (message: ToolResultMessage) =>
	message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));

/** Text characters a tool result puts into the model context. */
export function toolResultChars(message: ToolResultMessage): number {
	return resultTexts(message).reduce((total, text) => total + text.length, 0);
}

export function toolResultTokens(message: ToolResultMessage): number {
	return resultTexts(message).reduce((total, text) => total + estimateTokens(text), 0);
}

export function prunedPlaceholder(message: ToolResultMessage, chars: number): ToolResultMessage {
	const { details: _details, ...rest } = message;
	return {
		...rest,
		content: [
			{
				type: "text",
				text: `[Output of ${message.toolName} omitted from context to save space (${chars} characters). Run the tool again if the content is needed.]`,
			},
		],
	};
}

/**
 * Pick the old, large tool results of an active transcript. The newest `keepRecent` results are kept verbatim,
 * results already replaced by an earlier plan are skipped, and results shorter than `minChars` are never touched.
 */
export function planPrune(
	entries: readonly EntryRecord[],
	settings: Pick<PruneSettings, "keepRecent" | "minChars">,
): PrunePlan | undefined {
	const replaced = new Set<number>();
	for (const entry of entries) for (const edit of entry.edits ?? []) replaced.add(edit.target);
	const results = entries.filter(isToolResult);
	const candidates = results.slice(0, Math.max(0, results.length - settings.keepRecent));
	const edits: ContextEdit[] = [];
	const targets: number[] = [];
	let savedChars = 0;
	let savedTokens = 0;
	for (const entry of candidates) {
		if (replaced.has(entry.id)) continue;
		const message = entry.model[0];
		const chars = toolResultChars(message);
		if (chars < settings.minChars) continue;
		const replacement: Message = prunedPlaceholder(message, chars);
		edits.push({ target: entry.id, action: "replace", messages: [replacement] });
		targets.push(entry.id);
		savedChars += chars;
		savedTokens += toolResultTokens(message);
	}
	return edits.length === 0 ? undefined : { edits, targets, savedChars, savedTokens };
}

export type ContextPrunerOptions = {
	readonly harness: Harness;
	readonly context: Context;
	readonly settings: () => PruneSettings;
	/** Context window of the conversation's current model; 0 when unknown. */
	readonly windowOf: (id: ConversationId) => Promise<number>;
	readonly report: (error: unknown) => void;
};

/**
 * Watches commits and, once a successful answer reports a context at or above the configured percent of the
 * model window and enough prunable output has piled up (`minSavePercent`), writes one batch of context edits. A
 * write is placed after the current tool round, before the next request. Request ids are derived from the
 * triggering answer, so a repeat never writes twice.
 */
export class ContextPruner {
	readonly #options: ContextPrunerOptions;
	readonly #unsubscribe: () => void;
	#tail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: ContextPrunerOptions) {
		this.#options = options;
		this.#unsubscribe = onCommits(options.harness, ({ changes }) => {
			if (!options.settings().enabled) return;
			for (const change of changes) {
				if (change.type !== "entry" || change.value.kind !== "pi.assistant") continue;
				const message = change.value.model?.[0];
				if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error")
					continue;
				const usage = message.usage;
				const tokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				if (tokens <= 0) continue;
				const { conversationId, id } = change.value;
				this.#enqueue(() => this.#evaluate(conversationId, id, tokens));
			}
		});
	}

	/** Resolves once the queued evaluations have run (tests and shutdown). */
	async flush(): Promise<void> {
		await this.#tail;
	}

	close(): void {
		this.#closed = true;
		this.#unsubscribe();
	}

	#enqueue(work: () => Promise<void>): void {
		if (this.#closed) return;
		this.#tail = this.#tail.then(work).catch((error) => {
			if (!this.#closed) this.#options.report(error);
		});
	}

	async #evaluate(conversationId: ConversationId, entryId: number, tokens: number): Promise<void> {
		const { harness, context } = this.#options;
		const settings = this.#options.settings();
		if (!settings.enabled) return;
		const window = await this.#options.windowOf(conversationId);
		if (window <= 0 || (tokens / window) * 100 < settings.triggerPercent) return;
		const conversation = await harness.conversation(conversationId, context);
		if (!conversation) return;
		const view = await conversation.context(context);
		const plan = planPrune(view.entries, settings);
		if (!plan) return;
		// An edit re-reads everything after it uncached, so wait until a batch frees enough to be worth that.
		if ((plan.savedTokens / window) * 100 < settings.minSavePercent) return;
		await conversation.submit(
			{
				type: "write",
				requestId: `prune:${entryId}`,
				entry: {
					kind: PRUNE_ENTRY_KIND,
					data: { targets: [...plan.targets], savedChars: plan.savedChars },
					edits: plan.edits,
				},
			},
			context,
		);
	}
}
