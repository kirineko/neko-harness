# Tasks

## 1. 基线

- [x] 1.1 在改动前记录基线：运行 `bun run test`，保存测试数、`expect() calls` 总数、墙钟与 ≥ 1s 用例清单（写入本变更目录下的 `baseline.md`）；验证：文件包含这四项且与 design.md 的基线一致。

## 2. 命名与文件搜索超时可注入

- [x] 2.1 `session-metadata.ts`：为命名任务增加可选 `requestTimeoutMs`（默认 20_000），经 `runtime.ts` 内部选项透传；验证：不传时 `session-naming.test.ts` 其他用例全部通过。
- [x] 2.2 `session-naming.test.ts` 的「bounds hung title requests」改为传小超时并去掉 `Bun.sleep(43_000)`，断言（`naming = "fallback"`、`attempts = 2`、`status = "idle"`、`callCount = 3`）不变；验证：该用例通过且耗时 < 2s。
- [x] 2.3 `agent-file-search.ts`：让截止时间可注入（默认仍为 `SEARCH_LIMITS.timeoutMs`）；`agent-file-search.test.ts` 的「aborts a slow environment on the deadline」改用小值；验证：该文件全部通过，该用例 < 1s。

## 3. 网关就绪超时可注入

- [x] 3.1 `client-session.ts` 的 `deadline()` 接收 `readyTimeoutMs`（默认 5000），`createGatewayConnection` 增加可选第三参数，既有调用点不变；`client-session.test.ts` 的「bounds gateway readiness」传小值；验证：`packages/gateway/test/client-session.test.ts` 通过且该用例 < 1s。

## 4. 后台任务启动窗口可注入

- [x] 4.1 `JobManager` 构造接收可选 `{ startWindowMs }`（默认 `JOB_LIMITS.startWindowMs`，不改常量），`runtime.ts` 经内部选项透传；验证：不传时 `job-engine.test.ts` 现有断言行为不变（含 `JOB_LIMITS.startWindowMs + 3000` 那条上界）。
- [x] 4.2 `job-engine.test.ts`、`gateway/test/jobs-e2e.test.ts`、`gateway/test/interactions-e2e.test.ts`、`gateway/test/jobs.test.ts` 以及 TUI/Web 中依赖 2s 窗口的用例改传小窗口（约 100ms）；固定 `setTimeout/Bun.sleep` 改用 `until` 或缩短；验证：上述文件全部通过，且各文件中不再有 ≥ 2s 的用例（除明确测试 `timeout` 秒数的用例）。
- [x] 4.3 `tui/test/jobs-ui.test.ts` 两处 `setTimeout(1100)`：确认面板节流是否可经已有参数缩短；能则缩短，不能则保留并在用例旁说明原因；验证：该文件通过。

## 5. compaction 重试退避

- [x] 5.1 检查能否在测试里经公开配置（Pi `ConversationRetryPolicy.baseDelayMs`）调小重试退避而不改生产默认；能则调整 `compaction.test.ts` 的 `retry` 模式，不能则在 design.md 的 D5 记录结论并保持原样；验证：`compaction.test.ts` 通过，`retry` 用例若可调则 < 1s。

## 6. 删除只测上游的用例

- [x] 6.1 删除 `packages/core/test/pi-1-3.test.ts` 的 `transformMessages` 用例（保留经 neko 投影的第二个用例）；验证：该文件剩余用例通过，且 `rg transformMessages packages/*/test` 无剩余引用。
- [x] 6.2 `providers.test.ts` 删除第二个用例里仅验证 `createModels().refresh` 的前半段，保留经 `createNekoRuntime` 的 `baseUrl` 断言；验证：该文件通过且 `faux` 的 `baseUrl` 断言仍在。
- [x] 6.3 全仓扫描「不经过 neko `src` 的测试」，逐个判断是否属于 design.md D3 的删除条件，把结论（删 / 留 + 理由）追加到 `baseline.md`；验证：清单里每个被删项都对应一条理由，且未删除任何契约对账类测试。

## 7. 合并同构用例

- [x] 7.1 扫描「用例体除参数外逐行相同」的候选（例如 `gateway/test/mobile/listener.test.ts` 的虚拟网卡与地址过滤系列），仅对适合的转成 `for`/`it.each`，用例名带参数；验证：被合并文件通过，且合并前后该文件的断言数不减少。若没有合适候选，在 `baseline.md` 记录「无」。

## 8. 集成验收

- [x] 8.1 连续运行 `bun run test` 3 次，均全部通过且无抖动；墙钟较基线下降 ≥ 50%（记录实际值）；验证：三次结果写入 `baseline.md`。
- [x] 8.2 对比基线：`expect() calls` 总数下降仅来自 6.x / 7.x 明确列出的删除或合并；验证：差值与清单一致。
- [x] 8.3 `bun run check` 通过（biome 与类型检查）；确认新增选项未出现在 CLI 参数、配置 schema、文档和网关协议中；验证：命令退出码为 0，`rg` 在 `packages/cli`、配置 schema、`docs/` 中找不到新选项名。

## Workflow follow-up

- 评审通过后归档本变更。
- 第二批「跨端提问 / 计划面板 UI 测试去重」另开变更，先产出「行为 × 端」矩阵并对照 spec scenario。
