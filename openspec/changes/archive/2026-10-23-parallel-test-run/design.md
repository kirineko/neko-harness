# Design

## Context

动机与范围见 proposal.md。基线（改动前，同一台 14 核机器，HEAD `2d1b20c`）：`bun run test`（`bun test --conditions=neko-source --isolate`）1515 个测试、230 个文件、13311 次 `expect()`、墙钟 84.6s（用户态 CPU 约 60s）。用例自报耗时合计约 76s，其中 ≥ 1s 的 8 个用例 16s，≥ 100ms 的 184 个用例 58s，其余约 1300 个用例合计约 18s；也就是说瓶颈是「单进程顺序」，不是某几个用例。

按包拆开并行试跑的耗时（各包用例数之和与全量一致）：

| 包 | 文件 | 用例 | 耗时 |
| --- | --- | --- | --- |
| cli | 4 | 14 | 4s |
| tui | 47 | 347 | 7s |
| web | 54 | 377 | 9s |
| core | 68 | 417 | 27s |
| gateway | 57 | 360 | 38s |

Bun 1.4.2 的 `bun test --parallel[=N]`：用 N 个 worker 进程分发测试文件（默认 CPU 核数），隐含 `--isolate`；另有 `--shard`、`--timings`/`--update-timings`（按历史耗时让最慢的文件先跑）。试跑结果：

| 方式 | 墙钟 | 结果 |
| --- | --- | --- |
| `--parallel=6` | 16.4s | 1515 通过 |
| `--parallel=10` | 10.7s | 1515 通过 |
| `--parallel`（默认，3 次） | 13.2 / 13.5 / 13.3s | 3 次全过 |
| `--parallel=4`（模拟 CI 低核，2 次） | 22.2 / 22.4s | 2 次全过 |

约束：CI（`ubuntu-latest`、`macos-latest`）与发布流水线都调用 `bun run test`，Bun 版本固定为 `1.4.x`；时长常量改数值需同步 spec，本变更不改生产默认值。

## Goals / Non-Goals

**Goals:**

- `bun run test` 墙钟较基线下降 ≥ 80%，用例数与断言数不减少，开发机与 CI 低核机都稳定通过。
- 保留一条可排查问题的顺序回退路径。
- 三处写死的真实等待改为可注入，默认值不变，使顺序回退与低核机器也更快。

**Non-Goals:**

- 不做跨端用例合并，不抽取各端测试样板，不拆分 gateway 包做分片。
- 不引入新的测试框架、假定时器库或自写的分包调度脚本。
- 不改任何生产默认数值、应用协议与 spec。

## Decisions

### D1 使用 Bun 自带 `--parallel`，而不是自写按包并行脚本

自写脚本需要维护包列表（新增包或测试目录容易漏跑），并行度要自己控制，gateway 单包仍是 38s 的瓶颈。`--parallel` 按文件分发，天然覆盖 `bunfig.toml` 里 `root = "./packages"` 下的全部文件，且默认并行度随机器核数变化，CI 不需要单独配置。

备选：（a）自写按包并行脚本 —— 见上，拒绝；（b）`--shard` 切多个 CI job —— 当前全量仅十几秒，拆 job 反而增加安装与构建开销，拒绝；（c）`--no-isolate`（worker 复用全局与模块表，更快）—— 文件之间可能互相看到遗留状态，而项目的测试大量依赖 `--isolate`（见上一批 `trim-test-suite` 与 Web 的 WS 用例备注），拒绝。

### D2 保留 `test:serial`

`test` 改为 `bun test --conditions=neko-source --parallel`；新增 `test:serial` = 原命令（`--isolate` 顺序执行）。并行下出现失败或疑似时序问题时，先用 `test:serial` 判断是否为并行引入。AGENTS.md「常用命令」同步这两条。CI 只跑 `test`，不跑 `test:serial`，避免 CI 时间翻倍；回退路径靠验收时手动跑通一次来保证不腐烂。

### D3 并行度不固定

不写死 `--parallel=N`，用默认（CPU 核数）。固定值要么在 2 核 CI 上过度并发，要么在开发机上浪费核数。低核机已试 `--parallel=4`（22s）通过。

### D4 三处写死等待的注入方式（与上一批一致：默认值不变，仅内部/测试使用）

- `FileCredentialStore`：构造增加可选第三参数 `{ lockAttempts?, lockRetryMs? }`，默认 100 / 25ms，仅测试传小值；不进入 `runtime.ts` 的选项、CLI 参数与配置文件。测试「reclaims a stale lock but never a fresh one」传 `lockAttempts: 3, lockRetryMs: 5`，断言（陈旧锁被回收、新锁抛 `Credential storage is busy`、锁文件仍在、`b` 未写入）不变。
- `stdin-shutdown`：纯测试改动。「不带 flag 时 stdin 关闭不退出」的负向等待从 2s 缩到 500ms（网关在 stdin 关闭后若会退出，会在毫秒级发生；窗口只需覆盖事件循环与进程信号传递），其余断言不变。
- `job-engine`：「启动窗口之后自行结束并排队回报」用例里的 `sleep 1.5` 缩短，同时保持「任务在启动窗口之后才结束、且结束时回答仍在流式输出」这个顺序前提（`open()` 的 `jobStartWindowMs: 500` 与 `tokensPerSecond` 配合调整）；断言不变。若无法在不引入时序不稳定的前提下缩短，保留原样并在用例旁记录原因，不为这一项改生产代码。

## Risks / Trade-offs

- [并行下对 CPU 敏感的时序用例变得不稳定] → 默认并行与 `--parallel=4` 已各多次通过；验收连续并行运行 3 次全过，另在后台制造负载（并行运行时再起一个 `--parallel=14`）跑 1 次观察；出现抖动的用例按其问题处理，不降低并行度掩盖。
- [共享的全局资源（固定端口、`~/.neko`、临时目录）在并行 worker 间冲突] → 已有测试都用临时目录与随机端口，试跑未出现冲突；验收时扫描测试里的固定端口与对真实 `~/.neko` 的读写，有命中则改为临时目录。
- [Bun 进程内 WS 在高负载下偶发损坏关闭（`images.test.ts` 的 1002）] → 既有问题，并行只是增加负载；对该用例加 `retry: 2` 并注明原因，不降低并行度掩盖；调查过程见 baseline.md。
- [`ps` 是机器全局的：同时跑两套完整测试会让 `jobs-e2e` 等用例看到对方的进程] → 单套并行内标记唯一；在 AGENTS.md 注明不要同时跑两套。
- [并行输出交错，失败信息难读] → 失败时用 `test:serial` 或单文件 `bun test <file>` 复现。
- [`--parallel` 是 Bun 1.4 的新特性，将来升级 Bun 行为变化] → CI 固定 `1.4.x`；`test:serial` 作为回退。
- [注入选项成为隐式 API 面] → `lockAttempts`/`lockRetryMs` 只在构造函数第三参数，不进入 CLI、配置 schema、文档；验收时用 `rg` 确认。

## Migration Plan

无部署步骤。改动是脚本与测试，回滚只需把 `test` 脚本改回 `--isolate`。

## Open Questions

无。
