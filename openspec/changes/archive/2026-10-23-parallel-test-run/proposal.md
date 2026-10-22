# Proposal

## Why

`bun run test` 约 85 秒（1515 个测试、230 个文件），但所有用例自报耗时合计约 76 秒、用户态 CPU 约 60 秒，而且是单进程顺序执行；开发机有 14 核。上一批（`trim-test-suite`）把真实等待压下去之后，墙钟已经由「顺序执行」而不是单个慢用例决定：1300 个快用例合计只有约 18 秒，≥ 1s 的用例只有 8 个。

Bun 1.4.2 自带 `bun test --parallel`（多 worker 进程跑文件，隐含 `--isolate`）。实测同一批 1515 个测试：`--parallel`（默认 14 worker）约 13s，`--parallel=4`（模拟 CI 低核机）约 22s，各连续 3 次 / 2 次全部通过。

## What Changes

- **默认并行**：根 `package.json` 的 `test` 脚本改为 `bun test --conditions=neko-source --parallel`；新增 `test:serial`（原 `--isolate` 顺序执行）用于排查隔离或时序问题。CI 与发布流水线继续调用 `bun run test`，不改 workflow。
- **文档**：`AGENTS.md` 常用命令补充 `test` 为并行、`test:serial` 为顺序回退。
- **去掉三处写死的真实等待**（覆盖不减；串行回退与低核机器受益）：
  - `FileCredentialStore` 的锁获取重试（100 次 × 25ms，「新锁不被回收」用例等满约 2.6s）：构造增加可选的锁重试参数，默认值不变。
  - `stdin-shutdown` 的「不带 flag 时 stdin 关闭不退出」负向等待 2s：改为足以证明「没有退出」的更短窗口。
  - `job-engine` 的「启动窗口之后自行结束并排队回报」用例里的 `sleep 1.5`：配合已有 `timings.jobStartWindowMs` 缩短。

不做：跨端（Web / TUI / 移动端）提问、计划面板的用例合并（各端用例分别是各端 spec scenario 的唯一证据，已从范围划掉）；不抽取各端测试样板；不拆分 `gateway` 包做分片；不改任何生产默认数值；不改应用协议；不动 `openspec/specs`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本变更只调整测试运行方式与内部可注入的时长选项，不改变任何用户可见行为，也不改变生产默认值；`.openspec.yaml` 设置 `skip_specs: true`。

## Impact

- 构建与脚本：根 `package.json`（`test`、`test:serial`）、`AGENTS.md`。
- 代码（行为不变）：`packages/core/src/credentials.ts`（可选锁重试参数，不进入 CLI 参数与配置文件）。
- 测试：`packages/core/test/credentials.test.ts`、`packages/core/test/job-engine.test.ts`、`packages/gateway/test/stdin-shutdown.test.ts`。
- 预期结果：`bun run test` 全部通过，墙钟较基线（84.6s）下降 ≥ 80%（实测约 13s）；`test:serial` 同样全部通过；测试数不减少。
- 协议与依赖：无应用协议、Dart 契约、依赖变更。
