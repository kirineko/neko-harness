# Design

## Context

- pi-durable 1.4.0 已提供 `createCodemodeExtension({ sandbox, namespaces?, inlineBudget?, models? })`（子路径 `@earendil-works/pi-durable/codemode`）：
  - 扩展注册 `codemode` 工具（`callers: ["model"]`、`replay: "safe"`）和 `codemode` 提示词段（按 `agent.callable` 渲染 TS 声明，预算 3000 token）。
  - 任务级文档 `pi.codemode.run` / `pi.codemode.journal` 支持确定性重放；会话级 `pi.codemode.store` 是可回退的存储。
  - 结果 `details` 为 `{ calls, fullOutputPath? }`；运行中的嵌套调用在 `pi.live.nestedTools` 里（`NestedToolSlot`，带 `parentCallId`）。
- 沙箱 `CodemodeSandbox` 来自 `@earendil-works/pi-codemode`。它已经作为传递依赖安装在 `node_modules`，但 neko 尚未直接依赖它。它默认从安装目录加载 `quickjs.wasm` 和 worker 文件；`acquireWorker` / `onWorkerStarted` 可用于限制并发。
- 嵌套调用走完整的 `ToolTask` 流程，`beforeTool` 能看到 `call.parent`。因此 plan 模式守卫（`plan.ts`）和 explore 子 agent 的 bash 审批（`tool-approvals.ts`）对脚本里的调用自动生效。
- 现状里有四个冲突点：
  - plan 模式通过 `planAgentChange` 单独写 `modelTools`，退出时写 `null`。
  - 会话创建时不显式指定 `tools` / `extensions`，安装进 registry 的扩展会被所有会话使用（实现时需确认）。
  - `ChangeTracker` 只看对话记录里模型发出的 edit / write。
  - 投影层不读取 `nestedTools`，工具结果的 `details` 也不会传到前端。
- Pi coding-agent 的 codemode 基于旧的 agent 循环，neko 不直接复用它。它的做法作为语义参照：`on` / `only`、全进程 2 个 worker、等待 60 秒、256 MiB 内存、提示词规则一条。

## Goals / Non-Goals

**Goals:**
- 直接使用 durable 扩展：工具描述、提示词段、输出格式和重放语义都不改写。neko 只做三件事：选择性地启用扩展、组合工具配置、补齐 UI 与改动统计。
- 每个会话的工具配置都能从持久记录推导出来，并且可以自愈，与 plan 模式的模式一致。

**Non-Goals:**
- 不裁剪 `codemode` 段的重复声明（`on` 模式下声明重复属于已知成本）。
- 不做 `namespaces`、MCP、`tool_search`，不做会话中途切换模式，不为脚本程序设整体审批。

## Decisions

### D1 沙箱与扩展安装

- runtime 创建一个 `CodemodeSandbox`，与运行时同生命周期，参数为 `memoryLimitBytes: 256 MiB`，外加 `acquireWorker` 和 `onWorkerStarted`（见 D6）。
- 安装 `createCodemodeExtension({ sandbox, models: false })`。
- `models: false`：脚本里的 `models.classify` 等调用经 `api.models` 发出，不经过 `guardProvider`，会绕过 provider 启用与 Key 门禁；另外是付费调用。
- 关闭运行时，先关闭 sandbox，再关闭 Harness。durable 规定：运行中的脚本被沙箱关闭时不算结果，下次启动会重放。
- 依赖：根 `package.json` 新增 `"@earendil-works/pi-codemode": "1.4.0"`。`build-release.ts` 把 `dependencies` 当作 external，因此该包不会被打进 bundle，默认的 wasm / worker 路径保持有效。不需要像 coding-agent 那样自带 worker 入口文件。
- 备选方案：自己实现 `CodemodeCall`，或者用 pi-codemode 的 `execute()` 不做持久化。两者都偏离 Pi 模式，也会失去重放能力。不采用。

### D2 模式的三层数据

- **全局设置**
  - 配置文件 `codemode: { mode }`，由 `config.ts` 解析，非法值报错。
  - UI 保存值放在根会话的文档 `app.neko.codemode-settings` 里（`{ mode: "off"|"on"|"only"|null }`，`checkpointWhen: () => false`），与 `ContextSettingsDoc` 的存放方式相同。
  - 解析顺序：保存值 > 配置 > `off`，来源同时报告。
- **会话记录**：`app.neko.codemode`，会话级，`history: "rewindable"`，`fork: "asOf"`，`{ mode }`。
  - `createConversation` 在创建时写入当时的生效值。
  - 子 agent 创建时复制主会话的值。
  - 文档缺失时视为 `off`，覆盖升级前的会话和根会话。
- **纯模块**：`packages/core/src/codemode-mode.ts`（新子路径 `@neko-harness/core/codemode-mode`），提供取值列表、解析函数和视图上限。Web、TUI 和网关契约共用它，避免硬编码。
- 备选方案：设置每次请求时实时生效。这会让同一会话的工具集在两次请求之间变化，破坏提示词缓存，也与你选择的「新会话生效」不符。不采用。

### D3 工具配置统一计算

- 新增纯函数 `agentChangeFor({ plan, codemode, role })`，返回完整的 `AgentChange`：

| codemode | plan | tools | modelTools |
|---|---|---|---|
| off | normal | 移除 `codemode` | `null` |
| off | plan | 移除 `codemode` 与 PLAN_REMOVED | `{ add: [submit_plan] }` |
| on | normal | 保留 | `null` |
| on | plan | 移除 PLAN_REMOVED | `{ add: [submit_plan] }` |
| only | normal | 保留 | `[codemode, todo, ask_user, subagent]`（子 agent 只有 `[codemode]`） |
| only | plan | 移除 PLAN_REMOVED | `[codemode, todo, ask_user, subagent, submit_plan]` |

- `off` 还要从会话的 `extensions` 里移除 `codemode` 扩展，否则 `codemode` 段仍会按 `callable` 渲染。其余模式保留该扩展。`instructions` 仍由 plan 模式决定（`PLAN_INSTRUCTIONS` 不变，继续作为标记）。
- `syncPlanAgent` 改为 `syncAgent`：读取两份文档，与解析后的 agent 比较（工具名集合、`modelTools`、扩展名、instructions），有差异时执行一次幂等的 `configure`。调用时机与原来相同：启动对账、每次受理输入前、切换 plan 模式时。
- 这样，升级前的会话在第一次受理输入或启动对账时，会被移除新出现的 `codemode` 工具和扩展，行为与升级前一致。
- `planAgentChange` 收回为 `agentChangeFor` 的一部分，plan 模块只负责模式文档。
- 探针结论（任务 1.2，已用测试固化）：
  - 会话未显式配置 `extensions` 时，新安装的扩展**默认生效**，所以升级前的会话和 off 模式都必须靠 `extensions.remove` 去掉 `codemode`；工具与提示词段都属于该扩展，不需要再改 `tools`。
  - `modelTools` 的数组形式可以点名 deferred 的 `submit_plan`。
  - 因此 `agentSyncChange` 只对不一致的那一方面生成变更：plan 方面不一致才写 `tools` / `instructions`，codemode 方面不一致才写 `extensions`。已有的显式 `tools` 配置不会被误清。
- 偏离上表：`only` 模式下主 agent 还要保留 `subagent`（`todo`、`ask_user` 之外），否则脚本不能派发子 agent、模型又看不到它，子 agent 就彻底不可用。
- 子 agent 创建与启动修复不能再用 `agent.tools`（只是「提供给模型」的子集，`only` 下只剩几项）重建工具列表，统一改用 `enabledTools(agent)`（提供的工具加上只有脚本能调用的工具）。

### D4 脚本可调用范围

- 保持 durable 的默认行为：脚本能调用的范围是 `agent.callable`，即已启用且 `callers` 包含 `tools` 的工具。
- `todo`、`ask_user`、`submit_plan` 已经是 `callers: ["model"]`（`subagent` 在本变更中改为同样的取值）。
- 把 `subagent` 改为 `callers: ["model"]`：在脚本里批量派发子 agent 不好追踪，也不好审批；其他工具同样不能调用它。
- `job` 保持可调用。它是 `replay: "unsafe"`，被重启打断时按自身策略返回 interrupted，由脚本处理。
- 子 agent 的工具过滤（`subagents.ts` 中的 `READ_TOOLS` 等）放行 `codemode`。explore / plan 角色的脚本只能调用它们自己被过滤后的只读工具，所以给它们 codemode 不会扩大权限。

### D5 提示词规则

- `buildRules` 的工具名来源改为：先按顺序取 `agent.tools`，再追加只出现在 `agent.callable` 里的名字。
- `off` 模式下两者相同，规则逐字节不变。`only` 模式下 edit、bash 等规则保留。
- `TOOL_GUIDELINES.codemode` 采用 Pi 的那条规则："Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of many separate calls."
- 偏离 Pi 修复 #10192（Pi 会隐藏被隐藏工具的规则）的理由：neko 的 edit 规则对脚本里的调用同样适用，而 `codemode` 段只有声明，没有用法规则。

### D6 worker 上限

- 全进程计数器 `CODEMODE_LIMITS = { maxWorkers: 2, waitMs: 60_000 }`。
- 用 `wrapTool(codemode)` 在调用内层 `execute` 前等待空位（FIFO，可被 `context.abortSignal` 中止），超时则返回错误结果「sandbox busy」。
- `acquireWorker` 返回的释放回调在 worker 真正退出时才被沙箱调用（Bun 的 `terminate()` 可能有延迟，名额要占到退出为止），所以不需要 `onWorkerStarted`。
- 等待者拿到名额后先成为「预留」，用 `AsyncLocalStorage` 把预留交给同一调用链里的 `acquireWorker`，避免两个等待者同时被放行后争抢；调用结束时未被接管的预留自动归还。没有预留而名额已满时，`acquireWorker` 直接抛「沙箱繁忙」作为兜底。
- 等待发生在 durable 调用之前，不进入它的日志。重启后重放会重新等待名额，不影响重放的确定性。

### D7 投影与契约

- `ChatItem` 的 tool 变体新增可选字段 `codemode?: { calls: CodemodeCallView[]; omitted: number; fullOutputPath: string | null }`，其中 `CodemodeCallView = { id, name, args, status: "running"|"ok"|"error"|"cancelled", durationMs, error }`。
- 数据来源：
  - 运行中：从 `pi.live.nestedTools` 按 `parentCallId === callId` 过滤，参数截到 200 字符，有 `summary` 时取其 `isError` / `durationMs` / `error`。
  - 结束后：从工具结果消息的 `details.calls` 读取（durable 已截断参数和错误）。
- 上限 `CODEMODE_VIEW_LIMITS.maxCalls = 100`，超出部分计入 `omitted`。
- `summarizeToolCall` 新增 `codemode` 分支：摘要为跳过 `// @options` 行后的第一行代码，`detail` 为完整代码。代码过长时按现有 detail 上限截断。
- 网关 `ChatViewSchema` 的 item 与 streaming 两处都加该可选字段。新增 `neko.codemode-settings` 契约（version 1，状态 `{ revision, effective: { mode }, source }`，方法 `set({ mode })`、`reset()`），在 `server-services.ts` 与 `client-session.ts` 中接入。`APPLICATION_PROTOCOL` 改为 10。
- 移动端：`mobile/projection.ts` 与 `protocol.ts` 的工具项加可选字段 `codemode`（结构同上），不提高 API 版本；Dart 的 `ToolInfo.fromJson` 按可选字段解析。

### D8 「本次改动」纳入嵌套调用

- 问题：嵌套调用不进对话记录。`NestedCallDoc` 在调用方结算后就被移除，任务记录里只剩回执，`details.calls` 的参数也被截到 200 字符，事后无法还原 diff。
- 方案：
  - 用 `wrapTool` 包装 `edit` 与 `write`。内层执行成功、且当前任务是嵌套调用（`api.getTask(api.taskId)` 的 input 为 `kind: "nested"`，实现时确认字段）时，在同一工具执行期间提交一条记录到会话文档 `app.neko.nested-changes`（rewindable / asOf）。
  - 记录键为嵌套 callId，内容为 `{ parentCallId, tool, path, args | diff }`，按 `CHANGE_LIMITS` 截断。
  - `ConversationChanges` 读取条目时，只把 `parentCallId` 对应的 codemode toolCall 已出现在当前分支里的记录计入，位置记为该 toolCall 的位置。文档变化时 revision 递增。
- 效果：脚本失败或被中止时，已经成功的改动仍被计入；回溯和分叉时，记录随文档的 asOf 语义以及「父调用是否在当前分支可见」过滤。
- 备选方案：在 codemode 外层包装，结算前读取 `NestedCallDoc`。中止时外层没有机会执行，会漏记。不采用。
- 已知局限：内层 edit 已写盘、记录尚未提交时进程崩溃，这次改动不会被记录。可以接受，与 bash 改动不计入属于同一类「不等同于磁盘差异」。

### D9 前端

- Web：新组件 `codemode-card.tsx`，由 `message-list` 在 `item.codemode` 存在或 `name === "codemode"` 时选用。脚本复用现有代码高亮。设置页 `/settings/codemode` 按 `settings-search-page` 的结构实现，设置菜单增加一项。
- TUI：`ToolExecutionComponent` 增加 codemode 分支（折叠时显示 8 条，与 Pi renderer 一致）；新增 `/codemode` 面板，按 `/search` 面板的结构实现；更新 `/help`。
- 移动端：`ToolCard` 增加 codemode 展开区。
- 导出：Markdown、HTML、JSON 按 conversation-export 的新增要求实现。
- 三端都要同时补齐中英文案。`codemode` 与 `/codemode` 加入 `protected-terms.json`。

## Risks / Trade-offs

- [DeepSeek 不支持 Lark 语法约束，脚本只能以 JSON 转义字符串的形式写出，质量可能下降] → 实现初期用真实 DeepSeek 模型做一次小规模试跑（tasks 1.x），结论写入 design 的跟进记录。默认 `off` 降低影响面。
- [Bun 1.4.x 下 worker `terminate()` 可能拖延进程退出，影响网关的有界关停] → 关闭顺序为先 sandbox 后 Harness，并用现有关停测试覆盖「脚本运行中关停」；必要时依赖网关已有的强制退出路径。
- [`on` 模式每次请求最多多出约 3000 token 的重复声明] → 这是已接受的决定；默认 `off`。
- [所有会话默认启用新扩展，旧会话会意外出现 codemode] → `syncAgent` 在启动对账与受理输入前修正；用测试覆盖「升级前会话」场景。
- [嵌套 edit / write 记录与磁盘不一致的极端情况] → 见 D8 的已知局限，规格已声明改动不等同于磁盘差异。
- [脚本里的 job 被重启打断后返回 interrupted] → 沿用 durable 语义，不额外处理。

## Migration Plan

- 无数据迁移：新文档缺失即视为 `off`，旧会话经 `syncAgent` 收敛到 `off`。
- 应用协议从 9 升到 10，旧的 TUI / Web 与新网关会互相拒绝连接，按既有提示更新后重启即可。
- 回滚：删除扩展安装与依赖即可。留下的 `app.neko.codemode*` 文档和 `pi.codemode.store` 不会被旧版本读取；不过 SQLite 已在 Pi 1.4 升级时迁到 schema v2，回滚仍需要 1.4 系列的 neko。

## Open Questions

- DeepSeek 写出的脚本质量（需要实测，只影响文档里的推荐，不改变设计）。
  - 实测结论（deepseek-flash，真实 API，on / only 各一次，任务为读取 3 个文件并改其中一处）：两种模式都只用 2 次 `codemode` 调用完成（一次 `Promise.all` 批量读取，一次 edit 加复核），脚本语法与 `tools.<name>` 用法正确，未出现越权调用；单次任务约 2.1–2.9 万 token。`only` 模式下模型没有尝试直接调用被隐藏的工具。
  - 崩溃恢复：脚本运行中 `kill -9` 进程后重开同一 SQLite，被打断的脚本以 `Tool bash was interrupted and may have partially run` 失败，bash 不会自动重放；模型据此重新执行并完成任务。
  - 结论：不需要调整设计，文档保持「默认关闭、按需开启」的推荐即可。
