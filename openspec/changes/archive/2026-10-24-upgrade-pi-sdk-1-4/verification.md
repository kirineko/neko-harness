# 实施与验证记录

日期：2026-10-24。仓库与打包产物均使用 Pi 1.4.0（chord、pi-ai、pi-durable、pi-env、pi-tui 精确锁定）；Bun 1.4.4；typebox 仍为 1.3.27。未提交、未发版、未同步主规格或归档。

## 基线与结果

- 1.3.0 基线：`bun run check` 通过，`bun run test` 1515 pass / 0 fail（230 个文件）。
- 1.4.0：`bun run check` 通过，`bun run build` 通过，`bun run test` 1519 pass / 0 fail（231 个文件；新增 4 个用例）。
- `bun install --frozen-lockfile` 通过；依赖图中每个 Pi 包只有一份 1.4.0（含传递依赖 `pi-codemode`、`pi-telemetry`）。
- `bun run build:release` + `bun run test:package`：生产 tarball 安装后 SDK 冒烟通过，随包 pi-env 守护进程版本为 1.4.0（`package-sdk-smoke.mjs` 的版本断言与提示已更新）。

## 迁移要点

- `defineDoc` / `defineDocFamily`：共 20 处（proposal 初稿误写 21，已更正）统一补 `checkpointWhen: () => false`，与 1.3 缺省（从不写基线）等价。
- `TaskRuntime.sleep()` 两处迁移：命名任务 `wait` 阶段改为 `runtime.sleepUntil(until, { phase: "generate", attempt: 0 }, ctx)`；子 agent 准入轮询改为 `pause()`（`runtime.setTimer` 加 `runtime.signal`，不落盘）。
- 除上述外 `tsc` 无其他报错：没有自实现的 `Context`、`TaskRuntime`、`ToolExecutionApi`，没有穷举任务状态的代码，`ToolControl.terminate: true` 与新类型兼容。
- `pi-1-3.test.ts` 改名为 `pi-upstream.test.ts` 并去掉版本措辞。
- 发布包 1.4.0 的 `Storage.commit(writes, context)` 只有两个参数，而 reference main 上的签名已不同；测试以已安装类型为准。

## 新增测试

- `session-naming.test.ts`：命名重试睡眠期间重启，按原到期时间继续，只再请求一次标题。
- `subagents.test.ts`：子 agent 等待槽位时关闭运行时，在时限内关闭，且不产生报告。
- `crash-loop.test.ts`：任务被崩溃截断 5 次后被停放，`onReport` 只报告一次、不再发起请求，其他会话照常可用；未达上限时正常重启，提交新状态后 `restarts` 清零。

## 行为复核

- pi-ai：代码中没有对旧 User-Agent 格式、`telemetryContext`、`resolveTranscriptTools` 的依赖；`providers`、`provider-settings`、`pi-upstream` 全部通过。
- pi-tui：1.4 的退出恢复处理器在 `start()` 注册、`stop()` 移除。PTY 手测 `neko tui`：`/exit` 与 Ctrl+C 均以状态 0 退出，bracketed paste 关闭与 kitty 键盘协议弹出序列各只出现一次，无重复写出。

## 手动验证

- `bun run neko serve`：Unix socket 与 WebSocket 同时可用，从已迁移到 schema v2 的存储读到 8 个既有会话，错误 serverId 被拒绝（`GatewayIdentityError`）。
- `bun run neko web --no-open`：复用运行中的网关，首页与 `/api/local/session` 返回 200。
- 清理：`~/.neko/neko.sqlite`（打开时已被 1.4 迁到 v2，无 `-wal`/`-shm`，无进程占用）已删除；`credentials.json`、`gateway-server-id`、`mobile/`、`tui.json`、`update-check.json` 保留。新启动的 `neko serve` 创建 1.4 存储与根会话，再新建一个会话，优雅停止后重启，两个会话均恢复。未加入启动自动删库逻辑。
- 未做：Windows 与真实手机端配对（无对应环境）；浏览器中完整交互（仅验证静态页面与本机会话接口，Web 逻辑由自动化测试覆盖）；真实模型调用（未使用 API Key）。

## 已知行为变化

- SQLite 存储升到 schema v2 后不可回退到 1.3 及更早版本（0.5.x）。
- 崩溃循环（连续 5 次）的任务被停放，只经 `onReport`/`onError` 报告一次，本变更不提供恢复入口。
