# Proposal

## Why

目前 agent 拿到需求就直接改文件、跑命令。对大改动，用户只能事后看 diff，无法在动手前审阅并否决方案。需要一个 plan-approve 模式：agent 先在只读环境里调研并提交计划，用户批准后才获得写权限并开始执行。

pi-durable 1.3.0 没有内置 plan-approve 流程，只提供原语：`conversation.configure({ extensions, tools, modelTools })` 切换工具集、`ToolTask.beforeTool` 钩子拦截调用、工具结果 `control.terminate` 结束本轮，以及 `examples/27-plan-mode.ts`（只读规划 + `submit_plan`，没有审批）。pi coding-agent 的 `plan-mode` 示例扩展给出了产品形态（`/plan` 切换、只读 bash 白名单、计划后选择「执行 / 留在计划 / 修改」），但它从助手文本里按 `Plan:` 标题抽取步骤、用正则判定命令，都偏脆弱。neko 需要把审批做成持久、多端一致的结构化流程。

## What Changes

- 新增会话级 **plan 模式**：用户可在 Web / TUI / 移动端进入或退出；模式状态持久，重启后保留。
- plan 模式下工具集收窄为只读：移除 `edit` / `write` / `job`，并用 `beforeTool` 硬拦截（覆盖 codemode 嵌套调用等绕过路径）；`read`、文件搜索、联网搜索、`ask_user`、`todo`、explore 子 agent 仍可用；写文件的子 agent 不可委派。
- plan 模式下 `bash` 只放行**只读命令白名单**，用于调研（`git log/diff/status`、`ls`、`rg`、`cat` 等）。判定沿用 pi `plan-mode/utils.ts` 的正则做法，放在 core 的纯模块 `plan-bash.ts`，返回布尔值 `isSafeCommand(command)`：
  - 命中「危险模式」（`rm` / `mv` / `>` / `git commit` / 包管理安装 / `sudo` / `kill` / 编辑器等）即拒绝。
  - 命令必须匹配「安全模式」（`cat` / `ls` / `rg` / `fd` / `git status|log|diff|show` / `npm ls` 等）才放行。
  - 在 pi 的基础上只补几处低成本收紧：按 `;` `&&` `||` `|` 换行切段，**每一段**都要是安全命令（pi 只检查开头，`ls; node x.js` 会漏）；含 `$(`、反引号、`<(` 直接拒绝；危险模式补 `find -delete|-exec`、`sed -i`、`-o`/`--output`、`curl` 的写入与上传参数（`-o` `-O` `-d` `-X` `-T` `-F` `--data*`）、`awk` 的 `system(`。安全列表保持 pi 的范围（含 `curl`、`wget -O -`、`awk`、`sed -n`），只去掉会卡住终端的交互式命令：`top`、`htop`、`less`、`more`。
  - 被拒绝时把原因回给模型，提示改用 `read` / 搜索工具或 `ask_user`。
  - `beforeTool` 与 `bash` 的执行端各校验一次。这是护栏，不是沙箱，只防合作的模型犯错。
- 新增 `submit_plan` 工具（仅主 agent）：模型提交结构化计划（标题 + 步骤 + 说明），写入带版本的持久计划文档，并以 `control.terminate` 结束本轮，会话进入「待批准」。
- 用户对计划有两种决定，均绑定计划版本，首次有效决定生效：
  - **批准**：自动退出 plan 模式、恢复完整工具集，并提交一条「按已批准的计划执行」的输入，立即开始执行。
  - **要求修改**（带文字反馈）：留在 plan 模式，反馈作为输入提交，模型修订后再次 `submit_plan`。
- 会话停止、归档、重启对账时，未决计划置为 `cancelled`，迟到的决定不能放行任何东西。
- 前端：
  - Web：`/plan` 斜杠命令切换（不加按钮）与输入区模式标识、消息流中的计划卡片（批准 / 要求修改）、会话列表的待批准角标。
  - TUI：`/plan` 命令与快捷键、计划面板（批准 / 反馈 / 取消）、页脚模式显示。
  - 移动端：协议与 Dart 契约增加计划字段与响应接口、计划卡片。
- 网关沿用可选能力模式：`ChatView.plan` 缺省 = 旧网关，不提升应用协议；新增计划响应与模式切换接口，`SessionSummary` 增加待批准标志。

## Capabilities

### New Capabilities
- `plan-mode`: 会话级只读规划模式，包括模式切换与持久、只读工具集与 bash 只读白名单、`submit_plan` 结构化计划、按版本的批准 / 要求修改、批准后自动执行，以及停止 / 归档 / 重启时的失效边界。

### Modified Capabilities
- `agent-runtime`: 会话配置除模型与 thinking 外支持切换 plan 模式（工具集与提示词节），`submit_plan` 仅主 agent。
- `session-gateway`: 新增计划状态投影（`ChatView.plan`）、计划响应与模式切换接口、会话待批准标志，均为可选能力。
- `subagents`: plan 模式下限制委派，只允许只读角色（explore），写文件的角色不可启动。
- `message-queue`: 会话待批准期间排队输入的去向（等计划结算后再进入上下文，与待回答问题一致）。
- `web-ui`: `/plan` 命令切换与模式标识、计划卡片、待批准角标。
- `terminal-ui`: `/plan`、计划面板、页脚模式显示及与排队区键位的冲突处理。
- `mobile-api`: 协议增加计划字段与响应接口。
- `mobile-ui`: 计划卡片与批准 / 修改操作。

## Impact

- 代码：`packages/core`（新增 plan 扩展与 `plan-bash` 纯模块、`runtime.ts` 的 `configureConversation` 扩展、`subagents.ts`、`projection.ts`、`prompt/`）、`packages/gateway`（`contract.ts`、`session-host.ts`、`client-session.ts`、`mobile/*`）、`packages/web`、`packages/tui`、移动端 Dart 契约。
- 协议：不提升应用协议，用可选字段 + 能力探测（`planClient`）；移动端协议需同步 Dart 契约。
- 依赖：不新增依赖，不修改 pi 上游；仅使用 1.3.0 已有的 `configure` / `beforeTool` / `terminate`。
- 风险与待决（留给 design）：
  - 方案选型：`submit_plan` 结束本轮 + 外部切换（倾向），或类似 `ask_user` 的阻塞式 `exit_plan_mode`。
  - 模式切换会在转录里写 system 消息，可能影响提示词缓存。
  - 批准后是否把计划步骤灌入 `todo` 以跟踪进度（pi 用 `[DONE:n]` 文本标记，neko 已有 `todo` 工具）。
  - plan 模式下对 `isProtectedPath` 命中文件的读取是否收紧。
  - Windows Git Bash 下路径写法（`D:/code` 与 `/d/code`）的规范化。
- 已知局限：正则判定可被刻意构造的命令绕过（如拼接引号拆词），第一版接受这一点（保留 `curl` 意味着模型理论上能把内容发往外部，是为了调研能力有意保留的取舍）；后续若需要更强保证，可把 `isSafeCommand` 升级为结构化解析并加入逐次审批，调用方不受影响。
- 范围外：非白名单命令的逐次用户审批、用户自定义放行前缀、结构化命令解析、OS 级沙箱。
