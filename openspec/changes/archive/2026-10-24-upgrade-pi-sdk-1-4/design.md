# Design

## Context

见 proposal 的 Why。当前锁定 1.3.0。已确认的 1.4.0 变化（来自 `reference/pi` 的 `v1.4.0` 标签与各包 CHANGELOG）：

```
pi-durable  BREAKING：删除 TaskRuntime.sleep；defineDoc/defineDocFamily 必须有 checkpointWhen；
            任务新增 sleeping 状态；SQLite 自动迁到 schema v2（不可回退）；崩溃 5 次后停放任务；
            TaskRuntime 增 sleepUntil/setTimer，ToolExecutionApi 增 now；ToolControl.terminate 改为 boolean
            新增：遥测、IndexedDbStorage、compaction.modelOverrides、HarnessOptions.identity/setTimer/onWake、
                  afterFailedRun、onReport(error, info)、retryTask
chord       BREAKING：自实现 Context 必须带 telemetry；新增 chord/sqlite、chord/telemetry-sqlite
pi-ai       BREAKING：telemetryContext→telemetry；默认 User-Agent 格式变化；resolveTranscriptTools 签名
pi-env      仅版本号
pi-tui      修复：退出时恢复终端模式、CJK 加粗、$$ 数学块吞表格、@ 补全转义
```

neko-harness 实际触及的只有 durable：20 处 `defineDoc`（core 的 8 个文件）、2 处 `runtime.sleep`（`session-metadata.ts:130`、`subagents.ts:355`）。gateway、tui、web 不直接使用被改动的 API；没有自实现的 `Context`、`TaskRuntime`、`ToolExecutionApi`（`wrapTool` 通过上游包装，`agent-file-search.ts` 只引用类型）。

约束：全部精确锁版本；core/gateway 只做薄封装，不为上游裹代码（AGENTS.md）；`reference/` 与历史归档只读；现有本地数据为可丢弃测试数据。

## Goals / Non-Goals

**Goals**

- 全部包一致升到 1.4.0，类型检查、构建、测试与 TUI/Web/mobile 端到端行为与升级前一致。
- 把两处 `sleep` 迁到 1.4 的原生写法，并为全部文档定义显式声明 `checkpointWhen`。

**Non-Goals**

- 不采用 `compaction.modelOverrides`、`HarnessOptions.identity`、`afterFailedRun`、遥测、`retryTask` 入口、`IndexedDbStorage`、`wake`/`onWake`；这些进入后续变更，本次不改变产品行为、mobile API 或 UI。
- 不引入 `v1.4.0` 之后 main 上的提交。

## Decisions

### D1. 依赖一致升级，先升后修

根与各 workspace 的 chord、pi-ai、pi-durable、pi-tui、pi-env 同时精确锁 1.4.0，`bun install --frozen-lockfile` 后以 1.4.0 已安装类型为准（AGENTS.md 约定），用 `tsc` 错误清单驱动迁移。pi-durable、pi-env 对 chord 为精确同版本依赖，不能分包升级。传递依赖 `@earendil-works/pi-telemetry` 同步到 1.4.0，确认依赖图里每个 Pi 包只有一份，typebox 仍为 1.3.27（上游同样精确锁在 1.3.27）。

### D2. `checkpointWhen` 一律 `() => false`

1.3 缺省（未提供）等价于从不写完整基线，所有改动存为增量。20 处定义统一补 `checkpointWhen: () => false`，行为与存储形态保持不变。不按文档种类调整策略：没有度量数据表明增量重放成为瓶颈，快照策略放到有数据的后续变更。备选：为 `latest` 历史的小文档写 `() => true`——否，会改变存储写入量，且超出本次范围。

### D3. 命名任务：`sleepUntil` 替代阶段内等待

`app.neko.name` 的 `wait` 阶段原来是 `runtime.sleep(until)` 后再提交进入 `generate`。迁移为在 `wait` 阶段直接 `runtime.sleepUntil(until, { phase: "generate", attempt: 0 }, context)`，不再单独 commit：睡眠本身落盘 checkpoint，到点后从 `generate` 恢复。重启中途睡眠的任务由 durable 按 Harness 时钟恢复，不再重跑 `wait`。`initial` 状态与 `until = Date.now() + 100` 不变。

### D4. 子 agent 准入：阶段内定时等待，不落盘

`app.neko.subagent-round` 的 `admission` 阶段在没有槽位时每 100 ms 轮询一次。上游的建议是睡眠结束阶段，但这里每次轮询落一次盘不划算，槽位释放是进程内事件：用 `runtime.setTimer` 做一个可被 `runtime.signal` 取消的 100 ms 等待，循环体本身已经幂等（`acquireSlot` 在事务里判定，`admitted` 在重跑时重算）。取消路径：阶段取消时清除定时器并以 `runtime.signal.reason` 拒绝，与 `session-metadata.ts` 现有的等待写法一致。备选：`sleepUntil(now + 100, { phase: "admission" })`——否，每轮一次提交，且排队深度大时放大写入；备选：槽位释放时主动唤醒——否，是更大的重构，属于后续优化。

### D5. 新增 `sleeping` 状态与测试替身

neko 内没有穷举 `TaskState`/`TaskGraphState`/`TaskInspection` 的代码；以 `tsc` 为准，若出现再加 `sleeping` 分支。测试里手搭的 `TaskRuntime`/`ToolExecutionApi`（若有）补 `sleepUntil`、`setTimer`、`now`。`ToolControl.terminate: true`（`plan.ts`）与新的 `boolean` 类型兼容，不改。

### D6. 崩溃循环停放：接受默认值，只验证报告

`settings.restartLimit` 默认 5：同一任务被崩溃连续截断 5 次且未提交新状态即停放。本次保持默认，不关闭也不调整。`onReport` 保持单参数回调（上游向后兼容）；`runtime.ts` 现有的 `onReport → onError` 通道会收到 `task_parked` 报告，补一个测试证明停放任务不会无限重启、且报告恰好一次。UI 展示与 `Harness.retryTask` 入口留到后续变更。

### D7. 存储迁移：清空而不迁移

SQLite 打开即迁到 schema v2 且不可回退。现有数据按测试数据丢弃，因此不做迁移验证，也不加入"启动自动删库"。升级验证通过后沿用 1.3 的做法：解析当前实例的 storagePath，停止持有存储的网关，只删除 `neko.sqlite` 及 `-wal`/`-shm`，保留凭据、配置、serverId、技能、移动配对与工作区文件，再用 1.4 新建会话验证重启恢复，包括命名任务睡眠中重启。发布说明需写明"不可回退到 0.5.x"。

### D8. 其余 API 变更只验证

- pi-ai：未使用 `telemetryContext`、`getPiUserAgent`、`resolveTranscriptTools`。默认 User-Agent 变化影响 DeepSeek 请求头，只需确认无依赖旧格式的断言。
- chord：没有自实现 `Context`，`BACKGROUND_CONTEXT` 已带 no-op telemetry。
- pi-tui：退出时同步恢复终端模式，与 neko TUI 自己的退出清理叠加，需确认不会重复写出转义序列或在 `exit` 事件里抛错。

## Risks / Trade-offs

- [`runtime.sleep` 的语义是阶段内等待，迁移后重启行为不同] → D3 的睡眠状态由 durable 恢复；补用例：命名任务在睡眠期间重启后仍生成标题且只生成一次。
- [准入轮询改用 `setTimer` 后取消不干净，遗留定时器] → 监听 `runtime.signal`，取消时清除并拒绝；补测试：等待槽位期间中止/关闭，不遗留任务与定时器。
- [20 处 `checkpointWhen` 机械修改，容易漏写] → 以 `tsc` 为准；再用 grep 核对 `defineDoc`/`defineDocFamily` 数量一致。
- [停放任务静默卡住，用户无处恢复] → 已报告一次到 `onError`；在发布说明与 design 中记为已知行为变化，恢复入口放后续变更。
- [SQLite v2 不可回退] → 接受；发布说明明确。
- [后续 main 修复未纳入] → 与前几次升级相同策略，只升发布版。

## Migration Plan

1. 基线：在 1.3.0 上跑 `bun run check` 与 `bun run test` 并记录结果。
2. 修改依赖清单并更新 `bun.lock`，`bun install --frozen-lockfile` 验证，确认依赖图无重复 Pi 包。
3. 以 `tsc` 驱动：补 `checkpointWhen`（D2），迁移两处 `sleep`（D3、D4），处理 `sleeping` 与测试替身（D5）。
4. 补 D6、D3、D4 的测试，跑全量 check/test/build；手测 `neko tui`、`neko web`、`neko serve` 与退出时终端状态。
5. 更新 README、AGENTS.md（"Pi 1.3 使用要点"一节改为 1.4，补睡眠、`checkpointWhen`、停放）。
6. 验证通过后按 D7 清理旧存储，再以 1.4 新建会话验证重启恢复。回滚：恢复依赖清单与 lock 到 1.3.0 并撤销代码迁移；已迁到 v2 或清理后的存储按测试数据处理。

## Open Questions

- 主规格里其余写死 "Pi 1.3.0" 能力基线的措辞（`model-providers` 的能力列表与 provider 目录、`web-ui` 的模型选择器等）是否随本次一并改成 1.4.0。这只影响规格文字，不影响实现范围与任务拆分；默认只改 `agent-runtime`，其余在归档同步时统一处理。
