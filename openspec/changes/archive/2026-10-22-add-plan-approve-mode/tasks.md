# Tasks

## 1. 共享上限与 bash 判定（core 纯模块）

- [x] 1.1 在 `packages/core/src/interactions.ts` 新增 `PLAN_LIMITS`（标题 120、步骤数 30、单步 500、说明 4000、反馈 2000）与计划参数/决定校验函数；验证：`bun run test` 中新增的 `plan-limits` 单测覆盖边界值与非法输入
- [x] 1.2 新建 `packages/core/src/plan-bash.ts`，移植 pi `plan-mode/utils.ts` 的 `SAFE_PATTERNS` / `DESTRUCTIVE_PATTERNS`，实现引号外切段、命令替换拒绝与 design D4 的收紧项，导出 `isSafeCommand`；验证：表驱动单测覆盖 spec 场景（`git log`、`rg`、`ls | wc -l` 通过；`ls; rm`、`cat a > b`、`echo $(touch x)`、`find -delete`、`sed -i`、`curl -o`、`awk 'BEGIN{system(...)}'`、`top`/`less` 被拒；带引号的分号不误拆）

## 2. 计划文档、服务与扩展（core）

- [x] 2.1 新建 `packages/core/src/plan.ts`：`PlanDoc`（`app.neko.plan`，rewindable / `fork: "asOf"`，最近 5 条）、`PlanService`（提交、`respond` 首次有效结算与版本校验、普通输入取代、停止/归档/启动对账、`dispatched` 补发）；验证：`packages/core/test/plan.test.ts` 覆盖幂等提交、重复/过期版本、取代、取消与对账
- [x] 2.2 在同文件实现 `submit_plan`（`deferred: true`、`replay: "safe"`、`executionMode: "sequential"`、`callers: ["model"]`、`terminate`，以工具 task id 幂等）与扩展 `neko-plan`（`beforeTool` 拦截 `edit`/`write`/`job` 与不安全 bash，`wrapTool(createBashTool())` 执行端复核）；验证：faux 模型测试覆盖 plan 模式下写工具与非白名单 bash 被拒、`submit_plan` 结束本轮、normal 模式模型看不到 `submit_plan`
- [x] 2.3 在 `runtime.ts` 安装扩展、实现 `setPlanMode`（空闲才受理、先文档后 `configure`：进入 `tools.remove` + `modelTools.add` + `instructions`，退出全部置 `null`，经 `admit` 串行）与 `respondPlan`（批准退出并提交 `plan-exec:<version>`、修改提交 `plan-revise:<version>`，带 `entry`）；验证：测试覆盖批准后写工具恢复且执行输入恰好一次、修改后保持 plan 模式、运行中切换被拒
- [x] 2.4 实现受理前与启动时的模式对账（文档 vs `conversation.agent()` 生效值，幂等 `configure`）及 `dispatched` 补发；验证：模拟"文档已改、配置未应用"与"批准后未提交输入"两种中断，重开后状态被修复且输入不重复
- [x] 2.5 `PLAN_INSTRUCTIONS` 英文提示词常量；`submit_plan` 与 `neko-plan` 加入 `MAIN_ONLY_TOOLS` / `MAIN_ONLY_EXTENSIONS`；`subagent` 工具在 plan 模式拒绝启动与继续 coder；验证：子 agent 工具集无 `submit_plan`，plan 模式下委派 coder 报错、explore 正常
- [x] 2.6 `projection.ts` 把 `plan-decision` 输入 entry 与 `submit_plan` 工具项投影为带结构化状态的展示项；`session-metadata.ts` 计算 `awaitingPlan`；验证：projection / metadata 单测
- [x] 2.7 验证 design 风险项：followUp / steer 在 `terminate` 后的实际行为、分叉后文档与 agent 配置一致；验证：对应测试通过，必要时调整受理钩子并同步 spec

## 3. 网关契约与客户端探测

- [x] 3.1 `packages/gateway/src/contract.ts`：`ChatView.plan` 可选字段、`PlanRecord` schema、`planGet` / `planRespond` / `planMode` 方法、`SessionSummary.awaitingPlan`；`session-host.ts` 订阅白名单加入 `app.neko.plan`，视图组装与方法实现；验证：契约 schema 校验测试
- [x] 3.2 `client-session.ts` 新增 `planClient`（`PLAN_UNSUPPORTED`，探测 `view.plan !== undefined`）；验证：`packages/gateway/test/plan.test.ts` 仿 `user-interactions.test.ts` 覆盖旧网关降级、多客户端共享、错误身份/版本拒绝、断开保留
- [x] 3.3 端到端用例仿 `interactions-e2e.test.ts`：重启、双端竞争决定、停止后迟到批准、排队输入与批准的顺序；验证：`bun run test` 中该文件通过
- [x] 3.4 `server-services.ts` 透传 `awaitingPlan`；验证：会话列表快照测试

## 4. Web

- [x] 4.1 `lib/gateway.ts` / `bootstrap.ts` 接入 `planClient`；新增 `lib/plan-ui.ts`（纯函数：状态文案、可操作性、`sessionStatusText` 扩展）；验证：纯函数单测
- [x] 4.2 `lib/command-suggestions.ts` 增加 `/plan` 菜单项（旧网关不列出），`composer.tsx` 仿 `/compact` 在忙碌拦截前解析 `/plan` 并调用 `planMode`（不进入历史、不发给模型、运行中提示并保留草稿），输入区显示模式标识；不新增切换按钮；验证：`packages/web/test` 组件测试覆盖命令切换、运行中保留草稿、旧网关无菜单项与标识
- [x] 4.3 新增计划卡片组件并放入 `data-attention-stack`（批准 / 要求修改带反馈 / 抢先后的真实状态 / 纯文本），消息流 `submit_plan` 历史行；验证：组件测试覆盖三种决定与竞争
- [x] 4.4 会话列表"等待批准"与标签页标题前缀；验证：仿 `chat-page-interactions.test.tsx` 的列表与标题用例
- [x] 4.5 同步 `test/support/interaction-fixtures.ts`（`ViewOptions` 增加 `plan`）；验证：既有交互测试仍通过

## 5. TUI

- [x] 5.1 `labels.ts` / `help-ui.ts` 加入 `/plan` 与帮助说明；`tui.ts` 分发 `/plan`（无待批准切换，有待批准打开面板）与 `Shift+Tab`；验证：命令补全与帮助测试
- [x] 5.2 新增 `plan-dock.ts`（仿 `QuestionDock`：批准、带反馈的要求修改、关闭、抢先后显示真实状态），在 `input-router.ts` 中排在排队选择之前，沿用 `opened` 回调清除排队选择；验证：仿 `question-ui.test.ts` 的路由测试，含"面板打开时 Enter 不触发排队 Steer"
- [x] 5.3 `footer.ts` 增加模式标识与待批准 hint，`#syncFooter` 填充；验证：页脚窄屏退化测试
- [x] 5.4 端到端：仿 `question-gateway.test.ts` 用 faux 模型走通 plan → 提交 → 批准 → 执行；验证：测试通过

## 6. 移动 API 与移动端

- [x] 6.1 `mobile/protocol.ts`：`plan` 能力、状态摘要 `plan`、`plan.get` / `plan.respond`、通知 `plan.changed`、`awaitingPlan`；`adapter.ts` / `projection.ts` 实现（订阅与归属校验，不提供模式切换）；新增 `test/fixtures/mobile-api-v1/plan-*.json`；验证：仿 `mobile/user-interactions.test.ts` 的能力协商、越权、旧订阅、重复决定测试
- [x] 6.2 Dart：`models.dart` 增加 plan 模型与 `awaitingPlan`，`interactions_controller.dart` 增加 `plan.*` 调用与通知处理，新增计划卡片 UI 与会话列表提示；验证：`apps/mobile` 的 Dart 测试（模型、控制器、会话列表）通过

## 7. 文档与整体验证

- [x] 7.1 更新 `AGENTS.md`：新增"Plan 模式"小节（PlanDoc 为权威、`submit_plan` + terminate、批准幂等 requestId、bash 判定在 `plan-bash.ts`、可选能力 `planClient`、`PLAN_LIMITS` 同步 spec 与 Dart）；验证：与实现一致的人工核对
- [x] 7.2 整体检查：`bun run check`、`bun run test`、`bun run build` 全部通过；验证：命令输出无错误
- [x] 7.3 手工走查：Web / TUI / 移动端各完成一次"进入 plan → 调研（只读 bash）→ 提交 → 要求修改 → 再提交 → 批准 → 自动执行"，并在批准前停止会话验证计划被取消；验证：记录走查结果

## 8. 取消并退出计划模式

- [x] 8.1 Web 计划卡片增加「取消并退出计划模式」，复用 `planMode(normal)`；验证：组件测试覆盖成功、失败、离线禁用、与批准/修改互斥
- [x] 8.2 TUI 计划面板增加取消并退出按键与提示，反馈输入时不误触；验证：面板按键测试与端到端（提交计划→退出→已取消且 normal）
- [x] 8.3 移动 API 增加 `plan.exit`（订阅校验、运行中拒绝、幂等、通知），夹具与文档同步，不提供进入；验证：`test/mobile/plan-mode.test.ts`
- [x] 8.4 Dart 计划 sheet 增加取消并退出按钮与控制器方法；验证：`flutter test` 与 `flutter analyze`
- [x] 8.5 整体检查并更新 AGENTS.md「Plan 模式」；验证：`bun run check`、`bun run test`、`bun run build`

- [x] 8.6 TUI 计划到达时自动打开面板（`PlanDock.autoOpen`，复用 `canAutoOpen`，每版本一次）；验证：`plan-ui.test.ts` 单测与 `plan-gateway.test.ts` 端到端

## Workflow follow-up

- 评审通过后归档该 change，并核对归档后的主 spec 中新增的 `plan-mode` 与各 delta 内容。
