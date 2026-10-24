# Tasks

## 1. 基线与依赖

- [x] 1.1 在 Pi 1.3.0 上运行 `bun run check` 与 `bun run test` 记录基线；验证基线结果已写入 `verification.md`。
- [x] 1.2 将根与 `packages/{core,gateway,tui,web}` 实际使用的 chord、pi-ai、pi-durable、pi-tui、pi-env 精确升至 1.4.0，更新 `bun.lock`；验证 `bun install --frozen-lockfile` 成功、依赖图中每个 Pi 包只有一份 1.4.0（含传递依赖 `@earendil-works/pi-telemetry`）、typebox 仍为 1.3.27。

## 2. 文档定义与类型适配

- [x] 2.1 为全部 `defineDoc`/`defineDocFamily` 补 `checkpointWhen: () => false`（`runtime.ts`、`subagents.ts`、`todos.ts`、`user-questions.ts`、`plan-doc.ts`、`tool-approvals.ts`、`session-metadata.ts`、`jobs.ts`，共 20 处，design D2）；验证 `rg` 统计的定义数与补充数一致，`tsc` 无相关错误，既有 core 测试通过且存储形态不变（普通改动仍为增量）。
- [x] 2.2 按 `tsc` 错误清单处理其余 1.4 类型变化：`TaskState` 新增 `sleeping`、`TaskRuntime`/`ToolExecutionApi` 新成员对测试替身与工具包装的影响、`ToolControl.terminate` 类型（design D5、D8）；验证根与 Web 客户端类型检查（`bun run check`）通过，不为未触及的包添加无用改动。

## 3. 睡眠迁移

- [x] 3.1 迁移命名任务（`session-metadata.ts`）：`wait` 阶段改为 `runtime.sleepUntil(until, { phase: "generate", attempt: 0 }, context)`，去掉其后的单独 commit（design D3）；补测试：睡眠到期后生成一次标题，睡眠期间重启后仍按原到期时间继续且只生成一次；验证 `session-naming` 相关测试与新增用例通过。
- [x] 3.2 迁移子 agent 准入（`subagents.ts`）：槽位轮询改为可被 `runtime.signal` 取消的 `runtime.setTimer` 100 ms 等待，循环体保持幂等（design D4）；补测试：槽位释放后排队的子 agent 开始运行、等待期间中止或关闭不遗留任务与定时器；验证 `subagents`、`subagent-recovery` 测试与新增用例通过。
- [x] 3.3 补崩溃循环停放测试：同一任务连续崩溃达到上限后不再自动运行并经 `onReport` 报告一次，其他会话可用；未达上限时提交新状态后计数重置（design D6）；验证新增用例覆盖两个 spec 场景并通过。

## 4. 其他包的行为复核

- [x] 4.1 复核 pi-ai 1.4：确认无代码依赖旧 User-Agent 格式或 `telemetryContext`，DeepSeek 能力目录与思考强度映射断言仍成立；验证 `providers`、`pi-1-3`（按需更名为版本中性）等相关测试通过。
- [x] 4.2 复核 pi-tui 1.4 的退出恢复终端模式：`neko tui` 正常退出、Ctrl+C 退出与异常退出后终端状态正确，且与 TUI 自有清理不重复写出或抛错；验证 TUI 测试通过并在本机手测一次。

## 5. 文档、数据清理与验收

- [x] 5.1 更新 AGENTS.md（项目简介与"Pi 1.3 使用要点"改为 1.4：睡眠用 `sleepUntil`/`setTimer`、`checkpointWhen` 必填、崩溃停放、SQLite v2 不可回退，其余 1.3 要点保持）、README 与 `docs` 中出现的 SDK 版本；验证不再把 1.3 API 描述为当前行为，`reference/` 与历史归档无修改。
- [x] 5.2 全量验证：`bun run check`、`bun run test`、`bun run build` 通过；手测 `bun run neko tui|web|serve`；在变更目录写入 `verification.md`，不提交 git commit、不发版。
- [x] 5.3 验证通过后按 design D7 清理：解析当前实例 storagePath，停止持有该存储的网关，只删除 `neko.sqlite` 及 `-wal`/`-shm` 和遗留 socket/port；再以 1.4 新建会话并重启，验证会话可恢复，凭据、配置、serverId、技能、移动配对与工作区文件均未删除，且未加入启动自动删库逻辑。

## Workflow follow-up

- 归档本变更并同步主规格 `agent-runtime`；其余规格里 "Pi 1.3.0" 能力基线措辞在归档同步时统一处理（design Open Questions）。
- 发布说明中写明"升级后数据库不可回退到 0.5.x"以及崩溃停放的已知行为。
- 新能力（`modelOverrides`、`identity`、`afterFailedRun`、停放任务的 UI 与 `retryTask`、遥测）另开后续变更。
