/**
 * 终止信号的统一处理：首个信号触发一次幂等的有界清理，再次收到信号立即强退。
 * 终端 Ctrl+C 会把信号同时发给前台进程组（web 与其拉起的 gateway），因此任何一端都不能依赖另一端的行为。
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export type ShutdownProcess = {
	on(signal: NodeJS.Signals, listener: () => void): unknown;
	off(signal: NodeJS.Signals, listener: () => void): unknown;
	readonly platform: NodeJS.Platform;
};

export type ShutdownOptions = {
	/** 清理总时限；超时以退出码 1 强制退出。 */
	readonly timeoutMs?: number;
	readonly log?: (message: string) => void;
	readonly exit?: (code: number) => void;
	readonly process?: ShutdownProcess;
};

export type ShutdownController = {
	/** 首个终止信号到来时中止；启动阶段用它打断等待。 */
	readonly signal: AbortSignal;
	/** 设置清理函数；若信号已到达则立即执行。 */
	setCleanup(cleanup: () => Promise<void>): void;
	/** 以非信号来源（如 stdin 关闭）触发关停，流程与终止信号一致：首次清理，重复触发强退。 */
	trigger(reason: string): void;
	/** 取消监听（测试或正常结束时使用）。 */
	dispose(): void;
};

function shutdownSignals(platform: NodeJS.Platform): NodeJS.Signals[] {
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	if (platform === "win32") signals.push("SIGBREAK");
	return signals;
}

export function installShutdown(options: ShutdownOptions = {}): ShutdownController {
	const proc: ShutdownProcess = options.process ?? process;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	const controller = new AbortController();
	let cleanup: (() => Promise<void>) | undefined;
	let cleaning = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const runCleanup = (): void => {
		if (cleaning || cleanup === undefined) return;
		cleaning = true;
		cleanup().then(
			() => exit(0),
			(error: unknown) => {
				options.log?.(error instanceof Error ? error.message : String(error));
				exit(1);
			},
		);
	};

	const begin = (reason: string | undefined): void => {
		if (controller.signal.aborted) {
			options.log?.("再次收到终止信号，强制退出。");
			exit(130);
			return;
		}
		options.log?.(reason === undefined ? "\n正在关闭…" : `\n正在关闭（${reason}）…`);
		controller.abort();
		timer = setTimeout(() => {
			options.log?.("关闭超时，强制退出。");
			exit(1);
		}, timeoutMs);
		timer.unref?.();
		runCleanup();
	};
	const onSignal = (): void => begin(undefined);

	const installed: NodeJS.Signals[] = [];
	for (const signal of shutdownSignals(proc.platform)) {
		try {
			proc.on(signal, onSignal);
			installed.push(signal);
		} catch {
			// 个别平台不支持某些信号，跳过即可。
		}
	}

	return {
		signal: controller.signal,
		setCleanup(next) {
			cleanup = next;
			if (controller.signal.aborted) runCleanup();
		},
		trigger(reason) {
			begin(reason);
		},
		dispose() {
			clearTimeout(timer);
			for (const signal of installed) proc.off(signal, onSignal);
		},
	};
}
