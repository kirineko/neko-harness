# 基线（改动前）

命令：`bun run test`（`bun test --conditions=neko-source --isolate`），同一台机器，HEAD `face23b`。

| 项 | 值 |
| --- | --- |
| 测试数 | 1397（209 个文件，全部通过） |
| `expect()` 调用数 | 9536 / 9548（两次完整运行） |
| 墙钟 | 164.6s / 164.9s（用户态 CPU 约 51s） |
| 所有测试自报耗时合计 | 157.2s |
| ≥ 1s 的用例 | 26 个，合计 110.1s |

## ≥ 1s 用例清单（毫秒）

- 43017  bounds hung title requests by timeout and the persisted retry budget 
- 10015  aborts a slow environment on the deadline 
- 5415  runs a background service through chat, crash report, gateway restart and archive without leaving processes 
- 5001  bounds gateway readiness when the peer never delivers a snapshot 
- 4603  reports a job that ends on its own after the start window, queued behind a busy answer 
- 2877  keeps a background job running while a question waits and reports it only after the answer 
- 2633  reclaims a stale lock but never a fresh one 
- 2498  settles a running job as lost after a restart, reports it once and never re-runs it 
- 2466  does not report a model-initiated stop 
- 2373  keeps a terminal state immutable when stop races with exit 
- 2178  gateway --stop-on-stdin > does not exit on stdin close without the flag 
- 2128  falls back after two invalid title responses without polluting the transcript 
- 2106  always sends a bounded job summary list without output 
- 2069  returns immediately for a long-running job, reports a user stop, and kills the process tree 
- 2067  reads output in bounded pages and resumes from the offset after reconnecting 
- 2057  does not let one session read or stop another session's job 
- 2055  stops a job once for concurrent clients, rejects unknown ids and returns the terminal state when it already ended 
- 2055  limits running jobs and lists only the newest terminal ones 
- 2051  kills running processes on close without leaving orphans 
- 2047  stops a conversation's running jobs when it is archived, without a report 
- 2041  forks a conversation without its running jobs 
- 2021  projects native retry without changing policy 
- 1105  drops a late response after the panel closes 
- 1104  reads output incrementally by offset and follows new output until scrolled up 
- 1058  marks a zero exit exited and a timeout failed with its reason 
- 1041  POSIX Web gateway readiness > waits for WS after Unix is ready and cleans up its child on timeout 

## 6.3 上游专属测试扫描

扫描方法：列出不含静态 `../src` 导入的测试文件，再检查动态导入与读取路径。

- 命中 11 个文件：web 的 `math`、`shell-notice`、`theme-contrast`、`todo-panel`、`appearance-settings`、`open-workspace-menu`、`composer-plan`、`provider-combobox`，cli 的 `help`，gateway 的 `workspace`、`state-redelivery`。
- 逐个核对：它们或经动态 `await import("../src/...")`、或读取 `../src/client/styles.css`、或经 `./helpers.ts` 启动 neko 网关，被测对象都是 neko 自己的代码；留。
- 真正只测上游的只有：`pi-1-3.test.ts` 的 `transformMessages` 用例（已删），`providers.test.ts` 第二个用例的 `createModels().refresh` 前半段（已删，保留 `baseUrl` 经运行时的断言并改名）。
- 保留：`pi-1-3.test.ts` 的畸形工具参数用例（经 neko 投影），`providers.test.ts` 的 DeepSeek 能力用例（断言 `listSelectableModels` 的 neko 输出），`provider-settings` 与 Pi `checkAuth` 的对账。

## 7.1 同构用例合并

结论：无合适候选，未合并。

- compaction 的 failure / cancel / retry / overflow 已是参数化循环。
- 按用例名前三个词统计，同一文件内模板重复 ≥ 4 次的只有 `config.test.ts`（分别解析不同的配置键，各自断言不同），合并不会减少内容。
- `mobile/listener.test.ts` 的几个「排除虚拟网卡」用例各测不同的名称集合，且内部已是表驱动，合并没有收益。

## 8 验收结果（改动后）

| 运行 | 测试数 | `expect()` | 墙钟 |
| --- | --- | --- | --- |
| 1 | 1396 | 9529 | 78.3s |
| 2 | 1396 | 9535 | 79.0s |
| 3 | 1396 | 9529 | 80.4s |

- 三次全部通过，无失败、无抖动。墙钟约 165s → 约 79s（下降约 52%）。原定「约 60s 以内」经用户确认放宽为「下降 ≥ 50%」。
- 剩余时间已分散：所有用例自报耗时合计约 71s，≥ 500ms 的 25 个用例合计约 26s（job-engine 13 个用例各约 0.55s，来自 500ms 启动窗口；`stdin-shutdown` 约 3.1s；`credentials` 锁等待约 2.6s；`jobs-e2e` 约 2.8s）。
- `expect()` 基线两次运行为 9536 / 9548（同一代码有 ±12 的波动），改动后 9529–9535。差值与删除的 `transformMessages`（4 个断言）和 `refresh` 前半段（3 个断言）一致，其余用例的断言未减少。
- 测试数 1397 → 1396（只删了 `transformMessages` 用例；providers 的用例只是缩短并改名）。
- `bun run build` 后 `bun run check` 通过（先前失败是因为 dist 类型过期）。
- 新选项（`jobStartWindowMs`、`namingRequestTimeoutMs`、`namingRetryDelayMs`、`retryBaseDelayMs`）只出现在 `core/src/runtime.ts` 与测试里；`packages/cli`、`docs/`、`README.md`、配置解析与网关 CLI 参数中均无。
