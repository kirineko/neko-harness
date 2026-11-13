import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";

/** Starts `cmd` with piped output; `stdout` / `stderr` resolve to the full text and `exited` to the exit code. */
export function spawnProcess(cmd: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const child = spawn(cmd[0]!, cmd.slice(1), { ...options, stdio: ["ignore", "pipe", "pipe"] });
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? -1));
	});
	return {
		pid: child.pid,
		stdout: text(child.stdout),
		stderr: text(child.stderr),
		exited,
		kill: (signal?: NodeJS.Signals) => child.kill(signal),
	};
}
