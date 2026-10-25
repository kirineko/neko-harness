# Proposal

## Why

模型现在每次只能发一个工具调用，所有中间结果都要回到上下文里。批量读取、链式查询、过滤大段输出都很费轮次和 token。Pi 1.4.0 的 `pi-durable` 已经自带持久化的 codemode 扩展（`@earendil-works/pi-durable/codemode`）：模型写一段 JavaScript，在 QuickJS 沙箱里用 `await tools.<name>(args)` 调用会话工具，只有脚本的输出回到上下文，进程重启后脚本还能按日志重放并继续执行。neko 已锁定这个版本，现在可以按 Pi 的模式接入，不必自己写代码执行环境。

## What Changes

- 新增 codemode，模式为 `off` / `on` / `only`，与 Pi coding-agent 的语义一致。出厂默认 `off`。
  - `on`：在原有工具之外再提供 `codemode` 工具。
  - `only`：模型只看到 `codemode` 和只限主 agent 的工具（`todo`、`ask_user`，plan 模式下再加 `submit_plan`），其余工具只能在脚本里调用。
- core 安装 pi-durable 的 codemode 扩展，沙箱用 pi-codemode 的 `CodemodeSandbox`，并按 coding-agent 的做法限制全进程同时存在的沙箱 worker 数。系统提示词直接使用扩展自带的 `codemode` 段，不另写，也不裁剪。
- 脚本里的嵌套调用照常走工具钩子：plan 模式的只读保护和 explore 子 agent 的 bash 审批同样生效。`subagent` 工具改为只允许模型直接调用，脚本不能派发子 agent。脚本中的 `models.*`（分类器和图片生成）关闭，因为它们会绕过 provider 启用与 Key 门禁。
- 全局设置：配置文件新增 `codemode.mode`，UI 可保存覆盖，优先级为 UI 保存值 > 配置文件 > 默认 `off`。设置只影响新建会话：每个会话在创建时记录当时的模式，之后不再跟随全局变化。子 agent 继承主会话记录的模式。
- 会话的工具配置由「plan 模式 × codemode 模式」统一计算，plan 模式不再单独写 `modelTools`。启动对账和受理输入前都按这两条持久记录检查，不一致时重新应用。
- 网关新增服务器级 codemode 设置服务（订阅、设置、恢复默认），应用协议从 9 升到 10，沿用既有规则：协议版本不同即拒绝连接，不提供回退。
- Web 设置页和 TUI 命令可以查看、修改 codemode 设置。Web、TUI、移动端和会话导出都会把 codemode 调用渲染为专用卡片：脚本代码、嵌套调用列表（运行中与结束后）以及完整输出文件路径。
- 「本次改动」改为同时统计脚本中成功的 `edit` / `write` 嵌套调用，执行者标注不变。
- `only` 模式下，`rules` 节仍为脚本可调用的工具生成规则，使 edit / bash 等规则继续有效。
- 新增直接依赖 `@earendil-works/pi-codemode`（1.4.0，精确锁版本），它已经是 pi-durable 的传递依赖，发版打包时需要它作为外部依赖保留。

## Capabilities

### New Capabilities

- `codemode`：codemode 模式的取值与解析（全局设置、会话记录、子 agent 继承）、模型可见工具与脚本可调用工具的范围、与 plan 模式的组合（plan 模式自身的要求不变，组合规则由本能力负责）、嵌套调用的保护与限制、沙箱资源上限、重启后的恢复语义。

### Modified Capabilities

- `prompt-context`：`rules` 节在 `only` 模式下改为按「模型可见工具 + 脚本可调用工具」生成规则。
- `session-file-changes`：改动聚合纳入 codemode 脚本发起的成功 `edit` / `write` 嵌套调用。
- `session-gateway`：新增服务器级 codemode 设置服务并递增应用协议版本；会话视图携带 codemode 调用的嵌套调用数据。
- `web-ui`：新增 codemode 设置页与 codemode 工具卡。
- `terminal-ui`：新增 codemode 设置命令与 codemode 工具卡。
- `mobile-api`：工具项新增可选的 codemode 嵌套调用数据，不提高移动 API 版本。
- `mobile-ui`：codemode 工具卡（只读展示）。
- `conversation-export`：导出中 codemode 调用的呈现。

## Impact

- 依赖：根目录 `package.json` 新增 `@earendil-works/pi-codemode: 1.4.0`，`bun.lock` 随之更新；不升级任何 Pi 包。
- Core：`runtime.ts`（安装扩展、创建沙箱、会话创建时记录模式）、新增 codemode 模块（设置解析、会话文档、工具配置计算、worker 上限）、`plan.ts`（改为统一计算工具配置）、`subagents.ts`（继承模式、`subagent` 改为只限模型调用）、`prompt/prompt.ts`（规则来源）、`file-changes.ts`（嵌套调用）、`projection.ts`（嵌套调用投影）、`config.ts`、`conversation-export*.ts`、`core-ui-strings.json`。
- Gateway：`contract.ts` 新增 `neko.codemode-settings`，`server-services.ts`、`client-session.ts`；`APPLICATION_PROTOCOL` 改为 10。
- Web / TUI / 移动端：设置入口（移动端无）、codemode 工具卡、双语 i18n 文案、CJK 扫描白名单（如需）。移动端只改工具卡渲染，不改移动 API 契约版本。
- 存储：新增应用文档（全局保存值、会话记录），pi-durable 自带的 `pi.codemode.*` 文档随扩展使用；无迁移。
- 文档：AGENTS.md（新增 codemode 小节，应用协议改为 10）、README 中的配置说明、发布说明。
- 不在范围内：MCP 与 `tool_search`、`models.*`、程序级沙箱提权审批、Python 运行时、会话中途切换模式、移动端设置入口。不发版，不提交 git commit。
