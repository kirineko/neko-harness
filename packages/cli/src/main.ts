import { RUNNING_VERSION } from "@neko-harness/core/application-version";

const USAGE = `用法: neko <命令> [选项]

命令:
  tui     启动终端交互界面（自动拉起网关）
  web     启动 Web UI 静态托管（自动拉起网关）
  serve   仅启动网关（WebSocket；POSIX 另有 Unix socket）
  update  升级当前 npm 全局安装（Windows 显示手动升级命令）

选项:
  -v, --version  显示版本号
  -h, --help     显示此帮助

各命令的选项详见 neko <命令> --help。
可通过 TUI /login、Web 设置页或环境变量（DEEPSEEK_API_KEY / OPENROUTER_API_KEY / OPENCODE_API_KEY / TAVILY_API_KEY 等）配置凭据；
除 DeepSeek 外的模型 provider（如 OpenRouter、OpenCode Go）需先在 /login 或 Web 设置页「模型服务」启用，--model 格式为 provider/modelId。
联网搜索服务（默认 Tavily，可改选 DeepSeek）可用 TUI /search、Web 设置页「联网搜索」或配置文件 webSearch.provider 选择。
默认模型可在 TUI /model 或 Web 模型选择器「设为默认」，优先级低于 --model、高于配置文件 defaultModel。`;

const [command, ...rest] = process.argv.slice(2);

switch (command) {
	case "update": {
		if (rest.length) {
			if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h"))
				console.log(
					"用法: neko update\n\n升级当前 npm 全局安装；完成后重新启动 neko。\nWindows：先退出 neko，再运行 npm install -g neko-harness@latest。\n\n选项:\n  -h, --help  显示此帮助",
				);
			else {
				console.error("用法: neko update");
				process.exitCode = 1;
			}
			break;
		}
		try {
			const { updateCommand } = await import("./update.ts");
			console.log(await updateCommand({ runningVersion: RUNNING_VERSION }));
		} catch (error) {
			console.error(error instanceof Error ? error.message : "升级失败，请重试 neko update。");
			process.exitCode = 1;
		}
		break;
	}
	case "tui":
	case "web":
	case "serve": {
		// 子命令的 main 自行解析 process.argv.slice(2)，剥离子命令名后透传
		process.argv = [process.argv[0] ?? "node", process.argv[1] ?? "neko", ...rest];
		if (command === "tui") await import("@neko-harness/tui/cli");
		else if (command === "web") await import("@neko-harness/web/cli");
		else await import("@neko-harness/gateway/cli");
		break;
	}
	case "--version":
	case "-v":
		console.log(RUNNING_VERSION);
		break;
	case undefined:
	case "-h":
	case "--help":
		console.log(USAGE);
		break;
	default:
		console.error(`未知命令: ${command}\n\n${USAGE}`);
		process.exitCode = 1;
}
