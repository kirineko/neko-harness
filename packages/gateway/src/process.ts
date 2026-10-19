import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Match this package's source/compiled entry without relying on a development loader. */
export function gatewayCommand(args: readonly string[]): { binary: string; args: string[] } {
	const source = import.meta.url.endsWith(".ts");
	return {
		binary: process.execPath,
		args: [
			...(source ? ["--conditions=neko-source"] : []),
			fileURLToPath(
				new URL(
					process.env.NEKO_RELEASE_BUILD === "1" ? "./gateway.js" : source ? "./main.ts" : "./main.js",
					import.meta.url,
				),
			),
			...args,
		],
	};
}

const GRACEFUL_STOP_MS = 3_000;
const FORCED_STOP_MS = 2_000;

/**
 * Wait for an owned child to exit, escalating to SIGKILL if graceful shutdown stalls.
 * With `viaStdin` the graceful step closes the child's stdin (the gateway's `--stop-on-stdin`) instead of signalling,
 * and escalation is a plain kill() (forced termination on Windows). A child without a stdin pipe falls back to signals.
 * Never waits unboundedly: a child that ignores SIGKILL is abandoned after a short grace.
 */
export async function stopGatewayProcess(
	child: ChildProcess,
	options: { readonly gracefulMs?: number; readonly forcedMs?: number; readonly viaStdin?: boolean } = {},
): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const viaStdin = options.viaStdin === true && child.stdin != null;
	await new Promise<void>((resolve) => {
		let forcedTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			child.kill(viaStdin ? undefined : "SIGKILL");
			forcedTimer = setTimeout(resolve, options.forcedMs ?? FORCED_STOP_MS);
		}, options.gracefulMs ?? GRACEFUL_STOP_MS);
		// 先注册 exit 监听再发信号：子进程可能已因同一终端信号在退出途中。
		child.once("exit", () => {
			clearTimeout(timer);
			clearTimeout(forcedTimer);
			resolve();
		});
		if (viaStdin) child.stdin?.end();
		else child.kill("SIGTERM");
	});
}
