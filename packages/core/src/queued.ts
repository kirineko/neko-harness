import type { ConversationView } from "@earendil-works/pi-durable";
import { savedDefaultImagePrompt } from "./image-prompt.ts";
import { type InputData, NekoInput } from "./input.ts";

/** Longest preview broadcast with the view; the full text is read from the transcript once it is placed. */
export const QUEUED_PREVIEW_CHARS = 300;

/** A user input waiting in the conversation's inbox for a boundary. */
export type QueuedInput = {
	/** Submission id; pass it to `NekoSession.withdraw`. */
	id: number;
	mode: "steer" | "followUp";
	preview: string;
	images: number;
	skill?: { name: string; args: string };
};

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((b) => (b && b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("");
};

const clip = (text: string) => {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length > QUEUED_PREVIEW_CHARS ? `${chars.slice(0, QUEUED_PREVIEW_CHARS - 1).join("")}…` : chars.join("");
};

/** A queued user input with its full text; system inputs (job reports, subagent rounds) and writes are `undefined`. */
export function queuedUserInput(raw: unknown): (Omit<QueuedInput, "preview"> & { text: string }) | undefined {
	const item = raw as { id: number; mode: string; content?: unknown; entry?: { kind?: string; data?: unknown } };
	if (item.mode !== "steer" && item.mode !== "followUp") return undefined;
	if (item.entry?.kind !== NekoInput.kind) return undefined;
	const data = item.entry.data as InputData | undefined;
	if (!data || data.jobReport || data.planDecision || data.subagentRoundId) return undefined;
	const defaultPrompt = Array.isArray(item.content)
		? savedDefaultImagePrompt(item.content as never, data.defaultImagePrompt)
		: undefined;
	const content = defaultPrompt && Array.isArray(item.content) ? item.content.slice(1) : item.content;
	const skill = data.skill ? { name: data.skill.name, args: data.skill.args } : undefined;
	return {
		id: item.id,
		mode: item.mode,
		text: skill ? `/skill:${skill.name}${skill.args ? ` ${skill.args}` : ""}` : textOf(content),
		images: data.images?.length ?? 0,
		...(skill ? { skill } : {}),
	};
}

/** User inputs of `pi.inbox` in acceptance order, with a bounded preview. */
export function projectQueued(view: ConversationView): QueuedInput[] {
	const items = (view.docs["pi.inbox"] as { items?: unknown[] } | undefined)?.items ?? [];
	return items.flatMap((raw) => {
		const input = queuedUserInput(raw);
		if (!input) return [];
		const { text, ...rest } = input;
		return [{ ...rest, preview: clip(text) }];
	});
}
