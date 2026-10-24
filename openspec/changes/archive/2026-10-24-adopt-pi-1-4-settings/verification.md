# Verification

## 自动化

- `bun run check`（biome + 根/Web 客户端类型检查）通过。
- `bun run build` 通过；`bun run build:release` 与 `bun run test:package`（Pi 1.4 生产 SDK 冒烟，71 个文件）通过。
- `bun run test`：1523 pass / 0 fail（升级后基线 1519，新增 4 个用例：`context-settings` 2 个、`context-settings-runtime` 1 个、`request-identity` 1 个）。首次整套运行中 `workspace-files.test.ts` 的 "restarts a lost helper…" 失败 1 个，单独连续运行 3 次通过、整套重跑通过，判断为并行负载下按进程判断的既有时序用例，与本变更无关。

## 压缩阈值（任务 1.x）

- 单元：未设置 `triggerPercent` 时不产出 `modelOverrides`；32k / 1M / 窗口 0 的混合表在 80% 下分别得到 6 400 / 200 000 / 无覆盖；同一设置状态与窗口表返回同一覆盖对象，状态替换后重新计算。
- 运行时：两个 faux 模型（窗口 100k 与 1M），触发百分比 20：窄窗口模型两轮后压缩，宽窗口模型不压缩。旧的"取最小窗口"实现下宽窗口模型也会在 20k 处压缩，所以该用例能区分新旧行为。
- 观察：后台压缩在阻塞阈值之前 32 768 tokens 开始（`backgroundTokens` 默认值），所以小窗口模型几乎总是由后台压缩触发；选测试百分比时要避开这段提前量（10% 下 1M 模型的 67k 后台线会被含系统提示的上下文碰到）。已写入 AGENTS.md。
- 文案：TUI `context.row.compactAt.description` 中英文改为"当前模型窗口"；`rg` 在 `packages`、`apps`、AGENTS.md 中无"最小模型窗口 / smallest model window / 基准窗口"遗留。Web 与移动端没有对应措辞。

## 请求身份（任务 2.x）

- `request-identity.test.ts` 记录 provider 收到的 `options.identity`：主会话、子 agent 与会话命名共至少 4 次请求，`User-Agent` 全部匹配 `pi/<版本> (`，OpenRouter 归属头与 `PI_ATTRIBUTION` 一致且非空。
- 在未显式传入时该测试同样通过（显式值等于 Pi 默认），符合"不改变当前行为，只固定下来"。

## 未覆盖

- 未做 TUI/Web 的交互式手测（在 `/context` 里把压缩阈值设为 50）；该路径由 `context-settings-runtime` 的保存/恢复/重启用例与 TUI/Web 的设置面板测试覆盖。
- 未验证启用或停用目录 provider 后阈值不变：覆盖表只由固定的模型目录和设置状态决定，不读取启用集合，由实现保证，没有单独的运行时用例。
- 未对真实模型厂商发请求验证 UA（真实 API key 不使用）。
