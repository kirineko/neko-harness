# Proposal

## Why

升级到 Pi 1.4.0 后留下两处与新能力相关的问题。其一，压缩触发百分比目前换算成一个全局 `reserveTokens`，基准是"可选模型中最小的上下文窗口"：只要启用了一个小窗口模型，所有模型的阈值都被拉偏（例如设 80%，1M 窗口的模型要到约 99% 才压缩），而上下文裁剪（pruning）早已按会话当前模型的窗口计算，两者不一致。1.4 的 `compaction.modelOverrides` 允许按 `"provider/modelId"` 单独设阈值，正好解决。其二，Pi 1.4 的 Harness 默认以 Pi 的身份（`pi/<版本> (...)` 的 User-Agent 与 Pi 归属头）发出模型请求，部分模型厂商只认 Pi 的 UA；这一行为目前是"碰巧如此"，没有被决定、记录或测试保护，上游改默认值就会悄悄影响 neko。

## What Changes

- 压缩触发百分比改为按模型计算：对模型目录里每个已知窗口的模型写入 `modelOverrides["provider/modelId"].reserveTokens = window - floor(window × percent / 100)`，不再取最小窗口，也不再按启用集合过滤基准窗口。`enabled`、`keepRecentTokens` 仍是全局值；`triggerPercent` 未设置时不写覆盖，保持原生策略；窗口未知（0）的模型不写覆盖。
- **BREAKING（行为变化）** 设置了触发百分比后，大窗口模型会更早压缩（1M 窗口设 80% 时由约 99% 提前到 80%），小窗口模型的阈值基本不变。发布说明需写明。
- 显式声明模型请求身份：`Harness.open` 传 `identity: { userAgent: "detailed", attribution: PI_ATTRIBUTION }`，与 Pi 完全一致（`pi/<pi-ai 版本> (<平台>; <运行时>; <架构>)` 及 Pi 的 provider 归属）。这是为了兼容只认 Pi UA 的模型厂商；不改变当前实际行为，只把它固定下来并加测试保护。
- 文案同步：TUI 压缩阈值说明（`context.row.compactAt.description` 中英文）从"最小模型窗口"改为"当前模型窗口"；core 中 `triggerPercent` 的注释同步。
- 更新 AGENTS.md：删除"基准窗口只统计已启用 provider"的说法，补充按模型阈值与 identity 的约定及原因。
- 不在范围内：停放任务的界面与 `retryTask`、`onReport(error, info)` 分类上报、`afterFailedRun`（现有规格已要求失败后排队保留，等同默认 `keep`）、遥测、`IndexedDbStorage`、`wake`/`onWake`。不提升应用协议，不改 gateway 契约与移动端，不发版、不提交 git commit。

## Capabilities

### New Capabilities

无；沿用现有能力边界。

### Modified Capabilities

- `agent-runtime`：「原生上下文压缩」中"配置触发条件"场景由"取可选模型中最小上下文窗口的该百分比"改为"对每个模型取其自身上下文窗口的该百分比"；新增模型请求身份与 Pi 保持一致的要求（User-Agent 与归属）。

## Impact

- Core：`runtime.ts`（`Harness.open` 的 `settings.compaction` getter 与 `identity`）、`context-settings.ts`（`compactionPolicy` 改为产出 `modelOverrides`，注释）、对应测试 `context-settings.test.ts`，以及证明请求身份的新测试。
- TUI：`i18n/zh.ts`、`i18n/en.ts` 的一条说明；Web、移动端与 gateway 无改动（Web 设置页与阈值标记已用"当前模型"语义，仅需核对）。
- 规格：`agent-runtime`。
- 文档：AGENTS.md；发布说明记录行为变化。
- 依赖：无变化；存储：无变化。
