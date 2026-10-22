# Tasks

## 1. 基线

- [x] 1.1 在改动前记录基线：用现有 `bun run test` 记录测试数、`expect()` 总数、墙钟，并记录 `bun test --conditions=neko-source --parallel` 与 `--parallel=4` 的墙钟，写入本变更目录的 `baseline.md`；验证：文件包含这几项，且基线为 1515 个测试、13311 次 `expect()`、约 84.6s。

## 2. 默认并行 + 顺序回退

- [x] 2.1 根 `package.json`：`test` 改为 `bun test --conditions=neko-source --parallel`，新增 `test:serial` 为 `bun test --conditions=neko-source --isolate`；验证：`bun run test` 与 `bun run test:serial` 均 1515 个全部通过。
- [x] 2.2 `AGENTS.md`「常用命令」：`test` 注明并行（Bun `--parallel`、隐含文件隔离），新增 `test:serial` 一行，说明用于排查并行引入的问题；验证：`rg "test:serial" AGENTS.md package.json` 两处都命中，且 `.github/workflows/*.yml` 无需改动（仍调用 `bun run test`）。
- [x] 2.3 扫描测试对共享全局资源的使用：`rg` 固定端口、`~/.neko`、`homedir()`、固定的 `/tmp` 路径；验证：命中项逐个确认使用的是临时目录或随机端口，有风险的改掉，结论记入 `baseline.md`。

## 3. 去掉写死的真实等待

- [x] 3.1 `packages/core/src/credentials.ts`：`FileCredentialStore` 增加可选第三参数 `{ lockAttempts?, lockRetryMs? }`（默认 100 / 25ms，行为不变）；`credentials.test.ts` 的「reclaims a stale lock but never a fresh one」传小值，断言不变；验证：`bun test --conditions=neko-source --isolate packages/core/test/credentials.test.ts` 通过，该用例 < 500ms，并且 `rg "lockAttempts|lockRetryMs" packages docs README.md` 只在 `credentials.ts` 与该测试中出现。
- [x] 3.2 `packages/gateway/test/stdin-shutdown.test.ts`：把「does not exit on stdin close without the flag」的负向等待从 2s 缩到 500ms；验证：该文件通过，该用例 < 1.5s。
- [x] 3.3 `packages/core/test/job-engine.test.ts`：缩短「reports a job that ends on its own after the start window, queued behind a busy answer」的 `sleep 1.5` 并保持顺序前提，断言不变；若做不到稳定，保留原样并在用例旁写明原因；验证：该文件连续运行 5 次全部通过，该用例耗时明显下降或记录了保留理由。

## 4. 集成验收

- [x] 4.1 连续运行 `bun run test`（并行）3 次，均 1515 个全部通过、无抖动；再在后台制造负载（并行运行时另起一个 `bun run test`）跑 1 次；验证：四次结果与墙钟写入 `baseline.md`，墙钟较 84.6s 下降 ≥ 80%。
- [x] 4.2 运行 `bun run test:serial` 与 `bun test --conditions=neko-source --parallel=4`；验证：均 1515 个全部通过，结果写入 `baseline.md`。
- [x] 4.3 对比基线：测试数不减少，`expect()` 总数不减少（允许 ±12 的既有波动）；验证：差值在 `baseline.md` 中说明。
- [x] 4.4 `bun run check` 通过；确认新增选项未出现在 CLI 参数、配置 schema、文档中；验证：命令退出码为 0，`rg` 在 `packages/cli`、`docs/`、`README.md` 中找不到 `lockAttempts`/`lockRetryMs`。

## Workflow follow-up

- 评审通过后归档本变更（`skip_specs`，无 spec 同步）。
- 若以后并行下 gateway 成为瓶颈，再评估 `--timings` 调度或拆分 gateway 测试；本变更不做。
