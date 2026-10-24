# Tasks

## 1. 按模型的压缩阈值

- [x] 1.1 先写失败测试（`packages/core/test/context-settings.test.ts`）：`triggerPercent` 未设置时 `compactionPolicy` 不产出 `modelOverrides`；设置后混合窗口（如 32k 与 1M，百分比 80）各得 `reserveTokens = window - floor(window × 80 / 100)`；窗口为 0 的模型不写覆盖；`enabled`、`keepRecentTokens` 仍只在来源非 default 时写入全局策略；同一 `contextState` 两次取值返回同一覆盖表对象（design D1–D3）。验证：这些用例在实现前失败。
- [x] 1.2 改 `context-settings.ts` 的 `compactionPolicy`：入参改为模型窗口表（`provider/modelId` → `contextWindow`），产出 `{ enabled?, keepRecentTokens?, modelOverrides? }`，不再写全局 `reserveTokens`，同步 `triggerPercent` 注释；改 `runtime.ts` 的 `settings.compaction` getter：用 `allModels()` 全目录构造窗口表，按 `contextState` 引用缓存，删除"只统计已启用 provider"的过滤与旧注释（design D1–D3）。验证：1.1 的用例通过，`bun run check` 无类型错误。
- [x] 1.3 补端到端验证（`packages/core/test`）：用窗口不同的两个 faux 模型，设置触发百分比后断言各自的阻塞压缩阈值（上下文超过自身窗口百分比才压缩），并断言启用或停用其他 provider 不改变阈值；未设置百分比时行为与默认一致。验证：新增用例通过，既有压缩相关测试（`compaction`、`context-settings`、`context-pruning`）全部通过。
- [x] 1.4 同步文案与文档：TUI `context.row.compactAt.description` 的中英文改为"当前模型窗口"（`packages/tui/src/i18n/{zh,en}.ts`）；核对 Web 设置页与阈值标记、移动端无"最小窗口"措辞；AGENTS.md 删除"自动压缩 triggerPercent 的基准窗口只统计已启用 provider 的模型"并改写为按模型阈值。验证：`rg "最小模型窗口|smallest model window|最小窗口"` 在 `packages`、`apps`、`AGENTS.md` 中无遗留，TUI/Web 的字典对拍与 CJK 扫描测试通过。

## 2. 显式 Pi 请求身份

- [x] 2.1 先写身份测试（`packages/core/test`）：用包装 faux provider 的替身记录每次请求的 `options.identity`；断言 `formatUserAgent(identity)` 以 `pi/` 开头，`getAttributionHeaders` 对 OpenRouter 目标返回 Pi 的名称与 URL；覆盖主会话、会话命名与子 agent 三类请求入口（design D5）。验证：测试在当前代码上记录实际行为；若某入口未经 Harness 的 models 则在此暴露并修正。
- [x] 2.2 在 `runtime.ts` 的 `Harness.open` 显式传 `identity: { userAgent: "detailed", attribution: PI_ATTRIBUTION }`（常量取自 `@earendil-works/pi-ai/utils/identity`，不复制内容，design D4）。验证：2.1 的测试通过；断言所用身份与未显式传入时一致，请求内容未变。
- [x] 2.3 在 AGENTS.md 的 Pi 1.4 要点记录：请求身份刻意沿用 Pi（部分厂商只认 Pi 的 UA），升级 Pi 时身份测试失败需显式更新。验证：文档与规格「模型请求身份与 Pi 一致」措辞一致。

## 3. 验收

- [x] 3.1 全量验证：`bun run check`、`bun run test`、`bun run build` 通过；手测一次：用 `neko tui` 或 Web 在 `/context` 设置压缩阈值 50，确认设置保存后无报错且说明文字已为"当前模型窗口"；在变更目录写入 `verification.md`（含测试数与手测结果），不提交 git commit、不发版。

## Workflow follow-up

- 归档本变更并同步主规格 `agent-runtime`（MODIFIED「原生上下文压缩」、ADDED「模型请求身份与 Pi 一致」）。
- 发布说明写明：设置压缩触发百分比后，大窗口模型会更早压缩（按各自窗口计算）；请求身份仍为 Pi 的 UA 与归属。
- 停放任务的界面与 `retryTask`、`onReport` 分类上报、遥测等另开后续变更。
