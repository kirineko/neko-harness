# Design

## Context

动机与范围见 proposal.md。基线（改动前，同一台机器）：`bun run test` 1397 个测试、209 个文件、墙钟约 165s、用户态 CPU 约 51s；26 个耗时 ≥ 1s 的测试合计约 110s，其中几项是被测代码里的硬编码时长：

| 位置 | 硬编码时长 | 测试表现 |
| --- | --- | --- |
| `session-metadata.ts` 命名任务 | `AbortSignal.timeout(20_000)`，最多 2 次尝试 | `Bun.sleep(43_000)`，43s |
| `agent-file-search.ts` | `SEARCH_LIMITS.timeoutMs = 10_000` | 真等 10s |
| `client-session.ts` `deadline()` | `setTimeout(..., 5000)` | 真等 5s |
| `job-engine.ts` `start` | `JOB_LIMITS.startWindowMs = 2000`，对长任务必然等满 | job-engine 约 12 个用例、`jobs-e2e`、`interactions-e2e` 各约 2s，合计约 40s |
| compaction 原生重试 | Pi 持久化重试策略的退避 | `projects native retry` 约 2s |
| TUI `jobs-ui` | 面板轮询节流 | 2 个用例各 `setTimeout(1100)` |

约束：时长常量（`JOB_LIMITS` 等）改数值需同步 spec，本变更不改生产默认值；上游 Pi 为实验性包、只升版本不裹代码；`pi-env`/Pi 持久化重试策略是上游行为，能用其公开配置就用，不能就不动。

## Goals / Non-Goals

**Goals:**

- 墙钟较基线下降 ≥ 50%（实测约 79s），且被测行为的断言不变（同一批断言在更短时间内被执行）。
- 注入点只在内部使用：不进入 CLI 参数、配置文件、网关协议或文档。
- 每个被删除的测试都能说明「验证的是上游而不是 neko」。

**Non-Goals:**

- 不做跨端 UI 去重（另开变更）。
- 不引入假定时器库或测试框架替换。
- 不为减少数量而合并语义不同的用例。

## Decisions

### D1 时长做成可注入选项，而不是假定时器

被测时间来自 `AbortSignal.timeout`、`setTimeout`、durable task 的 `runtime.sleep`（挂在存储与真实时钟上）以及 `Bun.sleep`；假定时器覆盖不到 `AbortSignal.timeout`，也会和 durable 运行时的真实调度纠缠。因此改成显式选项，默认值等于现在的常量：

- `JobManager` 构造接收 `{ startWindowMs?: number }`，`runtime.ts` 经内部选项（例如 `NekoRuntimeOptions.internal?: { jobStartWindowMs?, namingRequestTimeoutMs? }`）透传；`JOB_LIMITS.startWindowMs` 仍是默认来源，不改数值。
- 命名任务：`namingTask(canUse, { requestTimeoutMs = 20_000 })`；`SessionMetadataService` 构造时透传。
- 文件搜索：`search()` 的超时从 `SEARCH_LIMITS.timeoutMs` 读取一个可覆盖的值。因为 `FindFiles`/`SearchText` 是模块级 `defineTool`，改为导出 `createSearchTools({ timeoutMs })` 或让 `search` 读取注入的 `ToolExecutionApi` 扩展字段；最终形态以实现时对现有调用点改动最小者为准，默认路径保持原行为。
- 网关就绪：`createGatewayConnection(link, serverId, { readyTimeoutMs = 5000 })`，第三参数可选，既有调用点不变。

备选：（a）测试里直接改 `JOB_LIMITS` —— 它是 `as const` 且被多处读取，会污染并行文件之间的状态，拒绝；（b）环境变量 —— 变成隐式全局，难审计，拒绝。

**实际落地（实现时按改动最小者选择）：**

- `NekoRuntimeOptions.timings`（`NekoRuntimeTimings`）：`jobStartWindowMs`、`namingRequestTimeoutMs`、`namingRetryDelayMs`、`retryBaseDelayMs`；网关 `NekoGatewayOptions.timings` 原样透传，CLI 与配置文件不提供。
- 命名任务的两处硬编码（单次请求 20s、重试间隔 2s）都进了 `NamingTimings`。
- 网关就绪超时：`createGatewayConnection(link, serverId, { readyTimeoutMs })`。
- 文件搜索：`SEARCH_LIMITS` 本来就是可变对象，测试里临时改 `timeoutMs` 并在 `finally` 恢复（`--isolate` 下每个文件独立模块），不加生产代码。
- TUI `JobDetail` 增加可选第 5 个构造参数 `pollMs`（默认 `POLL_MS`），两个等轮询的用例传 30ms。

### D2 测试里的固定 sleep 改为条件轮询

`Bun.sleep(150)`、`setTimeout(300/400)` 这类「等一等再断言没发生」的写法，保留需要「负向等待」的语义时改用现有 `until` 辅助配合短窗口，不需要时直接删除。TUI jobs 面板的 1100ms 来自面板自身的节流；若可通过面板已有的参数缩短则缩短，否则保持（不为 2 个用例改生产代码）。

### D3 删除标准

删除仅限满足以下全部条件的用例：只调用上游（Pi）API 或只断言上游数据；没有经过 neko 的 `src`；对应的 spec scenario 已有其他测试覆盖或本来就不是 neko 的行为。当前候选：

- `pi-1-3.test.ts` 的「switched model thinking」用例（直接调用 `transformMessages`）。保留同文件第二个用例（经 neko 投影，验证 neko 把错误参数展示给模型）。
- `providers.test.ts` 第二个用例中仅验证 `createModels().refresh` 的前半段；保留经 `createNekoRuntime` 的 `baseUrl` 断言。

保留的契约类测试：`provider-settings` 与 Pi `checkAuth` 对账、`QuestionLimits` 与服务端常量一致、各 spec 的边界值测试。

### D4 同构用例合并的判定

只在「`it` 体除参数外逐行相同」时转成 `for` 或 `it.each`，用例名带参数，保证失败时能定位。实现前先扫一遍候选（例如 `mobile/listener.test.ts` 的虚拟网卡前缀系列），若合并后可读性变差则不合并。compaction 的四种 mode 已经是参数化循环，无需改动。

### D5 compaction 重试

已确认：Pi `HarnessSettings.retry.baseDelayMs` 是公开配置，经 `timings.retryBaseDelayMs` 传入后 `projects native retry` 从约 2s 降到约 40ms；生产不设置该项，仍用 Pi 默认。

## Risks / Trade-offs

- [注入选项成为隐式 API 面] → 命名为 `internal`、不写入文档与配置 schema，类型层面只对 core/gateway 内部可见；代码评审时核对没有出现在 CLI 参数里。
- [缩短后的超时在慢机器上变成不稳定测试] → 测试用的值取「被测路径正常耗时的 10 倍以上」（例如启动窗口 100ms、命名超时 300ms），并保留 `until` 的上限；改完连续跑 3 次全量确认无抖动。
- [删除上游测试后升级 Pi 失去提醒] → 升级设计 `upgrade-pi-sdk-1-3` 已有显式升级流程，且 `provider-settings` 对账与经运行时的集成用例仍在；仅删除不经过 neko 代码的断言。
- [合并用例降低失败可读性] → D4 的名字带参数规则。
- [「覆盖不减」难以机械证明] → 用改动前后 `bun test` 的断言总数对比（`expect() calls`），并人工核对每个被改写用例的断言列表未减少；被删除用例逐个在 tasks 中列出理由。

## Migration Plan

无部署步骤。逐项提交、每项独立可回滚；失败时回退单个提交即可恢复原行为（默认值未变）。

## Open Questions

无。
