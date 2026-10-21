import type { ChatImage, ChatItem } from "@neko-harness/core";
import {
	type ExportFormat,
	type ExportResult,
	exportConversation,
	exportFileName,
} from "@neko-harness/core/conversation-export";
import type { ImageFile } from "@neko-harness/core/image-transfer";
import { getT } from "./i18n/index.ts";

export class ExportCancelledError extends Error {
	constructor() {
		super(getT()("export.cancelled"));
		this.name = "ExportCancelledError";
	}
}

export type ExportSnapshot = {
	sessionId: string;
	title: string;
	model: string;
	cwd: string;
	items: readonly ChatItem[];
};

export type SessionExport = ExportResult & { fileName: string };

/**
 * Builds the export from a snapshot taken when the user clicked. Image reads are guarded by the
 * current session: once it changes the export is cancelled instead of silently embedding placeholders.
 */
export async function buildSessionExport(args: {
	format: ExportFormat;
	includeThinking: boolean;
	snapshot: ExportSnapshot;
	currentSessionId: () => string | null;
	readImage: (image: ChatImage, sessionId: string) => Promise<ImageFile>;
	now?: Date;
}): Promise<SessionExport> {
	const { snapshot } = args;
	const now = args.now ?? new Date();
	let cancelled = false;
	const result = await exportConversation(
		args.format,
		{ ...snapshot, exportedAt: now },
		{
			includeThinking: args.includeThinking,
			loadImage: (image) => {
				if (args.currentSessionId() !== snapshot.sessionId) {
					cancelled = true;
					return Promise.reject(new ExportCancelledError());
				}
				return args.readImage(image, snapshot.sessionId);
			},
		},
	);
	if (cancelled) throw new ExportCancelledError();
	return { ...result, fileName: exportFileName(snapshot.title, args.format, now) };
}

/** Completion notice text: file name plus how many images could not be embedded. */
export function exportNotice(result: Pick<SessionExport, "fileName" | "skippedImages">): string {
	const t = getT();
	return result.skippedImages > 0
		? t("export.doneSkipped", { name: result.fileName, count: result.skippedImages })
		: t("export.done", { name: result.fileName });
}

export function downloadFile(fileName: string, content: string, mimeType: string): void {
	const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.hidden = true;
	document.body.append(link);
	try {
		link.click();
	} finally {
		link.remove();
		// Revoke on the next task so the browser has started the download.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}
