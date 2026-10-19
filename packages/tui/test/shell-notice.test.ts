import { expect, it } from "bun:test";
import { createShellNotifier, shellNoticeText } from "../src/shell-notice.ts";

const missing = { status: "missing", reason: "not_found" } as const;
const ready = { status: "ready", path: "C:\\Program Files\\Git\\bin\\bash.exe" } as const;

it("guides the user to install Git for Windows or set shell.path", () => {
	const text = shellNoticeText(missing) ?? "";
	expect(text).toContain("Git for Windows");
	expect(text).toContain("shell.path");
	expect(text).toContain("bash and background jobs are unavailable");
	expect(shellNoticeText(ready)).toBeUndefined();
});

it("explains an invalid shell.path", () => {
	const text = shellNoticeText({
		status: "missing",
		reason: "invalid_config",
		detail: 'shell.path "D:\\x" is invalid: the file does not exist.',
	});
	expect(text).toContain('shell.path "D:\\x" is invalid');
	expect(text).toContain("Fix shell.path");
});

it("warns once for the same missing state, including after a reconnect", () => {
	const shown: string[] = [];
	const notify = createShellNotifier((text) => shown.push(text));
	notify(missing);
	notify(missing);
	expect(shown).toHaveLength(1);
});

it("stays quiet when ready and warns again only after a ready state in between", () => {
	const shown: string[] = [];
	const notify = createShellNotifier((text) => shown.push(text));
	notify(ready);
	expect(shown).toHaveLength(0);
	notify(missing);
	notify(ready);
	notify(missing);
	expect(shown).toHaveLength(2);
});

it("never warns without the field (macOS gateway or an older gateway)", () => {
	const shown: string[] = [];
	const notify = createShellNotifier((text) => shown.push(text));
	notify(undefined);
	expect(shown).toEqual([]);
});
