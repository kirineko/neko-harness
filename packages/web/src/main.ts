// neko web 入口：node --conditions=neko-source packages/web/src/main.ts [选项]
// 静态 HTTP（默认 8322）+ 确保 neko gateway 运行（不在则 spawn，默认 WS 8321）。

import type { NekoModelRef } from "@neko-harness/core";
import { installShutdown } from "@neko-harness/gateway";
import { openBrowser } from "./open-browser.ts";
import { type NekoWebServer, startWebServer } from "./server.ts";

const USAGE = `用法: neko web [选项]

选项:
  --port <n>           静态 HTTP 端口（默认 8322）
  --host <ip>          静态 HTTP 地址（默认 127.0.0.1）
  --gateway-port <n>   网关 WebSocket 端口（默认 8321）
  --socket-path <path> 网关 Unix socket 路径（默认 <数据目录>/<serverId>.sock；仅 POSIX）
  --server-id <id>     网关逻辑身份（默认读取/生成 <数据目录>/gateway-server-id）
  --storage <path>     SQLite 存储文件（默认 ~/.neko/neko.sqlite）
  --cwd <dir>          会话工具的工作目录（默认当前目录）
  --model <ref>        模型，格式 provider/modelId（modelId 可含 /，默认 deepseek/deepseek-flash）
  --no-open            不自动打开浏览器（适用于远程或无桌面环境）
  -h, --help           显示此帮助

可在 Web 设置页「模型服务」启用 provider（如 OpenRouter、OpenCode Go）并配置 Key，联网搜索在「联网搜索」页设置；
模型选择器中可把可选模型「设为默认」，优先级低于 --model、高于配置文件 defaultModel；
网关子进程也会继承 DEEPSEEK_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY 等环境变量。`;

type CliOptions = {
	open: boolean;
	port?: number;
	host?: string;
	gatewayPort?: number;
	socketPath?: string;
	serverId?: string;
	storagePath?: string;
	cwd?: string;
	model?: NekoModelRef;
};

function parseArgs(argv: readonly string[]): CliOptions {
	let open = true;
	let port: number | undefined;
	let host: string | undefined;
	let gatewayPort: number | undefined;
	let socketPath: string | undefined;
	let serverId: string | undefined;
	let storagePath: string | undefined;
	let cwd: string | undefined;
	let model: NekoModelRef | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		switch (arg) {
			case "--no-open":
				open = false;
				break;
			case "--port": {
				if (next === undefined) throw new Error("--port 需要参数");
				port = Number(next);
				if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port 非法: ${next}`);
				i++;
				break;
			}
			case "--host":
				if (next === undefined) throw new Error("--host 需要参数");
				host = next;
				i++;
				break;
			case "--gateway-port": {
				if (next === undefined) throw new Error("--gateway-port 需要参数");
				gatewayPort = Number(next);
				if (!Number.isInteger(gatewayPort) || gatewayPort < 0 || gatewayPort > 65535) {
					throw new Error(`--gateway-port 非法: ${next}`);
				}
				i++;
				break;
			}
			case "--socket-path":
				if (next === undefined) throw new Error("--socket-path 需要参数");
				socketPath = next;
				i++;
				break;
			case "--server-id":
				if (next === undefined) throw new Error("--server-id 需要参数");
				serverId = next;
				i++;
				break;
			case "--storage":
				if (next === undefined) throw new Error("--storage 需要参数");
				storagePath = next;
				i++;
				break;
			case "--cwd":
				if (next === undefined) throw new Error("--cwd 需要参数");
				cwd = next;
				i++;
				break;
			case "--model": {
				if (next === undefined) throw new Error("--model 需要参数");
				const separator = next.indexOf("/");
				if (separator <= 0 || separator === next.length - 1) {
					throw new Error(`--model 格式应为 provider/modelId，收到: ${next}`);
				}
				model = { provider: next.slice(0, separator), modelId: next.slice(separator + 1) };
				i++;
				break;
			}
			case "-h":
			case "--help":
				console.log(USAGE);
				process.exit(0);
				break;
			default:
				throw new Error(`未知参数: ${arg ?? ""}`);
		}
	}
	return {
		open,
		...(port !== undefined ? { port } : {}),
		...(host !== undefined ? { host } : {}),
		...(gatewayPort !== undefined ? { gatewayPort } : {}),
		...(socketPath !== undefined ? { socketPath } : {}),
		...(serverId !== undefined ? { serverId } : {}),
		...(storagePath !== undefined ? { storagePath } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		...(model !== undefined ? { model } : {}),
	};
}

let server: NekoWebServer | undefined;
const shutdown = installShutdown({
	log: (message) => console.log(message),
	exit: (code) => {
		// 强制退出时不留下自己拉起的 gateway。
		server?.gateway.spawned?.kill("SIGKILL");
		process.exit(code);
	},
});

try {
	const options = parseArgs(process.argv.slice(2));
	server = await startWebServer({
		signal: shutdown.signal,
		...(options.port !== undefined ? { port: options.port } : {}),
		...(options.host !== undefined ? { host: options.host } : {}),
		gateway: {
			...(options.gatewayPort !== undefined ? { port: options.gatewayPort } : {}),
			...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
			...(options.serverId !== undefined ? { serverId: options.serverId } : {}),
			...(options.storagePath !== undefined ? { storagePath: options.storagePath } : {}),
			...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options.model !== undefined ? { model: options.model } : {}),
			onLog: (line) => console.log(`[gateway] ${line}`),
		},
	});
	const running = server;
	shutdown.setCleanup(() => running.close());
	console.log(`[web] neko web 已启动: ${running.url}`);
	console.log(`[web]   gateway: ${running.gateway.wsUrl}（serverId: ${running.gateway.serverId}）`);
	console.log("[web] 按 Ctrl+C 停止。");
	if (options.open) {
		void openBrowser(running.url).catch(() => {
			console.warn(`无法自动打开浏览器，请手动访问: ${running.url}`);
		});
	}
} catch (error) {
	if (shutdown.signal.aborted) {
		// 启动阶段被 Ctrl+C 打断：已拉起的 gateway 在启动流程内被终止，直接退出。
		process.exit(0);
	}
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
	shutdown.dispose();
}
