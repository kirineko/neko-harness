import "./support/lang-en.ts";
import { expect, it } from "bun:test";
import { copyToClipboard, OSC52_MAX_BASE64_LENGTH } from "../src/clipboard-write.ts";

type Call = { command: string; args: readonly string[]; input: string };
function harness(options: {
	platform: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	nativeSet?: (text: string) => Promise<void>;
	works?: string[];
}) {
	const calls: Call[] = [];
	const sequences: string[] = [];
	const deps = {
		platform: options.platform,
		env: options.env ?? {},
		native: options.nativeSet ? { setText: options.nativeSet } : undefined,
		run: async (command: string, args: readonly string[], input: string) => {
			calls.push({ command, args, input });
			return options.works?.includes(command) ?? false;
		},
		osc52: (sequence: string) => {
			sequences.push(sequence);
		},
	};
	return { calls, sequences, deps };
}

it("uses the native writer first on macOS without touching tools or OSC 52", async () => {
	const written: string[] = [];
	const h = harness({ platform: "darwin", nativeSet: async (text) => void written.push(text), works: ["pbcopy"] });
	expect(await copyToClipboard("hello", h.deps)).toEqual({ method: "native", osc52Sent: false });
	expect(written).toEqual(["hello"]);
	expect(h.calls).toEqual([]);
	expect(h.sequences).toEqual([]);
});

it("falls back to pbcopy when the native writer throws", async () => {
	const h = harness({
		platform: "darwin",
		nativeSet: async () => {
			throw new Error("no pasteboard");
		},
		works: ["pbcopy"],
	});
	expect(await copyToClipboard("hi", h.deps)).toEqual({ method: "command", osc52Sent: false });
	expect(h.calls).toEqual([{ command: "pbcopy", args: [], input: "hi" }]);
});

it("prefers wl-copy on Wayland, then X11 tools in order, never the native helper on Linux", async () => {
	const native = async () => {
		throw new Error("must not be used on Linux");
	};
	const h = harness({
		platform: "linux",
		env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
		nativeSet: native,
		works: ["xclip"],
	});
	expect(await copyToClipboard("x", h.deps)).toEqual({ method: "command", osc52Sent: false });
	expect(h.calls.map((c) => c.command)).toEqual(["wl-copy", "xclip"]);
	expect(h.calls[1]?.args).toEqual(["-selection", "clipboard"]);

	const x11 = harness({ platform: "linux", env: { DISPLAY: ":0" }, works: ["xsel"] });
	await copyToClipboard("x", x11.deps);
	expect(x11.calls.map((c) => c.command)).toEqual(["xclip", "xsel"]);
});

it("writes Windows text through UTF-8 PowerShell instead of clip.exe", async () => {
	const h = harness({ platform: "win32", works: ["powershell.exe"] });
	await copyToClipboard("中文", h.deps);
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0]?.command).toBe("powershell.exe");
	expect(h.calls[0]?.args.join(" ")).toContain("Set-Clipboard");
	expect(h.calls[0]?.args.join(" ")).toContain("UTF8");
	expect(h.calls[0]?.input).toBe("中文");
});

it("falls back to OSC 52 with a UTF-8 base64 payload when no writer works", async () => {
	const h = harness({ platform: "linux" });
	const result = await copyToClipboard("中文 ok", h.deps);
	expect(result).toEqual({ method: "osc52", osc52Sent: true });
	expect(h.sequences).toHaveLength(1);
	const sequence = h.sequences[0]!;
	expect(sequence.startsWith("\x1b]52;c;")).toBe(true);
	expect(sequence.endsWith("\x07")).toBe(true);
	const payload = sequence.slice("\x1b]52;c;".length, -1);
	expect(Buffer.from(payload, "base64").toString("utf8")).toBe("中文 ok");
});

it("also emits OSC 52 in SSH sessions even when a tool succeeded", async () => {
	const h = harness({
		platform: "linux",
		env: { DISPLAY: ":0", SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
		works: ["xclip"],
	});
	expect(await copyToClipboard("remote", h.deps)).toEqual({ method: "command", osc52Sent: true });
	expect(h.sequences).toHaveLength(1);
});

it("reports a specific error when nothing works and the text exceeds the OSC 52 limit", async () => {
	const huge = "a".repeat(Math.ceil(((OSC52_MAX_BASE64_LENGTH + 1) * 3) / 4));
	const h = harness({ platform: "linux" });
	await expect(copyToClipboard(huge, h.deps)).rejects.toThrow("/export");
	expect(h.sequences).toEqual([]);

	// A working native tool makes the size limit irrelevant, even over SSH.
	const ok = harness({ platform: "linux", env: { DISPLAY: ":0", SSH_CLIENT: "x" }, works: ["xclip"] });
	expect(await copyToClipboard(huge, ok.deps)).toEqual({ method: "command", osc52Sent: false });
});
