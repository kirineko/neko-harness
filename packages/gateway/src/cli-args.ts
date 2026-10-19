import type { NekoModelRef } from "@neko-harness/core";

export const GATEWAY_USAGE = `用法: neko serve [选项]

选项:
  --host <ip>          WebSocket 监听地址（默认 127.0.0.1，仅本机）
  --port <n>           WebSocket 监听端口（默认 8321，Windows 默认随机；0/null 禁用 WS）
  --socket-path <path> Unix socket 路径（默认 <数据目录>/<serverId>.sock；Windows 默认禁用）
  --no-socket          禁用 Unix socket 传输（仅 WebSocket）
  --server-id <id>     逻辑服务器身份（默认读取/生成 <数据目录>/gateway-server-id）
  --cwd <dir>          会话工具的工作目录（默认当前目录）
  --model <ref>        模型，格式 provider/modelId（modelId 可含 /，默认 deepseek/deepseek-flash）
  --storage <path>     SQLite 存储文件（默认 ~/.neko/neko.sqlite）
  --credentials <path> 用户凭据文件（默认 ~/.neko/credentials.json）
  --config <dir>       neko.config.json 查找起始目录（默认当前目录）
  --stop-on-stdin      标准输入结束时关停网关（供 Windows 上拉起网关的前端使用）
  -h, --help           显示此帮助

可通过前端设置或环境变量（DEEPSEEK_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY / TAVILY_API_KEY 等）配置凭据；
除 DeepSeek 外的模型 provider 需先在前端启用，--model 指向未启用的 provider 时提交会被拒绝；
联网搜索服务可在前端设置，或用配置文件 webSearch.provider（tavily / deepseek，默认 tavily）；
默认模型还可在 TUI /model 或 Web 模型选择器中「设为默认」，优先级低于 --model、高于配置文件 defaultModel。`;

export type GatewayCliOptions = {
	host?: string;
	port?: number | null;
	socketPath?: string | null;
	serverId?: string;
	cwd?: string;
	model?: NekoModelRef;
	storagePath?: string;
	credentialsPath?: string;
	configDir?: string;
	stopOnStdin?: boolean;
};

/** 解析 gateway CLI 参数；`--help` 由调用方处理（main.ts 打印 GATEWAY_USAGE）。 */
export function parseGatewayArgs(argv: readonly string[]): GatewayCliOptions {
	let port: number | null | undefined;
	const options: GatewayCliOptions = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		switch (arg) {
			case "--host":
				if (next === undefined) throw new Error("--host 需要参数");
				options.host = next;
				i++;
				break;
			case "--port": {
				if (next === undefined) throw new Error("--port 需要参数");
				// 0/null = 禁用 WS 传输（注意与 startGateway API 的 port: 0 = 随机端口不同）。
				if (next === "0" || next === "null") {
					port = null;
				} else {
					const parsed = Number(next);
					if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
						throw new Error(`--port 需要 0-65535 的整数: ${next}`);
					}
					port = parsed;
				}
				i++;
				break;
			}
			case "--socket-path":
				if (next === undefined) throw new Error("--socket-path 需要参数");
				options.socketPath = next;
				i++;
				break;
			case "--no-socket":
				options.socketPath = null;
				break;
			case "--server-id":
				if (next === undefined) throw new Error("--server-id 需要参数");
				options.serverId = next;
				i++;
				break;
			case "--cwd":
				if (next === undefined) throw new Error("--cwd 需要参数");
				options.cwd = next;
				i++;
				break;
			case "--model": {
				if (next === undefined) throw new Error("--model 需要参数");
				const slash = next.indexOf("/");
				if (slash <= 0 || slash === next.length - 1) throw new Error(`--model 格式为 provider/modelId: ${next}`);
				options.model = { provider: next.slice(0, slash), modelId: next.slice(slash + 1) };
				i++;
				break;
			}
			case "--credentials":
				if (next === undefined) throw new Error("--credentials 需要参数");
				options.credentialsPath = next;
				i++;
				break;
			case "--storage":
				if (next === undefined) throw new Error("--storage 需要参数");
				options.storagePath = next;
				i++;
				break;
			case "--config":
				if (next === undefined) throw new Error("--config 需要参数");
				options.configDir = next;
				i++;
				break;
			case "--stop-on-stdin":
				options.stopOnStdin = true;
				break;
			default:
				throw new Error(`未知选项: ${arg}`);
		}
	}
	if (port !== undefined) options.port = port;
	return options;
}
