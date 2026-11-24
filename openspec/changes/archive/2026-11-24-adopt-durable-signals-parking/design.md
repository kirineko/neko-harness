# Design

## Context

动机见 `proposal.md - Why`。当前仓库已锁定 `@earendil-works/pi-durable@1.6.0` 与 Chord v2（`APPLICATION_PROTOCOL = 11`），投影层（`packages/core/src/projection.ts`）与嵌套变更包装（`packages/core/src/nested-changes.ts`）也已识别任务的 `sleeping` / `waiting` 状态与 `ToolPark` 返回值，但 `packages/core` 四处核心状态机仍保留 `1.5` 时代的等待实现：

1. `user-questions.ts`：`ask_user.execute` 在内存 `Map<string, Set<() => void>>` 上挂起 `Promise`，由构造函数注册的全局 `task` `onCommits` 监听兜底取消。
2. `tool-approvals.ts`：`beforeTool` 仅做前置登记，`wrapTool(createBashTool())` 内通过 `approvals.wait()` 在内存中阻塞，同样依赖全局 `task` `onCommits` 监听取消。
3. `plan.ts`：`submit_plan` 使用 `{ control: { terminate: true } }` 结束当前轮并使会话回到空闲待批，但 `PlanService.submit` 在队列中已有用户输入时先提交 `awaiting_approval`，再在第二笔提交中调用 `supersedePending` 改写为 `superseded`。
4. `subagents.ts`：父 `subagent` 工具调用 `api.waitForTask` 在内存挂起；`RoundTask` 的 `admission` 阶段以 `100ms` `runtime.setTimer` 循环轮询 `SlotsDoc`；`deliver` 阶段以 `submission.wait(ctx)` 长时占用活跃任务 invocation。

在 `pi-durable@1.6.0` 调度器（`scheduler.js`）中，唯有 `status === "running"` 的任务在宿主未正常 `close()` 重开时累加 `record.restarts`（达到 `restartLimit = 5` 即强制中断/失败）；而处于 `sleeping`（等待信号或时钟）或 `waiting`（等待子任务终态）的任务不持有活跃 invocation（`#invocations.size === 0`），异常退出重开不会增加 `restarts`，且 `keepsChildren(record)` 在 `checkpoint.phase === "call" | "parked"` 期间保留子任务与子会话生命周期。

## Goals / Non-Goals

**Goals:**
- 将 `ask_user`、`explore` 工具审批、`subagent` 父工具等待、`RoundTask` 提交结算等待与并发槽位准入全部切换为 `pi-durable@1.6.0` 原生持久信号与停放状态机，等待期间零活跃 invocation、零定时轮询。
- 移除 `UserQuestions` 与 `ToolApprovals` 的内存 `.wait()` 方法及高频全局 `task` `onCommits` 监听，以确定性取消钩子与按需事务对账替代。
- 将 `PlanService.submit` 的排队用户输入覆盖判定收拢进单次原子提交，同时完整保留 `plan-mode` 空闲待批语义。
- 保持网关契约（`APPLICATION_PROTOCOL = 11`）、三端视图投影（`ChatView`、`SessionSummary`、`SubagentView`）及既有 `1.6.0` SQLite 存储完全兼容。

**Non-Goals:**
- 不将 `submit_plan` 改为停放工具（停放会使待批期间 `pi.live.run` 保持运行态，破坏空闲退出 `plan` 模式与普通输入直接覆盖待批计划的既有规格）。
- 不修改 `packages/gateway`、`packages/tui`、`packages/web`、`apps/mobile` 的线上协议或 UI 交互。
- 不引入 `@earendil-works/pi-durable/images/fit`、按会话压缩覆盖或 Codemode 多命名空间。

## Decisions

### D1：`ask_user` 工具级信号停放与 `cancel` 钩子收敛（`user-questions.ts`）

- **方案**：
  - 使用 `defineSignal` 声明 `QuestionAnsweredSignal`（名称 `"app.neko.question-settled"`，版本 `1`，载荷 `{ status: "answered" | "skipped" | "cancelled" }`）。
  - `ask_user`（`replay: "safe"`、`executionMode: "sequential"`、`callers: ["model"]`）执行分两段：
    - 首次进入（`api.wake === undefined`）：校验参数与主会话角色，在单次 `api.commit` 内幂等创建或复用 `QuestionDoc`（key = `String(api.taskId)`）及 `QuestionsDoc.pending`（维持单会话最多 8 条未决上限与题目一致性核验），调用 `api.details(questionDetails(record), context)` 持久化初始详情。若记录已是终态（重放或停放前已抢先结算），直接返回工具结果；若仍为 `pending`，返回 `{ sleep: { signals: [QuestionAnsweredSignal.key(String(record.version))] } }`。
    - 唤醒进入（`api.wake !== undefined`）：读取当前 `QuestionDoc` 快照（若意外仍为 `pending` 则走一次 `reconcile` 兜底），按 `answered` / `skipped` / `cancelled` 返回 `{ output, structuredOutput, details, isError: record.status === "cancelled" }`。
  - `UserQuestions.respond` 在单次 `harness.commit` 内完成身份/版本/选项校验、`live(tx, id)` 存活核查、文档状态落盘，并在非 `cancelled`（或首次结算）时调用 `await tx.signal(Number(id) as TaskId, QuestionAnsweredSignal, String(settled.version), { status: settled.status })`。根据 `signals.js` 的 memo 语义，即使 `tx.signal` 先于工具 `{ sleep }` 提交落盘，未消费 memo 也会在 `sleepWake` 时立即唤醒任务，无信号丢失竞态。
  - 实现 `ToolRegistration.cancel(args, api, context)`：当已停放（或正提交停放）的 `ask_user` 被中止时，通过 `api.commit` 将仍为 `pending` 的 `QuestionDoc` 置为 `cancelled`、移出 `QuestionsDoc.pending` 并递增 `revision`，同时调用 `api.details` 写回取消态结构化详情，保证中止后的工具历史卡片同样具备完整 `details`。
- **备选方案与取舍**：
  - *保留 `wait()` 供单测使用*：会保留一套生产代码不再经过的内存通知分支；直接移除并让单测通过真实工具任务或状态查询验证，能确保测试与生产走同一持久路径。

### D2：工具审批采用 `beforeTool` 门禁停放 + `wrapTool` 执行端二次核验（`tool-approvals.ts`）

```
  ToolTask (explore bash)
    |
    v
  [phase: "call"] ---> beforeTool (neko-tool-approvals)
                         |-- status === "pending"
                         |     --> return { sleep: [ApprovalSignal.key(version)] }
                         |         (reopen / registry.install wakes gate without
                         |          consuming memo -> re-runs beforeTool -> sleeps again)
                         |-- status === "denied" | "cancelled"
                         |     --> return { block: "Command denied or cancelled..." }
                         +-- status === "allowed"
                               --> return undefined (pass gate)
                                     |
                                     v
                               [phase: "execute"] (replay: "unsafe")
                                     |
                                     v
                               wrapTool(createBashTool())
                                 --> verify allowed + command + timeout + canonical cwd
                                 --> execute inner bash once (crash => interrupted)
```

- **方案**：
  - 使用 `defineSignal` 声明 `ApprovalSignal`（名称 `"app.neko.tool-approval-settled"`，版本 `1`，载荷 `{ status: "allowed" | "denied" | "cancelled" }`）。
  - **在 `beforeTool` 门禁停放而非 `wrapTool` 内停放**：`pi-durable` 的 `wrapTool`（`parks.js` `BASE_PARKS`）禁止外层包装器凭空合成内层工具未返回的 `ToolPark`（否则报 `invalid_park`），而内置 `createBashTool()` 只返回直接结果；相反，`hook(ToolTask, { beforeTool })` 原生支持返回 `{ sleep }`（`parkAtGate`，记录保持 `checkpoint: { phase: "call" }`）。
  - **门禁重跑幂等性**：处于 `phase: "call"` 停放的任务在 `Harness.open` 或 `registry.install` 时会被调度器 `#wakeGate` 唤醒并从头重跑 `beforeTool`，但 `#wakeGate` **不会消费**信号 memo。因此 `beforeTool` 调用 `approvals.ensure(...)` 读回同一 `pending` 条目并再次返回 `{ sleep: { signals: [ApprovalSignal.key(String(item.version))] } }` 时，因该信号键从未被消费，可通过 `checkSleep` 校验并平滑回到 `sleeping` 状态。
  - **执行期不重跑保证**：一旦 `decide(..., "allow")` 写入 `allowed` 并投递 `ApprovalSignal`，任务唤醒重跑 `beforeTool` 返回 `undefined`，穿过后续 `beforeTool` 钩子后提交 `phase: "execute"` 意图并进入 `wrapTool(createBashTool())`。内层校验 `item.status === "allowed"` 及命令、超时、规范化 `cwd` 未被后续钩子篡改后启动命令；因 `createBashTool()` 为 `replay: "unsafe"`，此阶段若宿主崩溃重开将直接恢复为 `interrupted`，绝不自动重复执行。

### D3：`plan` 保持 `terminate` 空闲待批并单事务收口排队覆盖（`plan.ts`）

- **方案**：
  - 维持 `submit_plan` 返回 `{ output, details, control: { terminate: true } }`，不改为信号停放：待批期间会话必须处于 `idle`（`pi.live.run === undefined`），使用户无需先发 `abort` 即可调用 `planMode("normal")`（「取消并退出计划模式」），且普通聊天输入能立即触发新一轮并将待批计划置为 `superseded`。
  - 在 `PlanService.submit` 的单次 `harness.commit(async (tx) => ...)` 内同步读取 `const inbox = await tx.doc(InboxDoc, id)`：若 `inbox.items.some((item) => queuedUserInput(item))` 为真，直接将新创建的 `PlanItem` 以 `status: "superseded"`、`settledAt: now` 写入 `PlanDoc` 并返回该记录，删除提交后再二次调用 `supersedePending` 的步骤。
- **备选方案与取舍**：
  - *让 `submit_plan` 停放等待 `PlanDecidedSignal`*：会导致待批期间会话 `status === "running"`，不仅与 `plan-mode` 规格中空闲切换模式和普通消息直接覆盖的要求冲突，还会破坏 `PlanService.decideWith` 在同一事务内原子切换 agent 配置并提交 `plan-exec:<version>` 输入的设计。

### D4：`subagent` 三层持久停放与无轮询槽位调度（`subagents.ts`）

```
  Parent ToolTask (subagent)
    |-- wake === undefined: create/resume child + Delegation + RoundTask(runnerId)
    |                       report initial api.details(...)
    |                       return { wait: { on: [runnerId], policy: "allSettled", checkpoint } }
    +-- wake !== undefined: api.getTask(runnerId) -> format terminal round result

  RoundTask (runnerId)
    |-- phase "admission":
    |     tx: prune terminal/aborted holders & waiters in SlotsDoc
    |         |-- slot acquired -> DelegationsDoc="running" -> phase "deliver"
    |         +-- full -> upsert SlotsDoc.waiters (wakeSeq + 1)
    |                  -> { status: "sleeping", signals: [SlotWakeSignal.key(String(wakeSeq))] }
    |-- phase "deliver":
    |     child.submit({ ..., requestId: "subagent:<taskId>", notify: { taskId, key: "round:<taskId>" } })
    |     placed.status settled?
    |       |-- yes -> { status: "running", checkpoint: { phase: "settle" } }
    |       +-- no  -> { status: "sleeping", checkpoint: { phase: "settle" },
    |                    signals: [SubmissionSettled.key("round:<taskId>")] }
    +-- phase "settle":
          readSignal(SubmissionSettled) (fallback submission.status for legacy checkpoints)
          ensure child idle -> tx: finish Delegation + release slot + signal eligible waiters
```

- **方案**：
  1. **父 `subagent` 工具等待子轮次**：首次执行完成参数校验、`guard`、子会话与 `RoundTask` 落盘及初始 `api.details` 上报后，返回 `{ wait: { on: [round.runnerId as TaskId], policy: "allSettled", checkpoint } }` 进入 `waiting` 态；若重放时 `RoundTask` 已终态或经 `allSettled` 唤醒，通过 `api.getTask(runnerId, context)` 读取终态产出组装返回结果。
  2. **`RoundTask` 等待子会话本轮提交结算**：`deliver` 阶段向 `child.submit` 传入 `notify: { taskId: runtime.taskId, key: "round:" + String(input.taskId) }`。提交后立即检查 `submission.status(ctx)`（记录 `inputEntryId`）：若已处于 `done` / `unanswered`，直接推进到 `settle`；否则返回 `sleeping` 等待内置 `SubmissionSettled`（`pi.submission-settled`）。进入 `settle` 后读取 `runtime.readSignal(SubmissionSettled, ...)`（对升级前无信号记录的遗留检查点回退 `submission.status(ctx)`），短暂确认 `child.waitForIdle(ctx)` 收尾后在同一事务中写终态、清理 `activeRoundId` 并释放槽位。
  3. **无轮询并发槽位队列（`SlotsDoc` + `SlotWakeSignal`）**：
     - 定义 `SlotWakeSignal`（`"app.neko.subagent-slot"`，版本 `1`，载荷 `{ seq: number }`）。
     - 在 `SlotsDoc`（`app.neko.subagent-slots`）上新增可选字段 `waiters?: { runnerId: number; taskId: number; parentId: number; cwd: string; coder: boolean; wakeSeq: number }[]`（缺省视为空数组，兼容旧存储）。
     - 满额（同主会话活跃 `>= 3` 或同规范化 `cwd` 已有活跃 `coder`）时，在 `admission` 事务内清理已终态/已请求中止的 `items` 与 `waiters`，将该 `runnerId` 的 `wakeSeq` 自增 `1` 写入 `waiters`，并停放于 `SlotWakeSignal.key(String(wakeSeq))`。每次睡眠使用递增 `wakeSeq` 可保证即使一次唤醒后因竞争再次满额回睡，新信号键也从未被消费，完全满足 `pi-durable` 单键单次睡眠约束。
     - 槽位释放路径（`RoundTask` 的 `deliver` 失败、`settle` 正常结束、`abort` 钩子，以及 `installSubagentCoordinator` 的启动与意外任务终态兜底）统一在同一事务中从 `SlotsDoc.items` 移除该轮占用，按 `waiters` 队列顺序扫描在模拟腾出容量后可准入的等待者并投递 `tx.signal(waiter.runnerId as TaskId, SlotWakeSignal, String(waiter.wakeSeq), { seq: waiter.wakeSeq })`。

### D5：移除内存 `.wait()` 与全局 `task` `onCommits`，统一确定性取消对账

- **方案**：
  - 删除 `UserQuestions.prototype.wait()` 与 `ToolApprovals.prototype.wait()`，以及两者构造函数中对每次任务表提交都会触发的全局 `onCommits` 监听。
  - 取消与失效对账由四道确定性防线闭环：
    1. **任务级取消钩子**：`ask_user.cancel` 在工具中止时立即结算 `QuestionDoc` / `QuestionsDoc`；`RoundTask.abort`（单轮 `subagent.stop` 与主会话 `abort` 均会经过）在中止子会话后于同一父会话提交内将该轮关联的 `pending` `ApprovalsDoc` 置为 `cancelled`，保证网关观察者经 `app.neko.questions` / `app.neko.approvals` 文档变更即时刷新 UI。
    2. **会话级显式中止兜底**：`NekoSession.abort()` 在 `await target.abort(context)` 后同步调用 `questions.reconcile(target.id)`、`approvals.reconcile(target.id)` 与既有的 `plans.cancelPending(target.id)`，覆盖工具在落盘文档后、进入 `parked` 前极窄微任务窗口内被中止的边界。
    3. **启动一次性对账**：`createNekoRuntime` 启动时执行 `questions.reconcileAll()` 与 `approvals.reconcileAll()`，清理异常退出遗留的死任务未决项。
    4. **读写事务内 `live(tx)` 自愈**：保留 `list()`、`get()`、`respond()`、`decide()` 事务内的 `live(tx)` 检查，确保迟到请求或拉取投影时始终以任务真实存活链为准。

## Risks / Trade-offs

- **[Risk] `beforeTool` 门禁停放期间宿主重开或扩展热安装重跑钩子导致重复创建审批或信号冲突** → `ToolApprovals.ensure` 按调用 `taskId` 幂等返回既有 `pending` 记录与同一 `version`，且 `#wakeGate` 不消费信号 memo，重新返回相同 `ApprovalSignal.key(String(version))` 安全通过 `checkSleep`。
- **[Risk] 多个排队 `RoundTask` 同时被唤醒但仅部分抢到槽位，未抢到者再次睡眠触发已消费信号键错误** → 每个等待者在每次回睡前在事务内递增自身 `wakeSeq` 并睡眠在全新的 `SlotWakeSignal.key(String(wakeSeq))` 上，彻底消除重复消费同一键的可能。
- **[Risk] 移除全局 `task` `onCommits` 后，单测或前端观察者在停止运行瞬间读到短暂未取消的审批/问题** → `ask_user.cancel`、`RoundTask.abort` 与 `NekoSession.abort()` 均在 `abort` 调用返回前同步提交 `QuestionsDoc` / `ApprovalsDoc` 变更，网关 `session-host` 与 `subagent-host` 监听这两个文档立即推送更新。
- **[Risk] 既有测试直接调用 `runtime.questions.wait()` / `runtime.approvals.wait()` 或拦截 `subagent` 首次 `execute` 返回值模拟检查点崩溃** → 在测试任务中同步迁移 `user-questions.test.ts`、`tool-approvals.test.ts` 与 `subagent-recovery.test.ts`，改为基于持久状态观察、门禁钩子及裸存储重开（含 `restarts` 注入）验证真实停放恢复路径。

## Migration Plan

1. 本变更仅涉及 `@neko-harness/core` 内部任务/工具状态机与可选文档字段（`SlotsDoc.waiters`），无需变更 `APPLICATION_PROTOCOL`（保持 `11`），无需改动网关、TUI、Web 与移动端。
2. 既有 Pi `1.6.0` SQLite 存储原地打开即可工作：启动对账清理任何旧版遗留的失效未决记录；升级前若恰好存在处于旧版检查点的活跃 `RoundTask`，`settle` 阶段对无 `SubmissionSettled` 信号的记录回退读取 `submission.status(ctx)` 平滑收敛。
3. 回滚边界与 Pi `1.6.0` 基线一致：新增信号记录写入 `1.6` 既有的 `signals` 表，同版本内可直接回滚代码并在启动时由 `reconcileAll` 自愈。
