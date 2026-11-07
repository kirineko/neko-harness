# Proposal

## Why

neko-harness 锁定 Pi 1.4.0，而 Pi 1.5.0 已发布到 npm（`reference/pi` 已同步，含 `v1.5.0` 标签）。1.5 是一次结构性变更：pi-durable 删除了 neko 赖以投影会话的 `Conversation.viewState()`、`watchEvents()`、`Session.documentState()`，`ConversationView.entries` 从"活动上下文"变为"窗口"；pi-ai / chord / pi-durable 全部去掉 TypeBox 改用 `@earendil-works/pi-schema`，TypeBox 写的 Chord 契约在 1.5 下类型退化为 `unknown`；watch、observer、报告统一改为按 `kind` 标记的形状；崩溃停放被"到限即结束"取代。同时 1.5 提供了 neko 现在用补偿逻辑模拟的原生能力（同一提交内受理输入、运行失败原因、继续运行、轮次上限）。继续停留在 1.4 会让这些补偿逻辑持续存在，并拖大后续升级成本。

## What Changes

- 将根包与 `packages/{core,gateway,tui,web}` 使用的 chord、pi-ai、pi-durable、pi-tui、pi-env、pi-codemode 精确锁定到 npm 发布的 `1.5.0`，新增精确锁定的 `@earendil-works/pi-schema@1.5.0`，更新 `bun.lock`；`v1.5.0` 之后 `main` 的提交不纳入。
- **BREAKING（内部）** 会话视图改走 1.5 原生接口，线上协议不变：
  - core 以 `Conversation.watch()` 加 `ConversationTranscript` 取代 `viewState()` 与 gateway 手写的历史合并；窗口缺口（积压溢出、重连）由 transcript 补齐，`ChatView` 仍下发完整条目，Web / TUI / 移动端无需改为分页；
  - 上下文占用（`contextTokens`）改按 `Conversation.context()` 的活动条目计算，不再把视图条目当作模型上下文；
  - `pi.live` 压缩状态的 `reason` 在 1.5 改名 `trigger`，投影层映射回现有 `ChatView.compaction` 字段，线上形状不变；
  - 删除 `NekoSession.events()`（基于已删除的 `watchEvents()`）及其示例用法；`documentState()` 改用 `watchDoc()` / 快照。
- **BREAKING（依赖）** 彻底退场 TypeBox：Chord 契约（`gateway/contract.ts`、`mobile/admin.ts`、gateway 内部 `local(...)` 声明）、core 工具参数（subagent、todo、ask_user、submit_plan、job、文件搜索、web search）、移动端协议校验（`mobile/protocol.ts`、`mobile/adapter.ts`，由 `typebox/value` 的 `Check` 改为 pi-schema `compile`）与测试全部改用 pi-schema；移除根包与 gateway 的 `typebox` 依赖。契约按"`Type.Object` → `obj(..., { open: true })`"保持 JSON 形状与指纹不变；应用协议不提升。
- **BREAKING（内部）** 适配 1.5 的标记形状：`subscribeCommits` → `observeCommits`（核心与网关约 11 处），watch 监听与结束原因、文档 retire（`retired` 标记，watch 不再结束）、`onReport(report)` 单参数报告、`DocumentCommitChange.kind`、`SubmissionRecord` 新增 `continue` 变体。
- **BREAKING（行为）** 崩溃到限不再停放：同一任务连续被崩溃截断达到 `restartLimit`（默认 5）后结束，而不是停放等待 `retryTask`；工具调用得到错误结果，运行以 `restart_limit` 失败结束并对用户可见；模型请求进行中宿主崩溃不再无限重发，按重试策略计为失败尝试，用尽后运行以 `interrupted` 结束。
- 采纳 1.5 新能力：
  - **运行失败原因与继续**：投影 `pi.live.runFailure`（`model_error`、`no_model`、`aborted`、`interrupted`、`restart_limit`、`turn_limit` 等）为可选的 `ChatView.runFailure`；新增可选的"继续"会话操作（`submit({ type: "continue" })`），只在空闲且上一轮未得到回答时可用。Web、TUI 显示失败原因并提供继续入口；移动端只显示失败原因。沿用可选能力探测模式（缺省 = 旧网关），不提升应用协议。
  - **同一提交内受理输入**（`Conversation.submit(tx, draft)` 与导出的 `configure(tx, …)`）：计划批准 / 要求修改、agent 配置对账与执行输入在同一次提交中落盘，新决定不再依赖 `dispatched` 补发（仅保留对 1.4 遗留未派发决定的启动修复）。排队项改为引导仍是"撤回 + 重新受理"：1.5 没有事务内撤回接口，行为不变。
  - **轮次上限**：配置文件新增可选 `maxTurns`（缺省不限制），应用于新建的主会话与子 agent；达到上限时该轮工具执行完后运行以 `turn_limit` 结束，可用"继续"恢复。
  - 免费获得的修复：流式工具参数的二次复杂度、长回答内存占用、`thinkingLevel` 记录等。
- 存储：SQLite schema 在 1.4.0 → 1.5.0 之间未变，**不清理数据**；但 `pi.live` v3、`pi.tool` v3、`pi.generation` v2 一经写入，1.4 无法再读取，不可回退到上一发布版本。
- 不采纳：按会话的压缩设置（neko 的上下文设置是全局的，继续经 `settings.compaction` getter 生效）、只读 Harness、`afterRun` 运行结束任务、`beforeProviderRequest`、`StoreStorage` / Chord v2（`chord/next`）、`ChatView` 改为窗口与前端分页（独立的性能变更，留待后续）。
- 更新 README、AGENTS.md（「Pi 1.4 使用要点」改为 1.5：视图窗口、pi-schema、标记形状、崩溃到限结束、submit(tx)、runFailure / continue、maxTurns）；不发版、不提交 git commit。

## Capabilities

### New Capabilities

无；沿用现有能力边界。

### Modified Capabilities

- `agent-runtime`：SDK 基线更新为 Pi 1.5.0（1.4 数据原地打开、不清理，但不可回退）；"崩溃循环任务停放"改为"崩溃到限结束并可见"；模型请求中断不再无限重发；新增运行失败原因记录与"继续"运行、可选轮次上限。
- `plan-mode`：批准 / 要求修改与执行输入原子落盘，重启恢复不再依赖补发。
- `session-gateway`：会话视图新增可选的运行失败原因与"继续"操作，旧网关缺省语义；视图内部改为窗口加完整 transcript 但线上 `ChatView` 形状保持不变。
- `web-ui`：显示运行失败原因并提供继续入口。
- `terminal-ui`：显示运行失败原因并提供继续入口（命令或按键）。
- `mobile-api`：会话快照携带可选的运行失败原因。
- `mobile-ui`：显示运行失败原因（不提供继续）。

## Impact

- 依赖清单：根 `package.json`、`packages/{core,gateway,tui,web}/package.json` 与 `bun.lock`；新增 `@earendil-works/pi-schema`，移除 `typebox`；传递依赖 `@earendil-works/pi-telemetry` 等同步到 1.5.0。
- Core：`runtime.ts`（视图、事件流、提交、onReport、maxTurns）、`projection.ts`（上下文占用、压缩字段映射、runFailure）、`plan.ts` / `plan-doc.ts`（原子派发）、`user-questions.ts`、`session-metadata.ts`、`context-pruning.ts`、`tool-approvals.ts`、`subagents.ts`、`config.ts`，以及全部 TypeBox 工具定义；约 31 个依赖 `viewState` 的测试改用共用测试辅助；`crash-loop.test.ts` 重写。
- Gateway：`session-host.ts`、`subagent-host.ts`、`contract.ts`、`server-services.ts`、`mobile/{protocol,admin,adapter}.ts`、`client-session.ts`（继续能力探测）。
- Web / TUI：失败原因与继续入口、对应 i18n 文案（中英同时）；移动端 Dart 契约与显示。
- 存储：默认 `~/.neko/neko.sqlite` 原地沿用；回退到 1.4 发布版不受支持，发布说明需写明。
- 文档：README、AGENTS.md。主规格在同步/归档流程更新，历史归档文档与 `reference/` 保持只读。
