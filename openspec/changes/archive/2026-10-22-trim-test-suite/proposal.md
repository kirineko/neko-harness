# Proposal

## Why

`bun run test` 约 165 秒（1397 个测试、209 个文件），但用户态 CPU 只有约 51 秒：26 个耗时 ≥ 1 秒的测试占了约 110 秒，几乎全是真实等待（固定 `Bun.sleep`、被测代码里的硬编码超时、任务启动窗口）。慢测试拖累每次本地验证与 CI，却没有换来额外覆盖。同时少量测试只验证上游 Pi 自身行为，与「只升版本不裹代码」的约定不符，维护成本高于价值。

## What Changes

- **去真实等待（覆盖不减）**：让几个被测代码里的硬编码时长可以在构造/运行时选项中注入，默认值保持不变，测试传小值：
  - 会话命名：单次请求超时 20s × 2 次尝试（测试靠 `Bun.sleep(43_000)` 等待）。
  - 文件搜索截止时间 `SEARCH_LIMITS.timeoutMs`（10s）。
  - 网关就绪超时（`client-session.ts` 的 `deadline`，5s）。
  - 后台任务启动窗口 `JOB_LIMITS.startWindowMs`（2s，12 个以上用例及 jobs/interactions e2e 各等满一次）。
  - compaction 原生重试退避（约 2s，`retry` 用例）。
  - 测试里无谓的固定 sleep（TUI jobs 面板 1.1s 等）改为轮询条件。
- **合并同构用例**：仅合并模板完全一致、只换参数的用例（表驱动），失败信息仍能定位到具体参数；不为减少数量而合并语义不同的用例。compaction 的 failure/cancel/retry/overflow 已是参数化循环，不在此列。
- **删除只测上游的用例**：`pi-1-3.test.ts` 中直接调用 Pi `transformMessages` 的用例、`providers.test.ts` 中只验证 Pi `createModels().refresh` 的前半段。保留经由 neko 运行时的断言，保留 `provider-settings` 与 Pi `checkAuth` 的对账等契约测试。
- 记录改动前后的耗时与测试数，作为验收依据。

不做：跨端（Web / TUI / 移动端）提问、计划等面板的 UI 去重（另开变更，需先做「行为 × 端」矩阵并对照 spec）；不改任何生产默认数值（含 `JOB_LIMITS`）；不改应用协议；不删除对应 spec scenario 唯一证据的测试；不动 `openspec/specs`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本变更只调整测试与内部可注入的时长选项，不改变任何用户可见行为，也不改变生产默认值；`.openspec.yaml` 设置 `skip_specs: true`。

## Impact

- 代码（行为不变）：`packages/core/src/session-metadata.ts`、`agent-file-search.ts`、`job-engine.ts`（`JobManager` 构造）、`runtime.ts`（把内部选项传到命名与任务管理）、`compaction` 相关重试配置的注入点；`packages/gateway/src/client-session.ts` 的就绪超时。新增选项仅供内部与测试使用，不进入 CLI 参数与配置文件。
- 测试：`session-naming`、`agent-file-search`、`client-session`、`job-engine`、`jobs-e2e`、`interactions-e2e`、`compaction`、`tui/jobs-ui`、`pi-1-3`、`providers` 等；移动端 Dart 测试不在本批。
- 预期结果：`bun run test` 全部通过，墙钟较基线下降 ≥ 50%（实测约 165s → 约 79s）；测试数量小幅减少。
- 协议与依赖：无应用协议、Dart 契约、依赖变更。
