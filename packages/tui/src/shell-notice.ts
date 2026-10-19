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
		return `${shell.detail ?? "shell.path is invalid."} Bash and background jobs are unavailable. Fix shell.path in neko.config.json.`;
	return "Git Bash not found: bash and background jobs are unavailable. Install Git for Windows (https://git-scm.com/download/win) or set shell.path in neko.config.json.";
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
