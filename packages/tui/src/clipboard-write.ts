import { spawn } from "node:child_process";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import type { ChatItem } from "@neko-harness/core";
import { lastAnswerText } from "@neko-harness/core/conversation-export";
import type { NoticeLevel } from "./components/notice.ts";
import { t } from "./i18n/index.ts";

/** Largest base64 payload sent through OSC 52; many terminals drop longer sequences. */
export const OSC52_MAX_BASE64_LENGTH = 100_000;
const COMMAND_TIMEOUT_MS = 3000;

export type ClipboardWriteResult = {
	/** `osc52` means no verified writer succeeded; the terminal may still ignore the sequence. */
	method: "native" | "command" | "osc52";
	/** True when an OSC 52 sequence was emitted, always for SSH/mosh sessions. */
	osc52Sent: boolean;
};
export type ClipboardWriteDeps = {
	/** Writes a raw escape sequence to the controlling terminal. */
	osc52: (sequence: string) => void;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	native?: { setText?: (text: string) => Promise<void> } | undefined;
	/** Runs a clipboard tool with `input` on stdin; resolves true on exit code 0. */
	run?: (command: string, args: readonly string[], input: string) => Promise<boolean>;
};

/** Clipboard tools may daemonize to keep the selection, so they get no output pipes to hold open. */
function runClipboardCommand(command: string, args: readonly string[], input: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		resolve(false);
	}, COMMAND_TIMEOUT_MS);
	child.on("error", () => {
		clearTimeout(timer);
		resolve(false);
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		resolve(code === 0);
	});
	child.stdin.on("error", () => {});
	child.stdin.end(input);
	return promise;
}

/**
 * Writes text to the system clipboard: native binding, then platform tools, then OSC 52 as the
 * last resort. SSH/mosh sessions also get OSC 52 because the user's clipboard is on the other end.
 */
export async function copyToClipboard(text: string, deps: ClipboardWriteDeps): Promise<ClipboardWriteResult> {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const native = "native" in deps ? deps.native : getNativeClipboard();
	const run = deps.run ?? runClipboardCommand;

	let method: "native" | "command" | null = null;
	// The native Linux helper does not keep selection ownership; tools below do.
	if (platform !== "linux" && native?.setText !== undefined) {
		try {
			await native.setText(text);
			method = "native";
		} catch {
			// Fall through to platform tools.
		}
	}
	if (method === null) {
		const tools: [string, string[]][] = [];
		if (platform === "darwin") tools.push(["pbcopy", []]);
		else if (platform === "win32")
			// clip.exe decodes stdin with the console code page and corrupts non-ASCII text, so read UTF-8 explicitly.
			tools.push([
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"$t=[IO.StreamReader]::new([Console]::OpenStandardInput(),[Text.UTF8Encoding]::new($false)).ReadToEnd();Set-Clipboard -Value $t",
				],
			]);
		else {
			if (env.TERMUX_VERSION) tools.push(["termux-clipboard-set", []]);
			if (env.WAYLAND_DISPLAY) tools.push(["wl-copy", []]);
			if (env.DISPLAY) tools.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
		}
		for (const [command, args] of tools) {
			if (await run(command, args, text)) {
				method = "command";
				break;
			}
		}
	}

	const remote = Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
	let osc52Sent = false;
	if (method === null || remote) {
		const encoded = Buffer.from(text).toString("base64");
		if (encoded.length <= OSC52_MAX_BASE64_LENGTH) {
			deps.osc52(`\x1b]52;c;${encoded}\x07`);
			osc52Sent = true;
		}
	}
	if (method === null && !osc52Sent) throw new Error(t("clipboard.tooLarge", { count: text.length }));
	return { method: method ?? "osc52", osc52Sent };
}

export type CopyOutcome = { level: NoticeLevel; message: string };

/** `/copy`: copies the last answer body (never thinking) and describes the result for a notice. */
export async function copyLastAnswer(items: readonly ChatItem[], deps: ClipboardWriteDeps): Promise<CopyOutcome> {
	const text = lastAnswerText(items);
	if (text === null) return { level: "warning", message: t("copy.nothing") };
	try {
		const result = await copyToClipboard(text, deps);
		return {
			level: "info",
			message: result.osc52Sent ? t("copy.osc52", { count: text.length }) : t("copy.copied", { count: text.length }),
		};
	} catch (error) {
		return { level: "error", message: error instanceof Error ? error.message : String(error) };
	}
}
