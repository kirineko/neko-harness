import { defineEntry } from "@earendil-works/pi-durable";
import type { DefaultImagePrompt } from "./image-prompt.ts";
import type { ImageInfo } from "./images.ts";
import type { SkillInvocation } from "./skill-invocation.ts";

export type InputData = {
	at: number;
	subagentRoundId?: number;
	prompt: string;
	images: (ImageInfo & { contentIndex: number })[];
	skill?: SkillInvocation;
	defaultImagePrompt?: DefaultImagePrompt;
	/** A background job's completion report; shown as a system item, never as user input or history. */
	jobReport?: { jobId: string; status: string; exitCode: number | null };
	/** The input a plan decision produced (execute / revise); shown as a decision record, never as user input or history. */
	planDecision?: { version: string; kind: "approve" | "revise"; title: string; feedback?: string };
};
/** Content and UI metadata travel in the same durable input, including while queued. */
export const NekoInput = defineEntry<InputData>("app.neko.input");
