# Design

## Context

见 proposal 的 Why。当前状态（已核对源码与 1.4.0 已安装类型）：

- `runtime.ts` 的 `Harness.open` 里，`settings.compaction` 是 getter，每次取值调用 `compactionPolicy(contextState, windows)`；`windows` 是已启用 provider 的模型窗口，`reserveTokens = min(windows) - floor(min(windows) × percent / 100)`。结果是一个全局策略。
- pi-durable 1.4 的 `CompactionSettings.modelOverrides` 以精确的 `"provider/modelId"` 为键、按字段覆盖全局策略；解析函数 `compactionPolicy(settings, model)` 逐字段 `override ?? policy`。`HarnessSettings` 说明 settings "read at every resolution and never copied; getters are fine"，且是同步读取，有的读取在 Session 线上。
- `allModels()` 已缓存整个目录（含代码注入的 faux provider），其中每项有 `provider`、`modelId`、`contextWindow`。
- 上下文裁剪已经取会话当前模型窗口计算（`runtime.ts` 的 `settings` 回调），压缩是唯一用全局最小窗口的地方。
- Harness 默认身份是 `DEFAULT_HARNESS_IDENTITY = { attribution: PI_ATTRIBUTION }`，并经 `mergeClientIdentity(DEFAULT, options.identity)` 作用到 `api.models`；provider 的 `stream` 收到的 `options.identity` 是合并后的结果。neko 没有传 `identity`，现在靠默认值得到 Pi 的 UA 与归属。

约束：以已安装的 1.4.0 类型为准；core 只做薄封装；不提升应用协议；`reference/` 与历史归档只读。

## Goals / Non-Goals

**Goals:**

- 触发百分比对每个模型都等于"该模型窗口的百分比"，不受启用集合和其他模型影响。
- 把"沿用 Pi 身份"变成显式声明加测试，上游默认值变化时升级验证会发现。

**Non-Goals:**

- 不改变 `enabled`、`keepRecentTokens` 的语义（仍全局），不引入按模型的用户设置或新的设置界面。
- 不改变 `triggerPercent` 未设置时的行为（保持原生策略，不传任何覆盖）。
- 不做自定义 UA，不新增 neko 自己的归属信息。
- 不涉及停放任务、`onReport` 分类、`afterFailedRun`、遥测。

## Decisions

### D1. 覆盖表覆盖整个模型目录，不再按启用集合过滤

`modelOverrides` 对 `allModels()` 里每个窗口大于 0 的模型写一项 `reserveTokens`。目录是静态的，且会话可能仍使用已被取消启用的 provider 的模型（保存的默认模型、已有会话），这些会话也应按自身窗口计算；过滤启用集合只是为了避免"最小窗口被拉偏"，改为按模型后不再需要，启用或停用 provider 因此不再改变任何阈值。全局 `reserveTokens` 不再写入（沿用原生值作为未登记模型的回落）。备选：只覆盖已启用 provider 的模型——否，会让取消启用的 provider 上的会话回到原生阈值，行为随启用状态抖动，且需要在启停时失效缓存。

### D2. 只在设置了 `triggerPercent` 时产出覆盖，并按 `contextState` 缓存

`compactionPolicy` 的签名改为接收模型窗口表（`provider/modelId` → `contextWindow`），返回 `{ enabled?, keepRecentTokens?, modelOverrides? }`。`triggerPercent` 为 null（来源 default）时不返回 `modelOverrides`，保证"两者都未设置时行为与默认完全一致"。覆盖表较大（目录规模），getter 每次读取都会被调用，因此以 `contextState` 的引用为键缓存最近一次结果：`contextState` 在保存或恢复设置时被整体替换，缓存自然失效。覆盖表本身不依赖启用集合，所以启停 provider 不需要失效。备选：每次读取重算——否，目录大、读取频繁。备选：只给当前会话模型算——否，settings 是 Harness 级且同步，拿不到会话模型。

### D3. 其余压缩字段保持全局

`enabled` 与 `keepRecentTokens` 仍按"来源不是 default 才传"写入全局策略。`backgroundTokens` 不动：它是相对阻塞阈值的"提前量"，阻塞阈值按模型变化后后台压缩随之移动，仍遵循原生策略。覆盖项只含 `reserveTokens`，其余字段逐字段回落到全局。

### D4. 显式声明 Pi 身份，不做自定义

`Harness.open` 传 `identity: { userAgent: "detailed", attribution: PI_ATTRIBUTION }`（从 `@earendil-works/pi-ai/utils/identity` 取常量）。当前这就是默认值，所以请求内容不变；意义是把决定固定下来。`PI_ATTRIBUTION` 是上游导出的常量，随版本升级自动跟随，不在 neko 内复制其内容。属性 `version` 不设置，沿用 pi-ai 版本，保持与 Pi 的 UA 逐字一致。备选：自定义 `{ custom }` 的 UA——否，部分厂商只认 Pi 的 UA。备选：`attribution: null`——可行，但用户要求"完全一致"，且归属头只影响 OpenRouter、NVIDIA、OpenCode 的统计，保留。

### D5. 身份测试通过 provider 观察 `options.identity`

自定义 provider 的 `stream` 会收到合并后的 `options.identity`。测试用一个包装 faux provider 的测试替身记录每次请求的 `options.identity`，以 `formatUserAgent(identity)` 断言以 `pi/` 开头、`getAttributionHeaders` 对 OpenRouter 目标含 Pi 的名称与 URL。覆盖主会话、子 agent 与会话命名三类请求入口（均走 `api.models`/`models`）。若某入口不经 Harness 的 models（例如直接用未包装的 `models`），测试会暴露，实施时按结果修正。

### D6. 文案与文档同步

TUI 的 `context.row.compactAt.description` 中英文改为"当前模型窗口"；`context-settings.ts` 里 `triggerPercent` 注释同步；AGENTS.md 删除"基准窗口只统计已启用 provider"并补充 D1/D4。Web 设置页与阈值标记已按"当前模型"展示（`?? 98` 为原生近似值，不变），实施时核对即可，无需改动。

## Risks / Trade-offs

- [大窗口模型更早压缩，用户升级后可能觉得"突然压缩变多"] → 仅影响设置了触发百分比的用户；发布说明明确写出，并给出 1M 窗口 80% 的例子。
- [覆盖表体积大，getter 频繁读取导致性能或内存问题] → D2 的按 `contextState` 缓存；测试断言同一状态两次读取返回同一对象。
- [目录里 `contextWindow` 异常（0、负数）的模型] → 不写覆盖，保持原生阈值；测试覆盖。
- [`reserveTokens` 超过窗口或为负] → 百分比限制在 1–99，`window - floor(window × p / 100)` 恒在 `(0, window)` 内。
- [身份测试依赖上游内部合并行为] → 只断言 provider 实际收到的 `options.identity`，这正是线上发出请求的来源；上游变化时测试失败即提示显式更新声明（规格的"上游默认值变化"场景）。
- [归属头使 OpenRouter 等统计把 neko 流量算在 Pi 名下] → 已知并接受；若日后要脱钩，把 `attribution` 改 `null` 即可，UA 不受影响。

## Migration Plan

1. 先写失败测试：混合窗口的覆盖表、未设置时不产出覆盖、缓存、身份。
2. 改 `compactionPolicy` 与 `runtime.ts` 的 getter；加 `identity`。
3. 同步 TUI 文案、core 注释、AGENTS.md；跑 `bun run check`、`bun run test`。
4. 手测：用 faux 窗口表或真实小窗口模型验证阈值（见 tasks），确认默认不设百分比时行为不变。
5. 回滚：还原 `compactionPolicy` 与 getter 即可，无存储或协议变化。

## Open Questions

- 发布说明里是否单列"压缩触发行为变化"一节，留到发版时决定，不影响本变更范围。
