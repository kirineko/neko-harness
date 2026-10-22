# 基线（改动前）

机器：14 核 macOS，Bun 1.4.2，HEAD `2d1b20c`。

| 命令 | 测试数 | 文件 | `expect()` | 墙钟 |
| --- | --- | --- | --- | --- |
| `bun run test`（`--isolate`，顺序） | 1515 | 230 | 13311 | 84.6s（用户态 CPU 约 60s） |
| `--parallel=6` | 1515 | 230 | 13311 | 16.4s |
| `--parallel=10` | 1515 | 230 | 13323 | 10.7s |
| `--parallel`（默认，3 次） | 1515 | 230 | 13311 / 13317 / 13317 | 13.3 / 13.5 / 13.2s |
| `--parallel=4`（2 次） | 1515 | 230 | 13311 / 13353 | 22.2 / 22.4s |

- 全部通过，无失败。
- `expect()` 总数在 13311–13353 之间波动：部分用例在轮询（`until`）里断言，轮询次数随时序变化。判断「断言不减少」时以顺序基线 13311 为下限，并允许轮询带来的向上波动。
- 顺序基线的用例耗时分布：所有用例合计约 76s；≥ 1s 的 8 个用例 16.0s；≥ 500ms 的 28 个 29.3s；≥ 100ms 的 184 个 58.4s。
- 按包拆开并行试跑：cli 4s、tui 7s、web 9s、core 27s、gateway 38s。

## 2.3 共享全局资源扫描

扫描：固定端口、`~/.neko` / `homedir()` / `HOME`、固定 `/tmp` 路径、`listen` / `Bun.serve` / `createServer`。结论：无需改动。

- 固定端口（`8321` / `8322` / `8323` / `9000`）只出现在 `config`、`mobile-admin`、`pairing` 等测试的字符串夹具与伪造的 Host/监听信息里，不真实绑定。
- 真实绑定端口的测试（`mobile/listener`、`gateway-startup`、`startup`、`disconnect`）都用 `listen(0)` 或 `freePort()`（先 `listen(0)` 取端口再关闭）取随机端口；`freePort` 取到后到再绑定之间有极小的竞争窗口，并行下已 5 次完整运行无冲突。
- `~/.neko`：`config.test.ts`、`workspace-files.test.ts` 把 `HOME` / `USERPROFILE` 指到临时目录；`export-command.test.ts` 用真实 `homedir()` 只是推导期望的错误信息（目标目录不存在，不写入）。
- `/tmp/...` 只出现在解析/格式化类断言的字符串里，不读写。

## 3.x 去真实等待结果

| 用例 | 之前 | 之后 |
| --- | --- | --- |
| `credentials` reclaims a stale lock but never a fresh one | 2613ms | 19ms |
| `stdin-shutdown` does not exit on stdin close without the flag | 2176ms | 670ms |
| `job-engine` reports a job that ends on its own after the start window… | 3060ms | 1890ms（`sleep 0.9`、`tokensPerSecond` 40→80，连续 5 次通过） |

## 并行下发现的既有不稳定：`images.test.ts`

并行第 2 次完整运行出现 1 个失败：`transfers images across Unix/WS…`，报 `ChordError: link to neko closed: socket closed`。

- 不是并行引入：单文件、`--isolate` 下，用 16 个 CPU 占用进程加压，40 次里失败 7 次（基线代码，未改动）；不加压 30 次 0 失败。
- 位置：测试体与清理都执行完后才报错。给 `ws` 的 `close`/`error` 事件打点：通过的运行里 `b` 这条 WS 以 `1000` 关闭，失败的运行里两端同时变成 `1002 Protocol error - unsupported control frame`。这是 Bun 进程内 WebSocket 在关闭时字节流被破坏，与 `test/helpers.ts` 里记录的 Windows 丢帧同类；不在图片传输逻辑里。
- 试过但无效的做法：去掉前面被拒绝的 RPC（6/40）、关闭前先 `detach`（5/60）、先关网关再关客户端（6/60）、`b.close()` 后等 100ms（3/60）。
- 采取：对该用例加 `retry: 2` 并注明原因；加压下 40 次 0 失败。默认并行度下十次里 1 次失败（`--parallel=14`），`--parallel=8` 十次 0 失败，但不靠固定并行度掩盖。

## 另一个注意点：`ps` 是机器全局的

`jobs-e2e`、`job-engine`、`mobile/relay` 用 `ps` 按固定标记（如 `sleep 3101`）判断进程是否存活。单套并行里标记在仓库内唯一，不冲突；但**同时在同一台机器上跑两套完整测试**（两个终端、两个 worktree、或两个 agent）会互相看到对方的进程，导致 `jobs-e2e` 偶发失败。已写入 AGENTS.md。

## 4 验收结果

| 运行 | 测试数 | `expect()` | 墙钟 | 结果 |
| --- | --- | --- | --- | --- |
| `bun run test` ×3 | 1515 | 13317 / 13311 / 13329 | 11.96 / 11.93 / 11.94s | 全过 |
| `bun run test`，后台 14 个 CPU 占用进程 ×3 | 1515 | - | 14.2 / 15.2 / 15.8s | 全过 |
| `bun run test:serial` | 1515 | 13311 | 80.3s | 全过 |
| `--parallel=4` | 1515 | 13311 | 20.7s | 全过 |

- 基线 84.6s → 约 12s（下降约 86%）；加压下约 15s。
- 测试数 1515 不变；`expect()` 不低于顺序基线 13311（并行下轮询断言次数略多）。
- `bun run check` 通过；`lockAttempts` / `lockRetryMs` 只在 `credentials.ts` 与该测试里，`packages/cli`、`docs/`、`README.md`、网关源码中没有。
- 失败记录：验收过程中出现过 2 次失败，都已查明——一次是上面的 `images` 既有不稳定（已加 `retry`），一次是我同时起了两套完整测试造成的 `ps` 冲突（实验方法问题，不是缺陷）。
