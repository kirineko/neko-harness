# Design

## Context

见 proposal.md。neko 对 Pi 的依赖面（1.4.0）：

- 会话视图：`NekoSession.viewState()`（Chord `AttachedReplicatedState<ConversationView>`）供 gateway `session-host` 与 `subagent-host` 投影 `ChatView`；gateway 另外用 `conversation.entries()` 分页拼完整历史，并把 `view.value.entries`（1.4 = 活动上下文）当作 `contextEntries` 计算上下文占用。`NekoSession.events()` 包了 `watchEvents()`，只有示例与测试使用。
- 提交监听：core / gateway 共 11 处 `harness.subscribeCommits`，按 `change.type === "document"` 与 `change.value?.…` 判断；`user-questions.ts` 用 `watchDoc` 并判断 `end.reason`；`tool-approvals.ts` 用 `documentState`。
- Schema：全部用 TypeBox（`gateway/contract.ts` 356 处、`mobile/protocol.ts` 249 处，加 core 工具参数），`web-search` 从 pi-ai 导入 `Type`。
- 计划派发：`plans.decide()` 提交决定，随后 `dispatchPlan()` 经 `submitTo()` 另一次提交执行输入，再 `markDispatched()`；启动时 `undispatched()` 补发。

## Goals / Non-Goals

**Goals:**

- 类型检查、测试与构建在 1.5.0 全部通过；线上 `ChatView` 与移动协议形状只增不改，应用协议与移动 API 版本不变。
- 仓库内不再有 `typebox` 依赖与导入。

**Non-Goals:**

- 不把 `ChatView` 改为窗口，不改变前端历史加载方式；不重构投影的全量重算。
- 排队项改引导仍为"撤回 + 重新受理"（1.5 没有事务内撤回）。
- 不采用按会话的压缩设置、只读 Harness、`afterRun`、`beforeProviderRequest`、Chord v2。

## Decisions

### D1. 依赖一致升级，先升后修

所有 `@earendil-works/*` 精确锁 `1.5.0`，新增 `@earendil-works/pi-schema@1.5.0`（core、gateway 及根包按实际导入添加），删除根包与 gateway 的 `typebox`。以 `tsc`（`bun run check`）驱动修复，确认依赖图无重复 Pi 包。与前几次升级相同，只升发布版，不取 main。

### D2. 视图：`Conversation.watch()` + `ConversationTranscript`，core 提供"完整视图跟随器"

core 删除 `NekoSession.viewState()` / `events()`，新增 `NekoSession.follow()`：返回 `{ value: ConversationView（entries = 完整历史）, subscribe(fn), close() }`。实现：`conversation.watch(context)` 取窗口，`ConversationTranscript`（loader = `conversation.entries()`）`merge` 每个值；打开时循环 `loadEarlier` 直到没有 `earlier`，每次合并后对所有 `gap` 调 `fillGap`，再把 `items` 中的条目拼回 `ConversationView.entries`。watch 监听器是串行的，异步补缺口期间到达的提交被折叠成下一次回调，不会乱序。gateway `openProjection` 与 `subagent-host` 改用它，删除手写的 history Map 与首屏分页；`entry(id)` 读取从跟随器取。

替代方案：保留 history Map，只在 `before` 大于已知最大 id 时补页——等于重写 `ConversationTranscript`，且容易漏掉溢出替换的缺口，不采用。另一替代是 Chord `replicatedState` 自建适配——1.5 Durable 已不用它，不采用。

### D3. 上下文占用按完整历史计算，不调用 `Conversation.context()`

`contextTokens` 只需要"最新 head marker（压缩或重置）之后最新一次成功回答的用量"。1.5 完整历史按 id 排序且 head marker 留在原位，结果与 1.4 活动上下文相同；把 `pi.reset` 也算作边界，覆盖"重置后尚无回答"的情况。删除 `projectChatView` 的 `contextEntries` 选项。避免每次投影都构建一次模型上下文。

### D4. `pi.live` 字段映射保持线上形状

压缩状态：`ChatView.compaction.active[].reason` / `failure.reason` 由 `trigger` 映射，契约不变。新增 `ChatView.runFailure?: { reason, detail? }`（`detail` 截断到 `RUN_FAILURE_DETAIL_CHARS = 500`），由 `live.runFailure` 投影，`run !== undefined` 时不下发。原因代码作为开放字符串透传（契约用字符串而非封闭枚举，未来 Pi 新增原因不破坏旧客户端），前端映射到本地化文案，未知代码原样显示。`core-ui-strings.json` 补原因代码清单，三端字典测试对账。

### D5. "继续"操作

core `NekoSession.continue()`：经 `admit` 串行，`syncAgent` → `guardProvider` → 读取 `pi.live`：`run !== undefined` 抛 `CONTINUE_BUSY:`，无 `runFailure` 抛 `CONTINUE_UNAVAILABLE:`，否则 `submit({ type: "continue" })`；`ConversationBusy` 竞争同样映射为 `CONTINUE_BUSY:`。前缀常量与错误映射沿用 `PLAN_BUSY` 的模式。gateway `NekoChat.continueRun`（新增方法，返回 `null`）。能力探测：新网关的 `ChatView` 始终带 `continuable: true`，缺省 = 旧网关（`runFailure` 本身在无失败时也缺省，不能用来探测）；前端用 `continueClient`（`client-session.ts`，`CONTINUE_UNSUPPORTED`）沿用 jobs / queue 的可选扩展模式。移动端只读 `runFailure`。TUI 命令名 `/continue` 加入 `protected-terms.json`。

### D6. 计划决定原子派发

`PlanService.decide` 增加在调用方事务中执行的变体：`respondPlan` 在 `admit` 内先做所有异步准备（`guardProvider`、资源快照 `loadResources` + `resourceSnapshots.stage`、组装提示与 `InputData`），然后一次 `harness.commit`：`conversation.submit(tx, executeDraft)`（在任何表写之前）→ 写 `PlanDoc` 决定并置 `dispatched: true` → 批准时 `configure(tx, id, agentChangeFor(normal…))`。事务失败则丢弃暂存快照，计划保持待批准。`submitTo` 的预处理抽成 `prepareInput()` 供两条路径共用，`supersedePending`、`touchConversation`、`metadata.reconcile` 在提交后执行。启动修复 `undispatched()` 保留，只处理 1.4 遗留数据。

替代方案：保留 `dispatched` 补发——这正是 1.5 要消除的补偿逻辑，不采用。

### D7. 标记形状迁移

- `subscribeCommits(fn)` → `observeCommits({ advance: (publication) => …, end: () => {} })`，返回值 `.detach()`；文档变化判断加 `change.kind === "change"`，retire 用 `kind === "retire"`。
- `watchDoc` 监听：`start(async (call) => { if (call.kind === "value") … })`，用 `call.retired` 代替 null 值；结束用 `end.kind`。
- `documentState` → `snapshot` + `observeCommits`（tool-approvals 现有模式）。
- `onReport(report)`：`NekoRuntimeOptions.onReport` 保持 `(error: unknown) => void` 的宿主错误通道；runtime 传给 `Harness.open` 一个适配器，把 Pi 的 `Report` 转为 `report.error`（无 error 的报告用其 `kind` 构造 `Error`）后调用它。core 自报错误仍直接调用该通道。
- `SubmissionRecord` 收窄加 `type === "input"`。

### D8. 崩溃到限

不再有停放与 `retryTask`；保持 `restartLimit` 默认 5。`crash-loop.test.ts` 改为验证：模拟崩溃截断达到上限后，运行以 `runFailure.reason === "restart_limit"` 结束、会话空闲、`onReport` 收到一次 `task_interrupted`。AGENTS.md「崩溃停放」改为「崩溃到限结束」。

### D9. 轮次上限

配置文件新增顶层 `maxTurns`（正整数，`config.ts` 校验，非法值启动报错），经 `NekoRuntimeOptions.maxTurns` 传入；创建主会话（`harness.root` 初始 agent、`createConversation`、`forkConversation` 不改）与子 agent 子会话时写入 `AgentState.maxTurns`（任务拥有的子会话本就继承，但子 agent 由 neko 显式创建，需显式设置）。已有会话不回填。

### D10. TypeBox → pi-schema

- Chord 契约：`Type.Object(p)` → `obj(p, { open: true })`（保持 JSON 与指纹），`Type.String/Integer/Number/Boolean/Null/Array/Union/Optional/Literal/Unknown` → `str/int/num/bool/nul/arr/union/opt/lit/unknown`，`Type.Enum([...])` → `oneOf([...])`；`Static` 从 pi-schema 导入。`contract()` / `rpc()` 元组封装改用 pi-schema 的 `Schema` 类型。
- 工具参数：与契约同一规则，保持 1.4 的 JSON：原开放对象写 `obj(…, { open: true })`，原 `additionalProperties: false` 的保持封闭；原 `Type.String({ enum })` 改用 pi-ai 的 `StringEnum`（仍是 `{ type: "string", enum }`，部分 provider 不接受无 `type` 的枚举），`subagent-schema.test.ts` 对拍。
- 移动协议：`Check(schema, value)` → `compile(schema).check(value)`，编译结果按 schema 缓存（模块级常量），避免每条消息重编译。
- 测试中的 `Type` 一并替换。

## Risks / Trade-offs

- [pi-schema `obj` 默认封闭，可能拒绝此前接受的多余字段] → 契约与工具参数都按原 JSON 迁移：原开放的写 `{ open: true }`，原封闭的保持封闭。
- [`ConversationTranscript` 首屏 `loadEarlier` 循环对超长会话的开销] → 与现有首屏全量分页同阶；页大小用 200。
- [`observeCommits` 只收到已落盘提交，流式部分提交延迟最多 1 秒] → neko 的提交监听只用于"文档 / 子会话变化后重投影"，流式内容走 watch；重投影触发不依赖部分提交。逐处确认，必要时改为 `watchDoc`。
- [`pi.live` v3 等写入后不可回退到 1.4] → 发布说明写明；不清库。
- [失败原因代码随 Pi 增长] → 开放字符串 + 未知原样显示。
- [原子派发要求 `submit(tx)` 在任何表写之前] → 在事务回调第一行调用；`ReadAfterWrite` 由测试覆盖。

## Migration Plan

1. 基线：1.4.0 上 `bun run check` / `bun run test` 结果记录。
2. 升依赖与 lock，`bun install --frozen-lockfile` 验证无重复 Pi 包。
3. 以 `tsc` 驱动：D10 schema、D7 标记形状、D2/D3/D4 视图，再补 D5、D6、D8、D9 与前端。
4. 全量 check / test / build；手测 `neko tui`、`neko web`、`neko serve`，用 1.4 创建的存储原地打开验证恢复。
5. 更新 README、AGENTS.md。回滚：恢复依赖清单、lock 与代码；已被 1.5 写入的存储不能被 1.4 读取，回滚前需备份 `neko.sqlite`。
