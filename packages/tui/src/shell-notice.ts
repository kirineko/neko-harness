import { t } from "./i18n/index.ts";

/** The Windows command shell status as the gateway publishes it (`neko.application-info`); absent elsewhere. */
export type ShellStatus =
	| { readonly status: "ready"; readonly path: string }
	| {
			readonly status: "missing";
			readonly reason: "not_found" | "invalid_config";
			readonly detail?: string | undefined;
	  };

export function shellNoticeText(shell: ShellStatus): string | undefined {
	if (shell.status !== "missing") return undefined;
	if (shell.reason === "invalid_config")
		return t("shell.invalidConfig", { detail: shell.detail ?? t("shell.invalidDefault") });
	return t("shell.notFound");
}

/**
 * Warns once per distinct missing state. A ready state resets the memory, so a later loss warns again, while a
 * reconnect that reports the same missing state stays quiet. A gateway without the field never warns.
 */
export function createShellNotifier(show: (text: string) => void): (shell: ShellStatus | undefined) => void {
	let last: string | undefined;
	return (shell) => {
		if (shell === undefined) return;
		const text = shellNoticeText(shell);
		if (text === undefined) {
			last = undefined;
			return;
		}
		if (text === last) return;
		last = text;
		show(text);
	};
}
