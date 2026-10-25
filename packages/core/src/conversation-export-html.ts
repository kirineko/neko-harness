/**
 * HTML export: a static, script-free single file. Everything user- or model-controlled is escaped;
 * the page also carries a CSP that forbids scripts and any external resource.
 */
import { Marked } from "marked";
import {
	codemodeCallLine,
	codemodeOmittedLine,
	type ExportOptions,
	type ExportSource,
	FALLBACK_EXPORT_TITLE,
	formatDuration,
	imageLabel,
	oneLine,
	toolOutput,
	toolStatus,
	userText,
} from "./conversation-items.ts";
import { encodeChunk } from "./image-transfer.ts";
import type { ChatImage } from "./projection.ts";

/** Total size of images embedded into one HTML export; the rest become placeholders. */
export const MAX_EMBEDDED_IMAGE_BYTES = 32 * 1024 * 1024;
const SAFE_IMAGE_TYPE = /^image\/(png|jpeg|webp|gif)$/i;
const SAFE_LINK = /^(https?:|mailto:)/i;
/** A multiple of 3, so every base64 slice is padding-free and the slices concatenate. */
const BASE64_SLICE_BYTES = 3 * 16 * 1024;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--user:#eef4ff;--code:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--border:#30363d;--user:#16243a;--code:#161b22}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.5rem;margin:0 0 4px}
.meta{color:var(--muted);font-size:.85rem;margin:0 0 24px}
.msg{margin:16px 0;padding:12px 16px;border:1px solid var(--border);border-radius:12px}
.msg.user{background:var(--user)}
.role{font-size:.75rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.system{text-align:center;color:var(--muted);font-size:.85rem;margin:16px 0}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md pre,pre{background:var(--code);border-radius:8px;padding:10px 12px;overflow:auto;font-size:.85rem;white-space:pre-wrap;overflow-wrap:anywhere}
.md code{background:var(--code);border-radius:4px;padding:1px 4px}.md pre code{background:none;padding:0}
.md table{border-collapse:collapse}.md th,.md td{border:1px solid var(--border);padding:4px 8px}
.md blockquote{margin:0;padding-left:12px;border-left:3px solid var(--border);color:var(--muted)}
details{margin:8px 0}summary{cursor:pointer;color:var(--muted)}
details.tool{border:1px solid var(--border);border-radius:8px;padding:6px 12px;margin:12px 0}
details.tool.error>summary .status{color:#cf222e}
.label{font-size:.75rem;color:var(--muted);margin-top:8px}
.note{color:var(--muted);font-style:italic;margin-top:6px}
figure{margin:8px 0}img{max-width:100%;height:auto;border-radius:8px}figcaption,.placeholder{color:var(--muted);font-size:.8rem}
`;

const escapeHtml = (text: string): string =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

/** Own instance: the shared `marked` singleton is reconfigured by the web UI with unsanitised output. */
const markdown = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		html: ({ text }) => escapeHtml(text),
		link({ href, title, tokens }) {
			const label = this.parser.parseInline(tokens);
			if (!SAFE_LINK.test(href.trim())) return label;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(href)}"${titleAttr} rel="noopener noreferrer" target="_blank">${label}</a>`;
		},
		image({ href, text }) {
			const label = `[image: ${escapeHtml(text || href)}]`;
			return SAFE_LINK.test(href.trim())
				? `<a href="${escapeHtml(href)}" rel="noopener noreferrer" target="_blank">${label}</a>`
				: label;
		},
	},
});

type Embedded = { src: string } | { reason: string };

/** Reads images in transcript order under the size budget; failures become placeholders, never errors. */
async function embedImages(
	items: ExportSource["items"],
	loadImage: ExportOptions["loadImage"],
): Promise<{ embedded: Map<string, Embedded>; skipped: number }> {
	const embedded = new Map<string, Embedded>();
	let used = 0;
	let skipped = 0;
	for (const item of items) {
		if (item.type !== "user" && item.type !== "tool") continue;
		for (const image of item.images ?? []) {
			let reason: string | null = null;
			if (loadImage === undefined) reason = "not embedded";
			else if (used + image.bytes > MAX_EMBEDDED_IMAGE_BYTES) reason = "over the embedding size limit";
			else {
				try {
					const file = await loadImage(image);
					if (!SAFE_IMAGE_TYPE.test(file.mimeType)) reason = "unsupported image type";
					else if (used + file.bytes.length > MAX_EMBEDDED_IMAGE_BYTES) reason = "over the embedding size limit";
					else {
						used += file.bytes.length;
						const parts: string[] = [];
						for (let at = 0; at < file.bytes.length; at += BASE64_SLICE_BYTES)
							parts.push(encodeChunk(file.bytes.subarray(at, at + BASE64_SLICE_BYTES)));
						embedded.set(`${image.entryId}:${image.contentIndex}`, {
							src: `data:${file.mimeType.toLowerCase()};base64,${parts.join("")}`,
						});
					}
				} catch {
					reason = "image unavailable";
				}
			}
			if (reason !== null) {
				embedded.set(`${image.entryId}:${image.contentIndex}`, { reason });
				skipped++;
			}
		}
	}
	return { embedded, skipped };
}

function renderImages(images: readonly ChatImage[] | undefined, embedded: Map<string, Embedded>): string {
	return (images ?? [])
		.map((image) => {
			const found = embedded.get(`${image.entryId}:${image.contentIndex}`);
			const label = escapeHtml(imageLabel(image));
			if (found !== undefined && "src" in found)
				return `<figure><img src="${found.src}" alt="${escapeHtml(image.name)}"><figcaption>${label}</figcaption></figure>`;
			const reason = found !== undefined && "reason" in found ? ` — ${found.reason}` : "";
			return `<p class="placeholder">[image: ${label}${reason}]</p>`;
		})
		.join("");
}

export async function exportHtml(
	source: ExportSource,
	options: ExportOptions,
): Promise<{ content: string; skippedImages: number }> {
	const { embedded, skipped } = await embedImages(source.items, options.loadImage);
	const title = escapeHtml(oneLine(source.title) || FALLBACK_EXPORT_TITLE);
	const body: string[] = [];
	for (const item of source.items) {
		if (item.type === "system") {
			body.push(`<div class="system">${escapeHtml(oneLine(item.text))}</div>`);
		} else if (item.type === "user") {
			const text = userText(item);
			body.push(
				`<section class="msg user"><div class="role">User</div>${
					text === "" ? "" : `<div class="text">${escapeHtml(text)}</div>`
				}${renderImages(item.images, embedded)}</section>`,
			);
		} else if (item.type === "assistant") {
			const thinking =
				options.includeThinking && item.thinking.trim() !== ""
					? `<details class="thinking"><summary>Thinking</summary><div class="text">${escapeHtml(item.thinking.trim())}</div></details>`
					: "";
			const text =
				item.text.trim() === "" ? "" : `<div class="md">${markdown.parse(item.text.trim(), { async: false })}</div>`;
			const note = item.note === null ? "" : `<div class="note">${escapeHtml(oneLine(item.note))}</div>`;
			body.push(`<section class="msg assistant"><div class="role">Assistant</div>${thinking}${text}${note}</section>`);
		} else {
			const status = toolStatus(item);
			const output = toolOutput(item);
			const heading = [
				`<b>Tool</b> ${escapeHtml(item.name)}`,
				item.summary === "" ? "" : `<span class="args">${escapeHtml(oneLine(item.summary))}</span>`,
				status === "ok" ? "" : `<span class="status">[${status}]</span>`,
				item.durationMs === null ? "" : `<span class="duration">(${formatDuration(item.durationMs)})</span>`,
			]
				.filter(Boolean)
				.join(" ");
			const calls =
				item.codemode === undefined || item.codemode.calls.length === 0
					? ""
					: `<div class="label">Calls</div><pre>${escapeHtml(
							[
								...item.codemode.calls.map(codemodeCallLine),
								...(item.codemode.omitted > 0 ? [codemodeOmittedLine(item.codemode.omitted)] : []),
							].join("\n"),
						)}</pre>`;
			body.push(
				`<details class="tool ${status}"><summary>${heading}</summary>${
					item.detail === null || item.detail === ""
						? ""
						: `<pre${item.codemode === undefined ? "" : ' class="language-javascript"'}>${escapeHtml(item.detail)}</pre>`
				}${calls}${
					output === ""
						? ""
						: `<div class="label">${status === "running" ? "Output so far" : "Result"}</div><pre>${escapeHtml(output)}</pre>`
				}${item.note === null ? "" : `<div class="note">${escapeHtml(oneLine(item.note))}</div>`}${renderImages(
					item.images,
					embedded,
				)}</details>`,
			);
		}
	}
	const content = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="meta">${escapeHtml(oneLine(source.model))} · ${escapeHtml(oneLine(source.cwd))} · ${escapeHtml(source.exportedAt.toISOString())}</p>
${body.join("\n")}
</main>
</body>
</html>
`;
	return { content, skippedImages: skipped };
}
