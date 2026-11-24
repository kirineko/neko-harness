# Tasks

## 1. 依赖与薄适配层

- [x] 1.1 在根 `package.json` 与 `packages/core/package.json` 的 `dependencies` 加入 `"@earendil-works/pi-mcp": "1.6.0"`，运行 `pnpm install` 更新 `pnpm-lock.yaml`；验证 `pnpm install --frozen-lockfile` 通过且仅新增 `@earendil-works/pi-mcp`（及其 `cross-spawn` 传递依赖）
- [x] 1.2 新增纯模块 `packages/core/src/mcp-types.ts`（配置结构、状态枚举、暴露模式 `auto | direct`、视图限制常量与敏感字段判定/脱敏 helper）并在 `packages/core/package.json` 导出 `./mcp` 子路径；新增 `packages/core/src/mcp-result.ts` 薄封装 `createMcpResultSchema`（含 `$ref` 重定位）与 `toMcpModelContent`（含二进制资源落盘与 20 KB 截断整合）；运行 `pnpm test packages/core/test/mcp-result.test.ts` 验证所有内容块、截断、落盘与 `$ref` 用例通过

## 2. 全局 `mcp.json` 配置、环境变量与 OAuth 凭据存储（core）

- [x] 2.1 新增 `packages/core/src/mcp-config.ts`：基于 `validateMcpServerConfig` 实现 `mcp.json` 解析与校验（含 `exposure`、拒绝 `sse` 与 `"cimd"`、检测 `mcpNamespace` 碰撞、单条错误跳过不阻断其他条目、顶层损坏保留上次有效配置）、`${NAME}` 运行时展开函数以及独占锁 + 临时文件原子写回（保留未编辑条目的 `${NAME}` 模板与顶层未知字段）；运行 `pnpm test packages/core/test/mcp-config.test.ts` 验证解析、非法条目容错、命名空间冲突、模板保留与并发写盘测试通过
- [x] 2.2 在 `mcp-config.ts` 实现目录级 `fs.watch` 热监听（250ms 防抖与自写抑制）；验证测试覆盖：外部新增/修改配置触发重载、自写不重复触发、文件改坏时保留上次有效集合并在修复后清除错误
- [x] 2.3 新增 `packages/core/src/mcp-auth.ts`：实现 `~/.neko/mcp-auth.json`（0600 权限、独占锁 + 原子写盘、按 `${mcpNamespace(name)}|${new URL(url).href}` 分键）及进程内串行 `withRefreshLock` 的 `McpOAuthServerStore`；运行 `pnpm test packages/core/test/mcp-auth.test.ts` 验证读写隔离、并发刷新锁、删除凭据与文件权限测试通过

## 3. 连接池、OAuth 2.1 两段式登录与运行时接入（core）

- [x] 3.1 新增 `packages/core/src/mcp-manager.ts`：实现单进程连接池（每启用服务器单一共享 `McpClient`，支持 `StdioTransport` 与 `StreamableHttpTransport`）、配置指纹 diff 重载、非阻塞后台连接、1s–60s 指数退避重连、手动 `reconnect`、`notifications/tools/list_changed` 自动刷新工具列表、`stderr` 尾部截取与 `close()` 优雅终止所有 stdio 进程组；运行 `pnpm test packages/core/test/mcp-manager.test.ts`（使用内存传输与本地测试 stdio/HTTP fixture server）验证连接、重连、通知刷新、禁用/删除清理与关闭无残留子进程
- [x] 3.2 在 `McpManager` 接入 `@earendil-works/pi-mcp/oauth`：为无 `Authorization` 头的 HTTP 服务器装配 `createMcpAuthProvider`，识别 401/`insufficient_scope` 转 `auth_required`；实现 `beginSignIn`（先刷新后起 `listenForLoopbackSignIn` + `startMcpSignIn`，10 分钟 TTL 单活流，loopback 回调自动完成并重连）、`pasteSignIn`（`responseFromRedirectUrl` + `completeMcpSignIn`）、`cancelSignIn` 与 `signOut`；运行 `pnpm test packages/core/test/mcp-oauth.test.ts`（本地 mock OAuth 授权服务器）验证静默刷新、loopback 回调完成、粘贴重定向 URL 完成、错 `state` 拒绝、登出清除与快照零令牌泄露
- [x] 3.3 将 `McpManager` 接入 `packages/core/src/runtime.ts`（`NekoRuntimeOptions` 新增可选 `mcpConfigPath` / `mcpAuthPath`，对外暴露配置读写、状态查询/变更订阅、重连与 OAuth 方法，`runtime.close()` 优先关闭 MCP 管理器）；更新 `AGENTS.md` 中的 MCP 运行时约定并验证 `packages/core` 相关测试通过

## 4. Durable 扩展、`codemode` / `tool_search` 联动与只读/子 Agent 护栏（core）

- [x] 4.1 新增 `packages/core/src/mcp-tools.ts`：实现固定名 `neko-mcp` Durable 扩展与 `tool-search` 扩展构建逻辑——确定性跨服工具命名与哈希消歧、输入 schema 规范化、`replay: "unsafe"`、双通道结果（模型侧 20 KB 截断落盘 + 脚本侧完整 `CallToolResult`）、`exposure: "auto" | "direct"`、`mcp_servers` 提示词段（仅 `codemode: off` 且存在延迟服务器时渲染），以及 `wrapSection("codemode")` / `wrapTool("codemode")` 将 `neko-mcp` 按已启用服务器虚拟展开为独立 `mcp__<server>` namespace；无已启用 MCP 时 `tool-search` 为空扩展；运行 `pnpm test packages/core/test/mcp-tools.test.ts` 验证零 MCP 零开销、`codemode: off` 经 `tool_search` 发现调用、`codemode: on/only` 经脚本 `searchTools()` / `describeNamespace()` / `tools.mcp__*()` 调用与 `direct` 暴露行为
- [x] 4.2 更新 `packages/core/src/agent-change.ts`：`agentChangeFor` 在 `codemode: off` 保留 `tool-search`、在 `on/only` 移除 `tool-search`；`agentSyncChange` 在对账与切换 `plan` 模式时保留 `modelTools.add` 中已由 `tool_search` 加载的 `mcp__*` 工具名；运行 `pnpm test packages/core/test/agent-change.test.ts` 验证全部模式组合与进出 plan 模式后已加载 MCP 工具不丢失
- [x] 4.3 更新 `packages/core/src/plan.ts` 与 `packages/core/src/subagents.ts`：`plan` 模式下在 `beforeTool` 与工具执行端拦截未声明 `annotations.readOnlyHint === true` 的 MCP 工具（含 codemode 嵌套调用），放行 `readOnlyHint: true` 的 MCP 工具与 `tool_search`；确认子 agent 中仅 `coder` 继承 MCP 工具，`explore` 与 `plan` 保持完全隔离；运行 `pnpm test packages/core/test/plan.test.ts packages/core/test/subagents.test.ts` 验证新增拦截、放行与角色边界测试通过

## 5. 投影、网关契约与协议升级（core / gateway）

- [x] 5.1 更新 `packages/core/src/projection.ts` 的 `summarizeToolCall`：为 `mcp__*` 解析并展示 `server / tool` 与紧凑参数摘要，为 `tool_search` 展示检索词与已加载工具结果；更新 `packages/core/src/i18n/protected-terms.json`（登记 `/mcp`、`mcp.json`、`MCP`、`tool_search`、`OAuth`）与 `packages/core/test/fixtures/core-ui-strings.json`；运行 `pnpm test packages/core/test/projection.test.ts packages/core/test/core-ui-strings.test.ts` 验证通过
- [x] 5.2 在 `packages/gateway/src/contract.ts` 新增 `NekoMcp` 契约（`neko.mcp`，状态快照 + CRUD/原始 JSON/启停/重连/OAuth 方法），在 `server-services.ts` 串行接入写操作与状态广播，在 `client-session.ts` 与 `index.ts` 暴露客户端句柄，并将 `APPLICATION_PROTOCOL` 递增至 `12`（同步更新 `AGENTS.md`）；运行 `pnpm test packages/gateway` 验证多端同步、非法提交拒写、OAuth 零令牌透传与协议版本不兼容拒绝测试通过

## 6. Web `/settings/mcp` 与工具卡（web）

- [x] 6.1 更新 `packages/web/src/client/lib/gateway.ts`、`store.ts` 与 `bootstrap.ts` 订阅 `neko.mcp` 并暴露操作方法；更新 `packages/web/src/client/components/settings-shell.tsx` 与路由注册 `/settings/mcp`；补齐 `packages/web/src/client/lib/i18n/{zh,en}.ts` 双语文案与 `core-text.ts` 映射；验证 `pnpm --filter @neko-harness/web run check:client` 类型检查通过
- [x] 6.2 实现 `/settings/mcp` 页面与组件（服务器状态卡片、工具折叠列表、错误与 stderr 尾部展示、启停/重连/删除、表单增删改含 stdio/HTTP/高级 OAuth 字段与敏感值遮罩、原始 `mcp.json` 编辑器切换、OAuth 登录新标签页打开 + 粘贴回调 URL + 取消 + 登出、网关未就绪时禁用全部操作）；优化聊天区 `mcp__*` / `tool_search` 工具卡展示；运行 `pnpm test packages/web` 验证组件交互测试、双语对账与 CJK 扫描测试全部通过

## 7. TUI `/mcp` 面板与工具卡（tui）

- [x] 7.1 新增 `packages/tui/src/mcp-ui.ts` 并接入 `/mcp` 命令（含 `/mcp paste <url>`）、`/help` 条目与斜杠补全：实时展示服务器状态/工具数/错误，支持启停、重连、发起 OAuth 登录（打开或输出授权链接）与登出，网关未就绪时禁止提交；优化 TUI 工具卡中 `mcp__*` 与 `tool_search` 的标题与摘要渲染；补齐 `packages/tui/src/i18n/{zh,en}.ts` 双语文案；运行 `pnpm test packages/tui` 验证面板交互、渲染与 CJK 扫描测试通过

## 8. 文档同步与全量集成验证

- [x] 8.1 更新中英文根目录 `README`（遵循 `docs/README.md` 规则）与 `AGENTS.md` 的「MCP」小节，给出标准 `~/.neko/mcp.json` 配置示例并用 `mcp-config` 测试验证示例合法
- [x] 8.2 运行 `pnpm build && pnpm check && pnpm test`（如遇并行时序问题用 `pnpm test:serial` 复现），确认全仓库构建、Biome/类型检查与单测/集成测试全绿
- [x] 8.3 运行 `pnpm build:release && pnpm test:package`，确认发布产物中 `@earendil-works/pi-mcp` 与 `cross-spawn` 保持为外部依赖，且打包后的 `neko` 网关能加载 `mcp.json` 并正常启动与退出

## Workflow follow-up

- 评审并实现完成后归档 `add-mcp-support` 变更，将新能力 `mcp-servers` 与各 delta specs 同步到 `openspec/specs/`。
- 发版时在 `docs/releases/vX.Y.Z.md` 注明：新增全局 MCP 支持（`~/.neko/mcp.json`、Web `/settings/mcp`、TUI `/mcp`、OAuth 2.1、`codemode`/`tool_search` 联动），应用协议升至 `12`。
