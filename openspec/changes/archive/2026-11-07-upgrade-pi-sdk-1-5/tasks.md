# Tasks

## 1. 依赖升级

- [x] 1.1 记录 1.4.0 基线：`bun run check` 与 `bun run test` 结果写入 `verification.md`
- [x] 1.2 将根包与 `packages/{core,gateway,tui,web}` 的 `@earendil-works/*` 精确锁定 `1.5.0`，按实际导入新增 `@earendil-works/pi-schema@1.5.0`，删除 `typebox`；更新 `bun.lock`，`bun install --frozen-lockfile` 成功且 `bun pm ls` 无重复 Pi 包

## 2. TypeBox → pi-schema（D10）

- [x] 2.1 core 工具参数（subagents、todos、user-questions、job-engine、agent-file-search、plan、web-search）改用 pi-schema，`bun run check` 中 core 无相关类型错误
- [x] 2.2 gateway Chord 契约（`contract.ts`、`mobile/admin.ts`、`server-services.ts`、`session-host.ts`、`subagent-host.ts`）改用 pi-schema，`Type.Object` → `obj(…, { open: true })`，契约测试通过
- [x] 2.3 移动协议校验（`mobile/protocol.ts`、`mobile/adapter.ts`）改用 pi-schema `compile` 并缓存校验器，`packages/gateway/test/mobile` 测试通过
- [x] 2.4 测试中的 `Type` 全部替换，`rg -n 'typebox|\bType\.' packages --glob '!**/dist/**'` 无结果

## 3. 标记形状迁移（D7、D8）

- [x] 3.1 `subscribeCommits` → `observeCommits`（core 与 gateway 全部调用点），文档变化按 `kind` 判断；相关测试通过
- [x] 3.2 `user-questions.ts` 的 `watchDoc` 监听与结束原因、`tool-approvals.ts` 的 `documentState` 迁移；问题与审批测试通过
- [x] 3.3 `onReport` 适配器与 `SubmissionRecord` 收窄；其余 `tsc` 报错清零，`bun run check` 通过
- [x] 3.4 重写 `crash-loop.test.ts`：到限后运行以 `restart_limit` 失败结束、会话空闲、报告一次；测试通过

## 4. 会话视图（D2、D3、D4）

- [x] 4.1 core 新增 `NekoSession.follow()`（`Conversation.watch()` + `ConversationTranscript`，补全历史与缺口），删除 `viewState()` / `events()` 及示例用法；新增测试覆盖窗口溢出后条目完整连续
- [x] 4.2 `contextTokens` 以 `pi.compaction` / `pi.reset` 为边界按完整历史计算，删除 `contextEntries` 选项；投影测试覆盖压缩与重置
- [x] 4.3 压缩状态 `trigger` → `reason` 映射，`ChatView` 新增 `runFailure`（详情截断）与 `continuable`；投影测试通过
- [x] 4.4 gateway `session-host` / `subagent-host` 改用 `follow()`，删除手写历史合并；gateway 测试通过
- [x] 4.5 依赖 `viewState` 的测试改用共用辅助函数，`bun run test` 中这些测试通过

## 5. 继续运行与轮次上限（D5、D9）

- [x] 5.1 core `NekoSession.continue()`（`CONTINUE_BUSY:` / `CONTINUE_UNAVAILABLE:`、provider 校验），测试覆盖失败后继续、忙碌、无失败与并发
- [x] 5.2 配置文件 `maxTurns` 校验与传递，主会话与子 agent 创建时写入；测试覆盖达到上限后 `turn_limit` 与继续、非法配置报错
- [x] 5.3 gateway `continueRun` 方法、契约字段与 `continueClient` 能力探测；网关测试覆盖新旧网关
- [x] 5.4 `core-ui-strings.json` 补失败原因代码与错误前缀，`protected-terms.json` 加 `/continue`；对账测试通过

## 6. 计划原子派发（D6）

- [x] 6.1 抽出 `prepareInput()`，`respondPlan` 在一次提交内完成决定、配置与 `submit(tx)`；保留 1.4 遗留未派发决定的启动修复；plan 测试覆盖批准、修改、提交失败回滚与遗留修复

## 7. 前端

- [x] 7.1 Web：输入区上方失败提示与"继续"按钮、中英文案；Web 测试与 CJK 扫描通过
- [x] 7.2 TUI：失败提示与 `/continue` 命令、中英文案；TUI 测试与 CJK 扫描通过
- [x] 7.3 移动 API 快照可选 `runFailure` 字段与协议夹具；移动端 Dart 模型解析与失败提示、ARB 文案；`flutter test` 与 `flutter analyze` 通过

## 8. 文档与集成验证

- [x] 8.1 更新 README 与 AGENTS.md（「Pi 1.5 使用要点」：视图窗口与 transcript、pi-schema、标记形状、崩溃到限结束、submit(tx)、runFailure / continue、maxTurns）
- [x] 8.2 全量 `bun run check`、`bun run test`、`bun run build` 通过，结果写入 `verification.md`
- [x] 8.3 以 1.4 创建的存储副本原地打开验证会话、计划、问题可见并可继续，结果写入 `verification.md`
