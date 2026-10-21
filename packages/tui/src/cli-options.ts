import { resolveDataDir } from "./gateway.ts";
import type { Language } from "./i18n/index.ts";
import { parseLanguageEnv, parseLanguageFlag, readSavedLanguage, resolveLanguage } from "./language-settings.ts";
import type { ThemePreference } from "./theme/index.ts";

const USAGE_ZH = `用法: neko tui [选项]

选项:
  --cwd <dir>          工作目录（默认启动目录；非访问沙箱）
  --model <ref>        模型，格式 provider/modelId（用于拉起的网关）
  --storage <path>     SQLite 存储文件（默认 ~/.neko/neko.sqlite）
  --socket-path <path> 网关 Unix socket 路径（仅 POSIX；Windows 经端口文件发现 ws 地址）
  --theme <mode>       主题 light / dark / auto（覆盖 NEKO_THEME）
  --lang <zh|en>       界面语言 zh / en（覆盖 NEKO_LANG，仅影响当次）
  -h, --help           显示此帮助

恢复当前工作目录最近使用的会话，不存在则创建。
按需拉起网关，属主 TUI 退出时随之停止。
可用 /login 或 DEEPSEEK_API_KEY 等环境变量配置凭据（除 DeepSeek 外的 provider 需先在 /login 启用）；/search 选择联网搜索服务（tavily / deepseek，默认 tavily）；/context 调整上下文压缩与工具结果裁剪；/model 中可把可选模型「设为默认」，优先级低于 --model、高于配置文件 defaultModel。
界面语言默认 zh：优先级为 --lang > 环境变量 NEKO_LANG > 已保存的语言 > zh；--lang 与 NEKO_LANG 只影响当次，在 TUI 中用 /language 切换并保存默认语言。`;

const USAGE_EN = `Usage: neko tui [options]

Options:
  --cwd <dir>          Working directory (default: the launch directory; not an access sandbox)
  --model <ref>        Model as provider/modelId (for the gateway that is started)
  --storage <path>     SQLite storage file (default ~/.neko/neko.sqlite)
  --socket-path <path> Gateway Unix socket path (POSIX only; Windows finds the ws address through the port file)
  --theme <mode>       Theme: light / dark / auto (overrides NEKO_THEME)
  --lang <zh|en>       Interface language: zh / en (overrides NEKO_LANG, this run only)
  -h, --help           Show this help

Resumes the most recent session of the working directory, or creates one.
Starts the gateway on demand and stops it when the owning TUI exits.
Configure credentials with /login or environment variables such as DEEPSEEK_API_KEY (providers other than DeepSeek must be enabled in /login first); /search chooses the web search provider (tavily / deepseek, default tavily); /context tunes context compaction and tool result pruning; in /model an available model can be set as the default, with lower priority than --model and higher than defaultModel in the config file.
The interface language defaults to zh: --lang > NEKO_LANG > the saved language > zh. --lang and NEKO_LANG only affect this run; use /language in the TUI to switch and save the default language.`;

export const usage = (language: Language): string => (language === "en" ? USAGE_EN : USAGE_ZH);

export type CliOptions = {
	cwd?: string;
	model?: { provider: string; modelId: string };
	storagePath?: string;
	socketPath?: string;
	theme?: ThemePreference;
	language: Language;
	dataDir?: string;
	help: boolean;
};

function parseTheme(value: string): ThemePreference {
	if (value === "light" || value === "dark" || value === "auto") return value;
	throw new Error(`--theme must be light / dark / auto; received: ${value}`);
}

/** Parses `neko tui` arguments. `--help` is only recorded so the help text can follow `--lang` wherever it appears. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
	let cwd: string | undefined;
	let model: { provider: string; modelId: string } | undefined;
	let storagePath: string | undefined;
	let socketPath: string | undefined;
	let theme: ThemePreference | undefined;
	let lang: Language | undefined;
	let help = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		switch (arg) {
			case "--cwd":
				if (next === undefined) throw new Error("--cwd requires a value");
				cwd = next;
				i++;
				break;
			case "--model": {
				if (next === undefined) throw new Error("--model requires a value");
				const separator = next.indexOf("/");
				if (separator <= 0 || separator === next.length - 1) {
					throw new Error(`--model must be provider/modelId; received: ${next}`);
				}
				model = { provider: next.slice(0, separator), modelId: next.slice(separator + 1) };
				i++;
				break;
			}
			case "--storage":
				if (next === undefined) throw new Error("--storage requires a value");
				storagePath = next;
				i++;
				break;
			case "--socket-path":
				if (next === undefined) throw new Error("--socket-path requires a value");
				socketPath = next;
				i++;
				break;
			case "--theme":
				if (next === undefined) throw new Error("--theme requires a value");
				theme = parseTheme(next);
				i++;
				break;
			case "--lang":
				if (next === undefined) throw new Error("--lang requires a value");
				lang = parseLanguageFlag(next);
				i++;
				break;
			case "-h":
			case "--help":
				help = true;
				break;
			default:
				if (!help) throw new Error(`Unknown option: ${arg ?? ""}`);
		}
	}
	// --theme 优先，其次环境变量 NEKO_THEME，默认 auto。
	if (!help) theme ??= env.NEKO_THEME === undefined ? undefined : parseTheme(env.NEKO_THEME);
	let dataDir: string | undefined;
	try {
		dataDir = resolveDataDir({
			...(storagePath !== undefined ? { storagePath } : {}),
			...(cwd !== undefined ? { configDir: cwd } : {}),
		});
	} catch {
		// 配置文件无法读取时由后续启动流程报错；这里只是拿不到已保存的语言。
	}
	const language = resolveLanguage({
		flag: lang,
		env: parseLanguageEnv(env.NEKO_LANG),
		saved: dataDir === undefined ? undefined : readSavedLanguage(dataDir),
	});
	return {
		...(cwd !== undefined ? { cwd } : {}),
		...(model !== undefined ? { model } : {}),
		...(storagePath !== undefined ? { storagePath } : {}),
		...(socketPath !== undefined ? { socketPath } : {}),
		...(theme !== undefined ? { theme } : {}),
		...(dataDir !== undefined ? { dataDir } : {}),
		language,
		help,
	};
}
