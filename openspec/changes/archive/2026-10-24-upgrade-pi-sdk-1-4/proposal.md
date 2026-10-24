# Proposal

## Why

neko-harness 仍锁定 Pi 1.3.0，而 Pi 1.4.0 已发布到 npm（`reference/pi` 已同步，含 `v1.4.0` 标签）。1.4.0 的破坏性变更集中在 pi-durable：`TaskRuntime.sleep()` 被删除（core 有两处在用）、所有文档定义必须显式声明 `checkpointWhen`（core 有 20 处）、任务新增 `sleeping` 状态与崩溃循环停放。继续停留在 1.3 会错过 durable 睡眠、压缩与重试修复，并拖大后续升级成本。

## What Changes

- 将根包与 `packages/{core,gateway,tui,web}` 实际使用的 chord、pi-ai、pi-durable、pi-tui、pi-env 精确锁定到 npm 发布的 `1.4.0`，更新 `bun.lock`；`v1.4.0` 之后 `main` 的额外提交不纳入本次升级。
- **BREAKING** 适配 pi-durable 1.4：
  - `defineDoc()` 的每处定义补显式 `checkpointWhen`；保持现有"普通改动存为增量"语义，不借此改变快照策略；
  - `TaskRuntime.sleep()` 已删除：命名任务的等待改为阶段末尾的 `sleepUntil`，子 agent 准入的槽位轮询改为不落盘的阶段内定时等待；
  - 确认测试替身与工具包装满足 `TaskRuntime`、`ToolExecutionApi` 的新成员（`sleepUntil`、`setTimer`、`now`），以及对 `TaskState` 的穷举处理新增的 `sleeping`。
- **BREAKING** SQLite 存储打开时自动迁移到 schema v2，迁移后 1.3 及更早版本不能再打开，无法回退到 0.5.x。现有本地会话数据按可丢弃处理：实施时定向清理旧存储，以 1.4 新建的数据为唯一基线，不做迁移验证。
- 接受崩溃循环停放：同一任务连续 5 次被崩溃截断且未提交新状态时被停放，经 `onReport` 以 `task_parked` 报告一次。本次只保持现有 `onReport` → `onError` 通道，不新增界面入口。
- 复核 chord 1.4（`Context.telemetry`）、pi-ai 1.4（默认 User-Agent、`telemetry` 请求选项重命名、`resolveTranscriptTools` 签名）、pi-tui 1.4（退出恢复终端模式、CJK 加粗修复）的影响；core/gateway 不直接使用被改动的 API，预期只需验证。
- 保持范围克制：不采用 `compaction.modelOverrides`、`HarnessOptions.identity`、`afterFailedRun`、遥测、`retryTask` 入口、`IndexedDbStorage`、`wake`/`onWake` 等新能力，留待后续单独变更。
- 更新 README、AGENTS.md 的 SDK 版本与使用要点；不发版、不提交 git commit。

## Capabilities

### New Capabilities

无；沿用现有能力边界。

### Modified Capabilities

- `agent-runtime`：恢复保证的 SDK 基线更新为 Pi 1.4.0（1.3 及更早会话数据可清理，不提供跨版本兼容）；增加崩溃循环任务被停放后不会无限重启、并被报告的要求。其余规格里的 "Pi 1.3.0" 能力基线措辞是否同步，见 design 的 Open Questions。

## Impact

- 依赖清单：根 `package.json`、`packages/{core,gateway,tui,web}/package.json` 与 `bun.lock`；传递依赖 `@earendil-works/pi-telemetry` 同步到 1.4.0。
- Core：`session-metadata.ts`（命名任务的等待）、`subagents.ts`（准入轮询与 4 处文档定义）、`runtime.ts`（8 处）、`todos.ts`、`user-questions.ts`、`plan-doc.ts`、`tool-approvals.ts`、`jobs.ts` 的文档定义，以及对应测试。
- Gateway / TUI / Web：预期无源码改动，只做类型检查与回归；移动端协议不受影响。
- 存储：默认 `~/.neko/neko.sqlite` 升级为 schema v2，旧数据清理；凭据、配置、serverId、技能、移动配对与工作区文件不动。
- 文档：README、AGENTS.md。主规格在后续同步/归档流程更新，历史归档文档与 `reference/` 保持只读。
- 本阶段只产出规划工件，不修改代码或依赖，不删除数据。
