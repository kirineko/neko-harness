# Proposal

## Why

在完成 Pi SDK `1.6.0` 与 Chord v2 升级后，`packages/core` 中的四类交互与子任务等待机制（`ask_user` 用户提问、`explore` 工具审批、`subagent` 委派等待与并发槽位准入）仍沿用 `1.5` 时期的内存挂起 `Promise`、高频全局 `task` `onCommits` 监听与 `100ms` 定时轮询：等待期间任务长期处于 `running` 态占用活跃 invocation，进程若在人工等待或长子任务执行期间多次异常退出重开，每次重开都会累加 `restarts` 直至误触 `restartLimit` 中断等待；同时 `PlanService.submit` 在队列中已有用户输入时仍分两次提交（先写入 `awaiting_approval` 再改写 `superseded`），存在短暂中间状态窗口。基于已落地的 `@earendil-works/pi-durable@1.6.0` 原生持久信号（`defineSignal`、`SubmissionSettled`）与工具/任务停放原语（`ToolPark`、`sleeping` / `waiting`）统一收敛上述状态机，可以在零线上协议变更的前提下释放常驻内存等待、消除轮询并强化跨崩溃恢复边界。

## What Changes

- 重构 `ask_user` 提问等待（`packages/core/src/user-questions.ts`、`packages/core/src/runtime.ts`）：
  - 定义持久信号 `QuestionAnsweredSignal`（`app.neko.question-settled` v1），工具首次进入落盘 `QuestionDoc` 与 `QuestionsDoc.pending` 并上报初始 `details` 后返回 `{ sleep: { signals } }` 进入持久停放，释放活跃 invocation；唤醒后读取已结算记录直接返回结构化结果。
  - `UserQuestions.respond` 在单次 `harness.commit` 内完成身份/版本校验、`live(tx)` 核查、状态结算与 `tx.signal` 投递。
  - 移除仅内部单测使用的内存 `UserQuestions.prototype.wait()` 与构造函数中的全局 `task` `onCommits` 监听，改由 `ask_user` 工具 `cancel` 钩子、`NekoSession.abort()` 显式对账、启动 `reconcileAll()` 与读写事务内 `live(tx)` 覆盖取消与恢复路径。
- 重构工具执行审批等待（`packages/core/src/tool-approvals.ts`、`packages/core/src/runtime.ts`、`packages/core/src/subagents.ts`）：
  - 定义持久信号 `ApprovalSignal`（`app.neko.tool-approval-settled` v1）；在 `neko-tool-approvals` 扩展的 `hook(ToolTask, { beforeTool })` 中对 `pending` 审批返回 `{ sleep: { signals } }` 停放（重开或扩展重装经门禁重跑时信号未消费，幂等保持停放），对 `denied` / `cancelled` 返回 `{ block }`，对 `allowed` 放行。
  - 保留 `wrapTool(createBashTool())` 在执行端对 `allowed` 状态、命令、超时与规范化 `cwd` 的二次核验，维持 `bash` 的 `replay: "unsafe"` 执行中断不重跑边界。
  - `ToolApprovals.decide` 在单次 `harness.commit` 内更新 `ApprovalsDoc` 并发送 `tx.signal`；移除内存 `ToolApprovals.prototype.wait()` 与全局 `task` `onCommits` 监听，通过 `RoundTask.abort`、`NekoSession.abort()`、启动对账及 `list` / `decide` 的 `live(tx)` 及时收敛失效未决审批。
- 收口 `plan` 提交与排队覆盖原子性（`packages/core/src/plan.ts`）：
  - 保持 `submit_plan` 返回 `{ control: { terminate: true } }` 使待批准期间会话回到空闲，维持取消退出计划模式、普通消息覆盖、`PlanService.decideWith` 单事务派发、三层只读护栏及旧版 `undispatched` 启动补发不变。
  - 在 `PlanService.submit` 的同一次 `harness.commit` 内读取 `InboxDoc`，若已有排队用户输入则直接创建并结算为 `superseded`，消除先落盘 `awaiting_approval` 再二次提交改写 `superseded` 的窗口。
- 重构 `subagent` 委派等待、轮次结算与并发准入（`packages/core/src/subagents.ts`）：
  - 父 `subagent` 工具落盘子会话、身份、委派记录与 `RoundTask` 并上报初始 `details` 后返回 `{ wait: { on: [runnerId], policy: "allSettled", checkpoint } }`，唤醒后经 `api.getTask` 读取终态拼装结果，移除内存 `api.waitForTask`。
  - `RoundTask` 的 `deliver` 阶段向 `child.submit` 传入 `notify` 并在未即时结算时进入 `sleeping` 等待内置 `SubmissionSettled`（`pi.submission-settled`）信号转入 `settle` 阶段，移除长时 `submission.wait(ctx)`。
  - 定义 `SlotWakeSignal`（`app.neko.subagent-slot` v1），在 `SlotsDoc` 中增加向后兼容的可选 `waiters` 队列（含单调递增 `wakeSeq`）；满额时 `sleeping` 等待对应信号，槽位释放（终态、异常、`abort` 及启动清理）时在同一事务内移除占用并 `tx.signal` 唤醒可准入等待者，移除 `100ms` 定时轮询。
- 更新 `packages/core` 相关单测与崩溃恢复测试，同步修订 `AGENTS.md` 中关于原生 Signals 与 Tool Parking 留待后续变更的说明；网关与应用层协议（`APPLICATION_PROTOCOL = 11`）及三端代码无需改动。

## Capabilities

### New Capabilities

无；沿用现有能力边界。

### Modified Capabilities

- `user-questions`: 明确 `ask_user` 在等待用户回答期间以持久停放态运行，即使进程连续多次异常退出并重开也不会消耗任务重启配额或中断未决提问。
- `tool-approvals`: 明确待审批命令在等待用户决定期间以门禁持久停放态运行，连续多次进程异常退出并重开不会消耗任务重启配额或误判中断，且与进入执行阶段后的中断不重跑边界保持严格区分。
- `plan-mode`: 明确 `submit_plan` 在会话收件箱已存在排队用户输入时，于单次持久提交内直接生成已结算的 `superseded` 版本，不暴露短暂的 `awaiting_approval` 中间态。
- `subagents`: 明确主会话委派等待、子会话轮次等待与并发配额排队均采用持久停放与信号唤醒，等待期间连续多次进程异常退出并重开不会消耗任务重启配额而误断等待。

## Impact

- Core：`packages/core/src/{user-questions,tool-approvals,plan,subagents,runtime}.ts`。
- 测试：`packages/core/test/{user-questions,tool-approvals,plan,subagents,subagent-recovery}.test.ts`（适配移除 `.wait()` 后的内部接口并补充跨多次异常崩溃重启的停放恢复验证）。
- 网关与前端：`packages/gateway`、`packages/tui`、`packages/web`、`apps/mobile` 无协议或契约破坏性变更（投影层已将 `sleeping` / `waiting` 映射为 `"running"`，会话与子任务视图行为完全一致）。
- 存储兼容：新增信号名与 `SlotsDoc.waiters` 可选字段向前兼容既有 `1.6.0` SQLite 存储，原地打开无需迁移清理。
- 文档：更新 `AGENTS.md` 中「Pi 1.6 使用要点」的内部实现说明。
