# Tasks

## 1. `ask_user` 持久信号停放与取消收敛（D1、D5）

- [x] 1.1 在 `packages/core/src/user-questions.ts` 与 `packages/core/src/runtime.ts` 中定义 `QuestionAnsweredSignal`（`app.neko.question-settled` v1），将 `ask_user` 切换为首次落盘后返回 `{ sleep: { signals } }` 停放、唤醒后读取终态记录返回并实现 `cancel` 钩子取消结算，同时移除 `UserQuestions.prototype.wait()` 与构造函数全局 `task` `onCommits` 监听、在 `NekoSession.abort()` 中补充显式对账；运行 `pnpm --filter @neko-harness/core build` 验证编译通过
- [x] 1.2 更新 `packages/core/test/user-questions.test.ts` 以移除对内存 `wait()` 的调用，补充停放唤醒、多端竞争、取消钩子收敛以及等待期间连续超过 `restartLimit` 次异常重开仍保持未决可回答的用例；运行 `pnpm test packages/core/test/user-questions.test.ts` 验证全部通过

## 2. 工具执行审批门禁停放与取消收敛（D2、D5）

- [x] 2.1 在 `packages/core/src/tool-approvals.ts`、`packages/core/src/subagents.ts` 与 `packages/core/src/runtime.ts` 中定义 `ApprovalSignal`（`app.neko.tool-approval-settled` v1），将审批等待迁入 `neko-tool-approvals` 的 `hook(ToolTask, { beforeTool })`（`pending` 返回 `{ sleep }`、`denied`/`cancelled` 返回 `{ block }`、`allowed` 放行），保留 `wrapTool(createBashTool())` 执行端参数与规范化 `cwd` 核验，移除 `ToolApprovals.prototype.wait()` 与全局 `task` `onCommits` 监听并在 `RoundTask.abort` 与 `NekoSession.abort()` 中同步取消未决审批；运行 `pnpm --filter @neko-harness/core build` 验证编译通过
- [x] 2.2 更新 `packages/core/test/tool-approvals.test.ts` 适配移除 `wait()` 后的检查点测试，覆盖门禁重开/扩展重装幂等睡眠、后续 `beforeTool` 参数/目录篡改拦截、单轮及整会话停止即时取消审批，以及等待期连续超过 `restartLimit` 次异常重开不中断而执行期重开仍报中断的边界；运行 `pnpm test packages/core/test/tool-approvals.test.ts` 验证全部通过

## 3. `plan` 提交排队覆盖单事务收口（D3）

- [x] 3.1 更新 `packages/core/src/plan.ts` 的 `PlanService.submit`，在同一次 `harness.commit` 内检查 `InboxDoc` 是否已有排队用户输入并在命中时直接创建 `status: "superseded"` 记录（移除二次 `supersedePending` 提交窗口），保持 `submit_plan` 的 `{ control: { terminate: true } }` 空闲待批语义不变；在 `packages/core/test/plan.test.ts` 中新增单事务直接落盘 `superseded` 且观察不到 `awaiting_approval` 中间提交的测试，运行 `pnpm test packages/core/test/plan.test.ts` 验证全部通过

## 4. `subagent` 三层持久等待、无轮询槽位调度与文档同步（D4）

- [x] 4.1 重构 `packages/core/src/subagents.ts`：父 `subagent` 工具改为返回 `{ wait: { on: [runnerId], policy: "allSettled", checkpoint } }` 并移除 `api.waitForTask`；`RoundTask` 的 `deliver`/`settle` 阶段改用 `child.submit(..., { notify })` 与内置 `SubmissionSettled` 信号等待（保留无信号旧检查点的 `submission.status` 回退）；定义 `SlotWakeSignal`（`app.neko.subagent-slot` v1）并为 `SlotsDoc` 增加向后兼容的 `waiters`（单调递增 `wakeSeq`），在槽位释放与启动清理事务内信号唤醒可准入等待者并移除 `100ms` `pause` 轮询；运行 `pnpm --filter @neko-harness/core build` 验证编译通过
- [x] 4.2 更新 `packages/core/test/subagents.test.ts` 与 `packages/core/test/subagent-recovery.test.ts` 适配 `ToolPark` 检查点流程，覆盖 3 并发与同 `cwd` 单 `coder` 配额信号唤醒、多等待者回睡幂等、排队取消以及排队/委派等待期连续超过 `restartLimit` 次异常重开恢复，同时更新 `AGENTS.md` 中「Pi 1.6 使用要点」的内部停放说明使其与实现一致；运行 `pnpm test packages/core/test/subagents.test.ts packages/core/test/subagent-recovery.test.ts` 验证全部通过

## 5. 全仓回归与打包集成验证

- [x] 5.1 运行 `pnpm build`、`pnpm check` 与 `pnpm test:serial` 验证全仓构建、Biome 检查、根与 Web 客户端类型检查以及 `core` / `gateway` / `tui` / `web` 全套串行测试零错误通过
- [x] 5.2 运行 `pnpm build:release` 与 `pnpm test:package` 验证发布包打包产物无非法残留且全局 tarball 安装冒烟通过
