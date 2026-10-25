# Tasks

## 1. 依赖与前置验证

- [x] 1.1 在根 `package.json` 的 `dependencies` 加入 `"@earendil-works/pi-codemode": "1.4.0"`，运行 `bun install` 更新 `bun.lock`；验证 `bun install --frozen-lockfile` 通过，且锁文件只新增这一个直接依赖
- [x] 1.2 写一个临时探针（放 `/tmp`，用完删除）确认 D3 的三个前提：未显式配置时新安装扩展是否默认生效；`modelTools` 数组能否点名 deferred 工具；嵌套调用的 `getTask(...).input` 中 `kind: "nested"` 的字段。把结论记录进 `design.md` 的对应决定，并删除探针
- [x] 1.3 用 `MemoryStorage` + faux provider 写一个最小的 Bun 测试，安装 `createCodemodeExtension({ sandbox, models: false })`，跑通「脚本调用 read 并输出」以及 `sandbox.close()` 后进程能正常退出；验证 `bun run test` 中该用例通过，且 `--parallel` 下不挂起

## 2. 模式数据与设置解析（core）

- [x] 2.1 新增纯模块 `packages/core/src/codemode-mode.ts`（取值列表、校验、`CODEMODE_LIMITS`、`CODEMODE_VIEW_LIMITS`），并在 `packages/core/package.json` 导出子路径 `./codemode-mode`；验证新单测覆盖合法与非法取值
- [x] 2.2 `config.ts` 解析 `codemode.mode`，非法值报错并指出字段，配置合并规则与 `context` 相同；验证 `config` 测试新增的成功与失败用例
- [x] 2.3 定义 `app.neko.codemode-settings`（根会话）与 `app.neko.codemode`（会话级，rewindable / asOf，`checkpointWhen: () => false`），实现「保存值 > 配置 > off」的解析与来源报告，以及 set / reset；验证单测覆盖逐级回落和持久化失败时状态不变
- [x] 2.4 `createConversation` 与 `forkConversation` 写入或继承会话模式，子 agent 创建时复制主会话的模式；验证测试覆盖：修改设置不影响已有会话、分叉继承、子 agent 继承、缺失文档视为 off

## 3. 扩展安装与工具配置统一计算（core）

- [x] 3.1 在 `runtime.ts` 创建 `CodemodeSandbox`（256 MiB，带 `onWorkerStarted` / `acquireWorker`），安装 `createCodemodeExtension({ sandbox, models: false })`；关闭运行时先关 sandbox 再关 Harness；验证 1.3 的用例改为走 `createNekoRuntime` 后仍通过
- [x] 3.2 实现纯函数 `agentChangeFor({ plan, codemode, role })`（D3 表），用它替换 `planAgentChange`；验证单测覆盖 6 种组合加子 agent 角色，且 plan 模式现有测试全部通过
- [x] 3.3 把 `syncPlanAgent` 改成 `syncAgent`（比较工具名、`modelTools`、扩展名、instructions），保持原有调用点；验证测试覆盖：only 模式进出 plan 后工具集正确；升级前会话（无文档）在启动对账后不再有 `codemode`；崩溃于「文档已写、配置未应用」后重启自愈
- [x] 3.4 `subagent` 工具改为 `callers: ["model"]`，子 agent 工具过滤放行 `codemode`；验证测试：脚本调用 `tools.subagent` / `tools.ask_user` 得到错误且无副作用；explore 子 agent 脚本中的 bash 进入审批，拒绝后脚本收到错误
- [x] 3.5 验证 plan 模式下脚本调用 `tools.edit` 与不安全的 `tools.bash` 均在执行前被拒绝（新增集成测试）
- [x] 3.6 实现 D6 的 worker 上限（`wrapTool(codemode)` 排队等待空位、可中止、60 秒超时，名额在 worker 退出时释放）；验证测试：用较小的上限构造排队、超时错误、停止会话时中止等待

## 4. 提示词规则（core）

- [x] 4.1 `buildRules` 改用「`agent.tools` 再加只在 `callable` 中的名字」，并新增 `TOOL_GUIDELINES.codemode`（Pi 原文）；验证 prompt 测试：off 模式系统提示词逐字节不变（快照）、only 模式保留 edit / bash 规则、codemode 规则只出现一次

## 5. 本次改动纳入嵌套调用（core）

- [x] 5.1 用 `wrapTool` 包装 edit / write：嵌套调用成功后把记录写入 `app.neko.nested-changes`（rewindable / asOf，按 `CHANGE_LIMITS` 截断）
- [x] 5.2 `ConversationChanges` / `ChangeTracker` 合并嵌套记录：只计入父 codemode toolCall 在当前分支可见的记录，位置记为父调用的位置，文档变化时 revision 递增；验证 `file-changes` 测试覆盖：脚本内成功与失败的 edit、脚本失败或中止后已成功改动仍计入、回溯与分叉后不出现、子 agent 脚本的执行者标注

## 6. 投影、网关契约与协议（core / gateway）

- [x] 6.1 `projection.ts` 新增 `codemode` 字段：运行中取自 `pi.live.nestedTools`，结束后取自结果的 `details.calls`；上限 100 条加 `omitted`；`summarizeToolCall` 增加 codemode 分支；验证 `projection.test.ts` 覆盖运行中、结束、取消与超出上限
- [x] 6.2 网关 `ChatViewSchema`（item 与 streaming）加入可选字段；新增 `neko.codemode-settings` 契约及其服务端与客户端；`APPLICATION_PROTOCOL` 改为 10；验证 gateway 测试：双端同步、reset、非法值、协议不兼容被拒、旧客户端忽略新字段
- [x] 6.3 移动 `mobile/projection.ts` 与 `protocol.ts` 加入可选的 `codemode` 字段，不提高移动 API 版本；验证 mobile 网关测试覆盖字段内容与上限
- [x] 6.4 `conversation-export.ts` / `conversation-export-html.ts` 呈现 codemode（JS 代码块、嵌套调用列表、输出；JSON 含字段）；验证导出测试快照

## 7. Web

- [x] 7.1 `GatewayConnection` 与 store 接入 codemode 设置；新增 `/settings/codemode` 页面并加入设置菜单（状态未到达时禁用）；补齐中英文案；验证 Web 测试：选择、恢复默认、跨标签页同步、未就绪禁用
- [x] 7.2 新增 codemode 工具卡（高亮脚本、嵌套调用列表、输出、完整输出路径、省略数量），在 `message-list` 中选用；验证 Web 组件测试与 CJK 扫描测试通过

## 8. TUI

- [x] 8.1 新增 `/codemode` 面板与 `/help` 条目，补齐中英文案；验证 TUI 测试：选择、恢复默认、未就绪不可提交
- [x] 8.2 `ToolExecutionComponent` 加入 codemode 分支（折叠时 8 条加「还有 N 条」）；验证 TUI 渲染测试与 CJK 扫描测试通过

## 9. 移动端

- [x] 9.1 Dart `ToolInfo` 解析可选的 `codemode` 字段，`ToolCard` 增加展开区，ARB 补齐中英文案并重新生成 l10n；验证 `flutter test` 与 Dart 字面量扫描测试通过，缺少字段时按普通工具项显示

## 10. 文案对账与文档

- [x] 10.1 `protected-terms.json` 加入 `codemode`、`/codemode`；如有新的 core 推送文案，同步更新 `core-ui-strings.json`；验证三端字典测试与 `core-ui-strings.test.ts` 通过
- [x] 10.2 更新 AGENTS.md（新增「Codemode」小节：三种模式、数据位置、`agentChangeFor` / `syncAgent`、嵌套改动记录、worker 上限；应用协议改为 10）以及 README 中的配置说明（中英文各自遵循 `docs/README.md` 的规则）；验证文档中的配置示例能被 `config.ts` 接受

## 11. 集成检查

- [x] 11.1 运行 `bun run check` 与 `bun run test`，全部通过；有可疑的并行问题时用 `bun run test:serial` 复现
- [x] 11.2 运行 `bun run build:release` 与 `bun run test:package`，确认发布产物中 pi-codemode 为外部依赖，并能在打包后的 gateway 里跑通一次脚本
- [x] 11.3 手动验收（需要 `DEEPSEEK_API_KEY`）：分别以 on / only 模式新建会话，让模型用 codemode 批量读文件并编辑一个文件；检查 Web / TUI 卡片、「本次改动」，以及运行中强制结束网关后重启能继续执行；把 DeepSeek 写脚本的质量结论记入 `design.md` 的 Open Questions

## Workflow follow-up

- 评审通过后归档本变更，并把 delta 同步到主 specs。
- 发版时在 `docs/releases/vX.Y.Z.md` 写明：新增 codemode（默认关闭）、应用协议升到 10。
