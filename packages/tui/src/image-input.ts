import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import type { ImageFile } from "@neko-harness/core/image-transfer";

const exec = promisify(execFile);
export function imagePaths(text: string, platform: string = process.platform): string[] | null {
	const paths: string[] = [];
	let word = "",
		quote = "",
		escaped = false;
	for (const c of text.trim()) {
		if (escaped) {
			word += c;
			escaped = false;
		} else if (c === "\\" && quote !== "'" && platform !== "win32") {
			// Windows 下 \ 是路径分隔符，不作转义符（否则 D:\code\img.png 被吞成 D:codeimg.png）。
			escaped = true;
		} else if (quote) {
			if (c === quote) quote = "";
			else word += c;
		} else if (c === '"' || c === "'") quote = c;
		else if (/\s/.test(c)) {
			if (word) {
				paths.push(word);
				word = "";
			}
		} else word += c;
	}
	if (quote || escaped) return null;
	if (word) paths.push(word);
	return paths.length && paths.every((p) => /\.(png|jpe?g|webp)$/i.test(p)) ? paths : null;
}
/** Expands a leading `~/` (and `~\` on Windows) to the home directory. */
export function expandHome(path: string, platform: string = process.platform): string {
	if (path.startsWith("~/") || (platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
	return path;
}

export async function readImageFile(
	path: string,
	cwd: string,
	platform: string = process.platform,
): Promise<ImageFile> {
	const full = resolve(cwd, expandHome(path, platform));
	const info = await stat(full);
	if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("Image must be a file no larger than 20 MiB");
	const bytes = await readFile(full);
	const after = await stat(full);
	if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
		throw new Error("Image changed while reading");
	const mimeType = /\.png$/i.test(full) ? "image/png" : /\.webp$/i.test(full) ? "image/webp" : "image/jpeg";
	return { name: basename(full), mimeType, bytes };
}
async function command(file: string, args: string[], encoding: "utf8" | "buffer" = "utf8", timeout = 2000) {
	return (await exec(file, args, { timeout, maxBuffer: 30 * 1024 * 1024, encoding })).stdout;
}
export async function clipboard(
	options: { platform?: string; wayland?: boolean; wsl?: boolean; command?: typeof command } = {},
): Promise<{ paths?: string[]; image?: ImageFile; text?: string }> {
	const run = options.command ?? command;
	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const files = await run("osascript", [
			"-e",
			'try\nset fs to the clipboard as «class furl»\nreturn POSIX path of fs\non error\nreturn ""\nend try',
		]).catch(() => "");
		if (String(files).trim())
			return /\.(png|jpe?g|webp)$/i.test(String(files).trim())
				? { paths: [String(files).trim()] }
				: { text: String(files).trim() };
		const image = String(
			await run("osascript", ["-e", 'try\nreturn the clipboard as «class PNGf»\non error\nreturn ""\nend try']).catch(
				() => "",
			),
		);
		const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(image)?.[1];
		if (hex) return { image: { name: "Clipboard.png", mimeType: "image/png", bytes: Buffer.from(hex, "hex") } };
		return { text: String(await run("pbpaste", [])) };
	}
	if (platform === "win32") return windowsClipboard(run);
	let windowsError: unknown;
	if (platform === "linux" && (options.wsl ?? runningInWsl())) {
		// Windows screenshots and copied text only reach the Windows clipboard; wl-paste/xclip cannot see images from it.
		try {
			return await windowsClipboard(run);
		} catch (error) {
			windowsError = error;
		}
	}
	const wayland = options.wayland ?? !!process.env.WAYLAND_DISPLAY;
	const tool = wayland ? "wl-paste" : "xclip";
	try {
		const bytes = await run(
			tool,
			wayland ? ["--type", "image/png"] : ["-selection", "clipboard", "-t", "image/png", "-o"],
			"buffer",
		);
		if (bytes.length) return { image: { name: "Clipboard.png", mimeType: "image/png", bytes: Buffer.from(bytes) } };
	} catch {}
	try {
		return { text: String(await run(tool, wayland ? ["--no-newline"] : ["-selection", "clipboard", "-o"])) };
	} catch (error) {
		// On WSL the PowerShell failure is the actionable one; a missing xclip is only noise.
		throw windowsError ?? error;
	}
}

const WINDOWS_CLIPBOARD_SCRIPT = [
	// Console output defaults to the OEM code page, which garbles non-ASCII text. Setting it can throw without a console.
	"try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{}",
	"Add-Type -AssemblyName System.Windows.Forms",
	"$i=[Windows.Forms.Clipboard]::GetImage()",
	'if($i){$m=New-Object IO.MemoryStream; $i.Save($m,[Drawing.Imaging.ImageFormat]::Png); "IMAGE:"+[Convert]::ToBase64String($m.ToArray());$i.Dispose();$m.Dispose()}else{Get-Clipboard -Raw}',
].join("; ");

/** Reads the Windows clipboard through powershell.exe, which is also reachable from WSL via interop. */
async function windowsClipboard(run: typeof command): Promise<{ image?: ImageFile; text?: string }> {
	// Cold PowerShell start plus Windows.Forms load can exceed the default 2s, especially across WSL interop.
	const value = String(
		await run("powershell.exe", ["-NoProfile", "-STA", "-Command", WINDOWS_CLIPBOARD_SCRIPT], "utf8", 8000),
	);
	if (value.startsWith("IMAGE:"))
		return {
			image: { name: "Clipboard.png", mimeType: "image/png", bytes: Buffer.from(value.slice(6).trim(), "base64") },
		};
	// Write-Output appends one line break to the raw clipboard text.
	return { text: value.replace(/\r?\n$/, "") };
}

let wslHost: boolean | undefined;
/** Whether this process runs inside WSL; evaluated once because key handling asks on every keystroke. */
export function runningInWsl(): boolean {
	wslHost ??=
		process.platform === "linux" &&
		(Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || process.env.WSLENV) ||
			/microsoft|wsl/i.test(readFileOrEmpty("/proc/version")));
	return wslHost;
}
function readFileOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Windows Terminal turns Ctrl+V into a text paste before the app sees it, so Windows and WSL use Alt+V. */
export function clipboardShortcutKey(
	platform: string = process.platform,
	wsl: boolean = runningInWsl(),
): "alt+v" | "ctrl+v" {
	return platform === "win32" || (platform === "linux" && wsl) ? "alt+v" : "ctrl+v";
}

export function isClipboardShortcut(
	data: string,
	platform: string = process.platform,
	wsl: boolean = runningInWsl(),
): boolean {
	return !isKeyRelease(data) && !isKeyRepeat(data) && matchesKey(data, clipboardShortcutKey(platform, wsl));
}
