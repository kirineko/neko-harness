# cli-interface Specification

## Purpose

定义 neko CLI 用户可见文本的统一约定：根命令与各子命令的帮助输出（语言、结构、术语），以及 `neko web` 启动日志的行前缀与字段格式，保证用户在任何入口看到的口径一致。

## Requirements

### Requirement: 帮助输出语言与术语统一

根命令与全部子命令的帮助输出 SHALL 默认使用中文，网关组件的术语 SHALL 统一为「网关」，用法行中的占位符（如 `[选项]`、`<路径>`）SHALL 使用中文。例外：`neko tui --help` SHALL 随界面语言（`--lang`、`NEKO_LANG`、保存值，见 `ui-language`）输出，`en` 时整段使用英文并以 `Usage: neko tui [options]`、`Options:` 与 `-h, --help Show this help` 对应结构；其他命令的帮助保持中文。

#### Scenario: 各入口语言一致

- **WHEN** 用户在默认语言下分别运行 `neko --help`、`neko tui --help`、`neko web --help`、`neko serve --help`、`neko update --help`
- **THEN** 输出均为中文，且网关组件均称「网关」，无中英文混排（协议名、文件名、环境变量名等专有标识除外）

#### Scenario: TUI 帮助随语言

- **WHEN** 用户运行 `neko tui --lang en --help` 或设置 `NEKO_LANG=en` 后运行 `neko tui --help`
- **THEN** 输出为英文，`--theme`、`--lang`、`NEKO_THEME`、`NEKO_LANG` 等标识原样，说明文字为英文；此时 `neko web --help` 仍为中文

### Requirement: 帮助输出结构统一

每个命令的帮助输出 SHALL 以 `用法: neko <命令> [选项]`（无选项时可省略 `[选项]`）开头，选项列于 `选项:` 段、两空格缩进且描述列对齐，并以 `-h, --help 显示此帮助` 作为选项段收尾；根命令 SHALL 额外列出全部子命令与 `-v, --version`。`neko tui` 在英文语言下 SHALL 使用等价结构（`Usage:`、`Options:`、`-h, --help Show this help`），`neko tui --help` 的选项段 SHALL 列出 `--lang <zh|en>` 并在尾部补充说明 `NEKO_LANG` 与「`--lang` 与 `NEKO_LANG` 只影响当次，`/language` 保存默认」。

#### Scenario: 子命令用法行显示真实命令名

- **WHEN** 用户运行 `neko web --help` 或 `neko serve --help`
- **THEN** 用法行分别为 `用法: neko web [选项]` 与 `用法: neko serve [选项]`，不出现 `main.ts`

#### Scenario: 根命令帮助列出全部入口

- **WHEN** 用户运行 `neko --help` 或不带参数运行 `neko`
- **THEN** 输出按 tui、web、serve、update 顺序列出子命令，并包含 `-v, --version` 说明

#### Scenario: TUI 帮助说明语言参数

- **WHEN** 用户运行 `neko tui --help`
- **THEN** 选项段列出 `--lang <zh|en>`，尾部说明 `NEKO_LANG`，以及 `--lang` 与 `NEKO_LANG` 只影响当次、`/language` 保存默认

### Requirement: 帮助输出覆盖环境变量与凭据配置

涉及环境变量或凭据的命令帮助 SHALL 在尾部补充段说明：`neko tui --help` SHALL 说明 `NEKO_THEME`；配置凭据的入口（TUI `/login`、Web 设置页「模型服务」与「联网搜索」、各 provider 的环境变量如 `DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、`OPENCODE_API_KEY`、`TAVILY_API_KEY`）SHALL 在相应帮助中说明，并说明除 DeepSeek 外的 provider 需先在 `/login` 或 Web 设置页启用；选择联网搜索 provider 的入口（TUI `/search`、Web 设置页「联网搜索」、配置文件 `webSearch.provider`）SHALL 在涉及凭据配置的帮助中一并说明。`--model` 帮助 SHALL 说明格式为 `provider/modelId`（模型 id 可含 `/`），并说明默认模型还可在 TUI `/model` 或 Web 模型选择器中「设为默认」，其优先级低于 `--model`、高于配置文件 `defaultModel`。

#### Scenario: tui 帮助说明主题环境变量

- **WHEN** 用户运行 `neko tui --help`
- **THEN** 输出说明 `--theme` 覆盖 `NEKO_THEME`，并提示可用 `/login` 或 `DEEPSEEK_API_KEY` 配置凭据

#### Scenario: 帮助说明搜索 provider

- **WHEN** 用户运行 `neko --help` 或 `neko tui --help`
- **THEN** 输出提示可用 `/search`（TUI）或 Web 设置页「联网搜索」选择联网搜索 provider（默认 tavily），并说明凭据变量

#### Scenario: 帮助说明多 provider

- **WHEN** 用户运行 `neko --help`、`neko tui --help` 或 `neko web --help`
- **THEN** 输出说明可通过 `/login` 或 Web 设置页启用其他 provider（如 OpenRouter、OpenCode Go）并配置对应环境变量，且 `--model` 采用 `provider/modelId` 格式

#### Scenario: 帮助说明默认模型设置

- **WHEN** 用户运行 `neko --help`、`neko tui --help` 或 `neko web --help`
- **THEN** 输出说明可在 TUI `/model` 或 Web 模型选择器把可选模型「设为默认」，且其优先级低于 `--model`、高于配置文件 `defaultModel`

### Requirement: web 启动日志前缀统一

`neko web` 启动日志中，web 自身的输出 SHALL 带 `[web]` 前缀，网关子进程透传的输出 SHALL 带 `[gateway]` 前缀，两者均无额外前导空格；`[gateway]` 行保留子进程原始内容。

#### Scenario: 启动日志两类前缀对齐

- **WHEN** 用户运行 `neko web` 且网关被拉起
- **THEN** 网关行以 `[gateway] ` 开头、web 行以 `[web] ` 开头，前缀列对齐，无行首空格

### Requirement: web 启动日志字段

web 自身启动日志 SHALL 包含：启动行 `neko web 已启动: <url>`、网关行 `gateway: <wsUrl>（serverId: <id>）`、退出提示 `按 Ctrl+C 停止。`；SHALL NOT 打印模型行。

#### Scenario: 启动日志无模型行

- **WHEN** `neko web` 启动完成
- **THEN** 输出不含「模型」行，网关地址以 `gateway:` 标签展示

### Requirement: 退出提示文案统一

gateway 与 web 的启动日志中，退出提示 SHALL 统一为 `按 Ctrl+C 停止。`。

#### Scenario: serve 与 web 提示一致

- **WHEN** 用户分别运行 `neko serve` 与 `neko web`
- **THEN** 两者的退出提示均为 `按 Ctrl+C 停止。`（web 中该行由 `[gateway]` / `[web]` 前缀引出）

### Requirement: web 退出可靠性

`neko web` 收到终止信号（SIGINT、SIGTERM，Windows 另含 SIGBREAK、SIGHUP）后 SHALL 在有界时间内完整退出：停止接受新连接并断开所有现有 HTTP 连接，关停自己拉起的 gateway，随后结束进程并释放静态端口。关闭流程 MUST 幂等；超过总时限仍未完成时 SHALL 强制终止子进程并退出；再次收到终止信号 SHALL 立即强制退出。启动尚未完成时收到信号也 MUST NOT 遗留 gateway 子进程。

#### Scenario: 存在未完成请求时退出
- **WHEN** 浏览器仍有进行中或空闲保持的 HTTP 连接（含手机配对状态查询），用户按 Ctrl+C
- **THEN** 连接被断开，web 与其拉起的 gateway 均退出，静态端口立即可被下次启动使用

#### Scenario: Windows 与 WSL 终端
- **WHEN** 用户在 Windows 或 WSL 终端中对 `neko web` 按 Ctrl+C（gateway 子进程可能同时收到同一信号）
- **THEN** 不出现只有 gateway 退出、web 进程残留并占用端口的情况

#### Scenario: 关闭挂起
- **WHEN** 关闭流程因对端无响应超过总时限，或用户再次按 Ctrl+C
- **THEN** 进程强制结束子进程并退出，不无限等待

#### Scenario: 复用已有 gateway
- **WHEN** web 复用的是其他前端拉起的 gateway 并收到 Ctrl+C
- **THEN** web 自身退出并释放端口，不终止已有 gateway

### Requirement: 配对管理代理调用有界

web 对 gateway 的手机配对管理代理调用 SHALL 有超时上限；超时或 gateway 不可达时 MUST 向浏览器返回明确错误并释放相关连接，不得使 HTTP 请求或退出流程无限挂起。

#### Scenario: gateway 无响应
- **WHEN** gateway 正在退出或无响应时浏览器请求手机配对状态
- **THEN** 请求在上限时间内以错误结束，页面显示不可用提示，web 的退出流程不受该请求阻塞
