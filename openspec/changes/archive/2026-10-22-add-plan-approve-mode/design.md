# Design

## Context

动机与范围见 proposal.md，行为约束见 specs/。以下是支撑方案的现状（均已在代码与已安装的 pi-durable 1.3.0 类型中核对）：

- pi-durable 没有内置 plan-approve，只给原语：`conversation.configure(AgentChange)` 一次提交即可同时改 `extensions` / `tools` / `modelTools` / `instructions`，切换会在转录里写一条 system 变更消息；`ToolTask.beforeTool` 可返回 `{ block }`；工具结果 `control.terminate` 在整轮结果都要求时结束 run；工具可声明 `deferred: true`，默认不提供给模型，由 `modelTools.add` 暴露。官方示例 `27-plan-mode.ts` 即「`configure` 进入只读 + `submit_plan` + `terminate` + `configure` 退出」，没有审批环节。
- pi 的 `coding-agent/examples/extensions/plan-mode` 提供产品形态：`/plan` 切换、bash 正则白名单、计划后选择「执行 / 留在计划 / 修改」、执行时发送带步骤的消息。它的计划来自助手文本里的 `Plan:` 标题，状态存在进程内，本设计把这两处换成结构化工具与持久文档。
- neko 已有同构机制可复用：`ask_user`（`user-questions.ts`）的文档 + 首次有效结算 + 版本校验 + 停止后对账；`tool-approvals.ts` 的 `beforeTool` + `wrapTool(createBashTool())` 双重校验；`todo` / `ask_user` 的跨端可选能力与 `MAIN_ONLY_TOOLS`。
- neko 的 `Harness.open` 没有设置 `settings.extensions`，所有已安装扩展默认全选；主会话创建时不指定 `extensions` / `tools`；`configureConversation` 目前只处理 model 与 thinkingLevel；`AgentChange.instructions` 没被占用。

## Goals / Non-Goals

**Goals:**
- 用 pi-durable 官方示例的路径实现 plan 模式，最小化自造机制。
- 模式、计划与决定全部持久，多端一致，进程在任一步骤中断后可恢复到正确状态。
- 只读边界硬执行（工具不可用 + 调用前拦截），bash 白名单沿用 pi 的正则做法。

**Non-Goals:**
- 非白名单 bash 的逐次审批、可配置放行前缀、结构化命令解析、OS 沙箱。
- 把计划步骤自动写入 `todo` 并跟踪进度（执行输入里提示模型自行使用 `todo`）。
- 手机端进入 plan 模式（手机可以取消待批准计划并退出，见 D10）。
- 子 agent 自身进入 plan 模式。

## Decisions

### D1：`submit_plan` + `terminate` + 外部切换，而不是阻塞式 `exit_plan_mode`
`submit_plan` 写入计划后返回 `control: { terminate: true }`，本轮结束，会话空闲但计划处于待批准；批准或修改由用户经 `NekoSession` 方法触发，不是聊天输入。

备选：像 `ask_user` 那样让工具阻塞等待批准。放弃的原因：阻塞会挂起一个 task，需要 `live()` owner 链、停止对账、迟到回答等一整套逻辑；而 terminate 之后 run 已结束，待批准只是文档里的一个状态，重启与多端天然一致，也正是官方示例 27 的路径。代价：`terminate` 只在**整轮所有结果**都要求时才结束 run，因此 `submit_plan` 声明 `executionMode: "sequential"`，工具描述要求单独调用；若模型仍与其他调用同轮发出，run 继续，计划仍为待批准（见风险）。

### D2：`PlanDoc` 是权威，agent 配置是投影
会话文档 `app.neko.plan`（scope conversation，`history: "rewindable"`、`fork: "asOf"`，与示例 27 的 `PlanDoc` 一致）保存：

```
{ mode: "normal" | "plan",
  revision: number,                       // 每次状态变化 +1，给 view 做增量
  items: [{ version: string,              // randomUUID，决定必须带上
            taskId: number,               // submit_plan 的工具 task id，提交幂等键
            title, steps: string[], note,
            status: "awaiting_approval" | "approved" | "revision_requested" | "superseded" | "cancelled",
            feedback: string | null,
            dispatched: boolean,          // 批准/修改产生的输入是否已提交
            createdAt, settledAt }] }     // 只保留最近 5 条
```

进入 / 退出 plan 模式时先提交文档，再 `configure`：

```
进入: { tools: { remove: [edit, write, job] }, modelTools: { add: [submit_plan] }, instructions: PLAN_INSTRUCTIONS }
退出: { tools: null, modelTools: null, instructions: null }
```

`tools.remove` 让写工具在会话里整体不可用（含 `executeTool` 嵌套调用，因为 `callable` 由已启用工具决定），比只用 `modelTools` 隐藏更强；`submit_plan` 声明 `deferred: true`，只在 plan 模式经 `modelTools.add` 暴露，normal 模式模型看不到它，也不必在每个创建会话的位置给它做过滤。

备选：把模式只记在 agent 配置里（`extensions.add: [Plan]`，示例 27 的写法）。放弃的原因：neko 默认全选已安装扩展，示例依赖的 `settings.extensions` 默认选择不存在；且文档提交与 `configure` 是两次提交，没有唯一权威时中断会留下无法判定的状态。以文档为准后，**每次受理输入前与启动对账时**比较文档与 `conversation.agent()` 的生效值，不一致则重新 `configure`（幂等），同时覆盖「文档已改、配置未应用」与「配置已应用、文档未改」两种中断。退出时用 `null` 回到宿主默认：neko 主会话本来就不设这些字段，所以等价于恢复全量。

### D3：只读由三层保证
1. 工具集：D2 的 `tools.remove`，写工具不可用。
2. `beforeTool`（新扩展 `neko-plan`，读 `PlanDoc.mode`）：对 `bash` 调 `isSafeCommand`，不通过则 `{ block: "..." }`，文案包含被拒命令与替代建议；对 `edit` / `write` / `job` 也兜底拦截。
3. `wrapTool(createBashTool())` 在 `execute` 内再校验一次，与 `tool-approvals.ts` 同写法，防止判定与执行之间模式变化。

explore 子 agent 的 bash 仍走现有逐次审批，不受 plan 模式影响（它在自己的会话里，`PlanDoc` 缺省为 normal）。

### D4：bash 判定是纯模块 `plan-bash.ts`，正则 + 切段
沿用 pi `plan-mode/utils.ts` 的安全白名单正则，返回 `isSafeCommand(command): boolean`。与 pi 的差异：
- 按 `;`、`&&`、`||`、`|`、换行切段（只识别引号外的分隔符，一个小函数），每段都必须安全；pi 只检查开头，`ls; node x.js` 能通过。
- 含 `$(`、反引号、`<(`（单引号内除外）直接拒绝；输出重定向、heredoc、后台 `&` 拒绝，`2>&1` 与 `>/dev/null` 放行。
- pi 的 `DESTRUCTIVE_PATTERNS` 是「出现危险词即拒绝」，白名单已经按首词限定程序，这组词在首词上是冗余的，还会误拒 `rg code`、`git log --grep=rm`。因此改为：白名单之外一律拒绝，另设 `DANGEROUS_FLAGS`（白名单内程序的危险参数：`find -delete|-exec`、`sed -i`、`sort -o`、`--output`、`curl` 的 `-o -O -d -X -T -F`、`rg --pre`、`fd -x`）与 `DANGEROUS_CONTENT`（引号内脚本：`awk` 的 `system(`/`getline`/`print >`、`sed` 的 `w`/`e` 命令）。参数检查在去掉引号内容的文本上进行，所以 `rg "=>"` 不被当作重定向。
- 对 pi 的白名单做了三处收紧：`git branch`、`git remote` 只放行列出形态；`env` 只放行无参；去掉会卡住终端的 `top`、`htop`、`less`、`more`。补充 `cd`（模型常写 `cd x && ...`）和少量只读工具（`cut`、`tr`、`basename`、`realpath`、`git blame` 等）。
- 保留 `curl`、`wget -O -`、`awk`、`sed -n`，以保证调研能力。

备选：结构化解析加按程序/子命令/参数判定。放弃：复杂度高，且对"合作的模型"收益有限；判定函数是单点，将来替换或加审批不影响调用方。切段只识别引号外分隔符，`rg "a;b"` 这类带引号的分号不会被误拆，反过来未闭合引号会按保守方向拒绝。

### D5：批准 = 退出模式 + 提交带步骤的输入，用 requestId 保证幂等
`NekoSession.respondPlan(version, decision)` 在 `admit(id)` 内：
1. 单个 commit：校验 `status === "awaiting_approval"` 且 version 匹配（与 `UserQuestions.respond` 同样的首次有效结算 / 返回原记录）；批准置 `approved` 并 `mode: "normal"`，修改置 `revision_requested`；记录 `feedback`。
2. 批准时 `configure` 退出 D2 的配置。
3. 提交输入：批准为 `plan-exec:<version>`，内容含计划标题与步骤并提示"可用 `todo` 跟踪进度"；修改为 `plan-revise:<version>`，内容是用户反馈。输入带 `entry: { kind: "plan-decision", data: { version, decision } }`，供前端把它显示为决定记录而不是普通气泡。
4. 把 `dispatched` 置真。

步骤 2–4 中断时，启动对账处理最近一条 `dispatched === false` 且已结算的记录：重复 `configure` 与同 requestId 提交（pi-durable 对相同 `requestId` 幂等，含重开后）。这样"批准后执行输入恰好一次"不靠额外的锁。

对应 pi：pi 用 `ctx.ui.select` 选"Execute / Stay / Refine"，执行时发 `pi.sendMessage({ triggerTurn: true })`。本设计用同样的三种结果（批准 / 留在 plan / 要求修改带反馈），但"留在计划"是不做决定，计划保持待批准。

### D6：失效对账沿用 questions 的模式
`PlanService`（`plan.ts`）不需要像 `UserQuestions` 那样监听 task 终止：`submit_plan` 之后 run 正常结束，task 终止并不意味着「停止」。因此取消是显式的：`NekoSession.abort()`（归档会话经它）把待批准计划置 `cancelled`，离开 plan 模式同样置 `cancelled`；重启不取消待批准计划（会话本就空闲）。普通输入取代待批准计划：受理新输入成功后（`submitTo`，非 `plan-decision`）置 `superseded`，保持 plan 模式；`submit_plan` 执行时若 inbox 中已有排队的用户输入（steer / followUp），新计划立即置 `superseded`，因为该输入会在它之后进入上下文。

### D7：模式切换只在空闲时受理
`setPlanMode` 与 `respondPlan` 在会话有运行中的 run（`LiveDoc.run !== undefined`）时拒绝。理由：`configure` 从下一次请求起生效，运行中切换会让同一 run 前后使用不同工具集；示例 27 也是在两次 `submit().wait()` 之间切换。

### D8：子 agent 限制放在 `subagent` 工具入口
`subagents.ts` 的 `execute` 在 "Subagents cannot delegate." 之后读取主会话 `PlanDoc.mode`；`plan` 模式下 `coder` 的启动与 `continue` 返回错误。`submit_plan` 加入 `MAIN_ONLY_TOOLS`，其扩展名加入 `MAIN_ONLY_EXTENSIONS`，子 agent 新建与启动修复中剔除。

### D9：网关为可选能力，模式切换是独立方法
- `ChatView.plan`（可选）：`{ mode, revision, current: PlanRecord | null }`，缺省 = 旧网关。`session-host.ts` 的文档订阅白名单加入 `app.neko.plan`；视图组装与 todos/questions 一样 `Promise.all` 取。
- 新方法 `planGet(version)`、`planRespond({ version, decision })`、`planMode({ mode })`。模式不塞进 `configure` 的 `change` schema：它是 `additionalProperties: false` 的模型配置，混入会扩大其含义。
- `SessionSummary.awaitingPlan`（可选）由 `SessionMetadataDoc` 计算（与 `awaiting` 并列，来源是 `PlanDoc` 有待批准项），不复用 `awaitingAnswer`，因为前者表示"运行中等回答"，待批准时会话并不运行。
- 前端用 `planClient`（`PLAN_UNSUPPORTED`，探测 `view.plan !== undefined`），不提升应用协议，与 `questionsClient` 完全同构。
- 数值上限 `PLAN_LIMITS` 放进 `interactions.ts`（已被前端与 `contract.ts` 共用的纯模块）。

### D11：TUI 计划面板自动打开
待批准计划靠输入 `/plan` 才出现，交互成本过高。`PlanDock.autoOpen` 与 `QuestionDock.autoOpen` 同规则：复用 `canAutoOpen`（空编辑器、无补全/选择器/登录/审批/排队选择、终端可用），再要求问题面板未打开；每个计划版本只获得一次机会，Esc 关闭后不再弹出，用户忙时只显示页脚提示，修改后重新提交的新版本再次自动打开。

### D10：UI 落点（均参照 `ask_user` 的现有布局）
- Web：只用 `/plan` 斜杠命令进入或切换，不加进入按钮；待批准计划卡片上另有「取消并退出计划模式」（D10）。命令接入方式同 `/compact`：`lib/command-suggestions.ts` 增加菜单项（网关支持计划时才列出），`composer.tsx` 在提交时于忙碌拦截之前解析 `/plan`，调用 `planMode`，不进入输入历史、不发给模型；运行中提示并保留草稿。输入区只显示模式标识（`<output>` 状态胶囊，与压缩状态同位置、同样式）。待批准计划卡片放进 `data-attention-stack`（与 `QuestionDock` 并列，保证在输入区附近可见）；消息流里 `submit_plan` 的 `ToolRow` 渲染只读历史行（仿 `AskUserRow`）；会话列表用 `awaitingPlan` 显示"等待批准"，标签页标题前缀一并覆盖。
- TUI：`/plan` 无待批准时切换模式，有待批准时打开计划面板（`PlanDock`，仿 `QuestionDock`，面板打开时独占按键）；`Shift+Tab` 作为切换快捷键（未被占用，不依赖终端对 Ctrl+Alt 组合的支持）；页脚身份段加模式标识，副行 hint 加"待批准"提示。面板打开时在 `input-router.ts` 里排在排队选择之前，并沿用 `opened` 回调清除排队选择的先例，避免 Enter / Esc 同时被两处消费。
- 移动端：协议加 `plan` 能力、状态摘要 `plan: { revision, pending }`、方法 `plan.get` / `plan.respond`、通知 `plan.changed`；仅提供退出（`plan.exit`），不提供进入。Dart 契约、夹具 `plan-*.json`、卡片组件同步。

### D11：提示词
`PLAN_INSTRUCTIONS`（英文，与现有提示词一致）通过 `AgentChange.instructions` 注入：说明只读、可用工具、必须用 `submit_plan` 提交计划、不得自行修改。`instructions` 渲染在所有扩展节之后，退出时 `null` 清除。`rules` 节随工具集自动变化。不新增第六个 prompt 节。

### D10：取消并退出是「退出 plan 模式」的快捷入口，不是新决定
计划决定仍只有批准与要求修改。「取消并退出计划模式」直接复用 `setPlanMode("normal")`：`PlanService.setMode` 在离开 plan 模式时已把待批准计划置为 `cancelled`，空闲才受理（D7）、幂等、经 `admit` 与输入串行，不新增核心接口、网关方法或决定种类。Web 卡片、TUI 面板在待批准时给出该入口；移动 API 增加仅能退出的 `plan.exit`（不增加进入入口，保持「手机不能让会话进入只读」的边界）。取消不提交任何输入，因此不会触发模型回合。

## Risks / Trade-offs

- [正则判定被刻意构造绕过] → 第一版接受；护栏而非沙箱，proposal 已明示；`isSafeCommand` 是单点，可替换。保留 `curl` 的数据外发风险是为调研能力有意取舍。
- [`terminate` 在同轮有其他调用时不结束 run] → `submit_plan` 设 `sequential` 并在描述中要求单独调用；run 继续时计划仍待批准，批准因 D7 被"运行中"拒绝，用户等本轮结束再批准。
- [模式切换在转录里写 system 消息，提示词缓存可能失效] → 切换是低频人工操作，接受；不在每个 run 前重复写入。
- [文档与配置不一致] → D2 的启动与受理前对账，幂等 `configure`。
- [排队输入与 terminate 的交互未在文档中明确] → 已知语义：steer 在当前工具轮后进入运行中的工作，followUp 在 run 回答时放入并开始下一轮（pi-durable README "Busy Conversations"）。模式是会话级配置且忙时不允许切换（D7），所以排队输入总是在 plan 模式下处理。推论：若 steer 与 `submit_plan` 同轮到达，工具轮后 run 可能继续而不是结束，计划随后被取代；若 `terminate` 后遗留 followUp，它开始新一轮并取代计划。已用测试验证（任务 2.7）：followUp 在 `terminate` 后开始新一轮并仍处于 plan 模式；因此 `submit_plan` 在 inbox 有排队用户输入时直接把新计划置为已取代，否则批准会针对一个已过时的计划。
- [fork 继承 plan 模式] → `fork: "asOf"` 使分叉保留当时的 `PlanDoc`；需要测试分叉后 agent 配置与文档一致，不一致由对账修复。
- [`modelTools` / `tools` 的 `null` 会清除其他来源写入的值] → 目前 neko 主会话不设置这两项，实现时若引入 `tool_search` 等需改为读—改—写。
- [`submit_plan` 在 normal 模式遗留于存储的 `modelTools.add`] → 回滚时该名称未注册，文档说明对未注册名称无效，不影响会话。

## Migration Plan

纯增量：旧存储没有 `app.neko.plan`，读取为缺省 `{ mode: "normal", items: [] }`；旧网关不发布 `plan` 字段，旧客户端忽略未知可选字段；不升应用协议与移动 API 版本。回滚：移除 `neko-plan` 扩展与前端入口即可，已存储的 plan 文档保持惰性；仍处于 plan 模式的会话回滚前应退出，否则 `tools.remove` 与 `instructions` 残留。

## Open Questions

- ~~计划卡片是否需要 Markdown 渲染~~：已决定渲染。模型写的步骤与「假设与风险」说明常带行内代码、列表、加粗；标题仍按纯文本。各端复用既有 Markdown 组件（Web `Markdown` + DOMPurify，Dart `NekoMarkdown`，TUI pi-tui `Markdown`），不引入新的信任：控制字符先剥离，HTML 不生效，链接不可点，远程图片不加载。反馈文字仍按纯文本。
- 批准后执行输入里的措辞（是否固定模板）可在实现时定，不影响 spec。
