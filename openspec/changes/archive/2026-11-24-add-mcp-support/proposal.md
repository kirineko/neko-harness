# Proposal

## Why

当前 `neko-harness` 只提供内置编码、搜索与子 agent 工具，无法接入外部 MCP（Model Context Protocol）生态（如数据库、文档库、浏览器、Issue 跟踪与远程 SaaS 工具）。上游 Pi 1.6.0 已提供独立的 `@earendil-works/pi-mcp` 客户端（覆盖 `stdio`、Streamable HTTP 与 OAuth 2.1 两段式登录），且仓库已安装的 `@earendil-works/pi-durable` 1.6.0 已内置 `codemode` 命名空间与 `tool_search` 延迟发现能力，现在可以低摩擦地为 `neko-harness` 引入完整的全局 MCP 支持，并同时满足手写 `mcp.json` 与 Web 端可视化配置两种使用方式。

## What Changes

- 新增全局 MCP 配置与运行时管理：以 `~/.neko/mcp.json`（通用 `{ "mcpServers": { ... } }` 格式）为唯一持久化真相；支持 `stdio`（`command` / `args` / `env` / `cwd`）与 `Streamable HTTP`（`url` / `headers` / `oauth`，拒绝已废弃 `sse`），支持 `${VAR}` 运行时环境变量展开（写回文件保留原模板）、文件监听热重载与损坏容错。
- 新增远程 HTTP MCP 的 OAuth 2.1 支持：基于 `@earendil-works/pi-mcp/oauth` 持久化凭据至 `~/.neko/mcp-auth.json`（0600 原子锁文件），支持自动 token 刷新、本机 loopback 回调与粘贴最终重定向 URL（兼容 SSH 端口转发或远程访问 Web），无需在 `packages/web` 新增 HTTP 回调路由。
- 新增 Durable MCP 扩展与发现策略：网关进程内每个已启用 server 维护单一共享连接，支持断线指数退避重连与 `notifications/tools/list_changed` 自动刷新，工具统一命名为 `mcp__<server>__<tool>`（命名空间 `mcp__<server>`），首期仅支持 MCP Tools（结果内嵌文本/图片/二进制资源正常转换与落盘）。
  - 无已启用 MCP 时零额外工具、零提示词开销。
  - `codemode: on / only` 会话通过 `neko-mcp` 向 `codemode` 暴露按 server 拆分的命名空间，脚本可经 `searchTools()` / `describeNamespace()` / `tools.mcp__<server>__<tool>()` 获取完整 `CallToolResult`。
  - `codemode: off` 会话自动启用 Durable 内置的 `tool_search` 扩展并渲染 `mcp_servers` 提示词段，按需加载工具；模型侧文本输出做 20KB 中间截断并落盘完整文件。
  - 单 server 支持可选 `"exposure": "auto" | "direct"`（缺省 `"auto"`）。
- 强化安全与角色边界：`plan` 模式下仅放行声明 `annotations.readOnlyHint === true` 的 MCP 工具，其余 MCP 工具在直接调用与 codemode 嵌套调用中均在执行前拒绝；`agentSyncChange` 在对账与切换 plan 模式时保留 `tool_search` 已加载的 MCP 工具；子 agent 中仅 `coder` 继承主会话 MCP 工具，`explore` / `plan` 受只读工具白名单约束不开放 MCP。
- **BREAKING** 网关新增服务器级 `neko.mcp` Chord v2 契约（状态快照订阅、增删改、原始 `mcp.json` 保存、启停、重连、OAuth 登录/粘贴回调 URL/取消/登出），应用协议版本从 `11` 升至 `12`，沿用协议版本不同即拒绝连接的既有约束。
- Web 新增 `/settings/mcp` 设置页（服务器状态与工具列表、启停与重连、OAuth 登录/登出与粘贴回调 URL、表单增删改与原始 `mcp.json` 编辑双模式、敏感值脱敏）并优化聊天区 `mcp__*` / `tool_search` 工具卡展示；TUI 新增轻量 `/mcp` 管理面板与工具卡展示优化；移动端复用现有工具卡，不新增配置入口、不提升移动 API 版本。
- 新增直接依赖 `@earendil-works/pi-mcp`（`1.6.0`，精确锁版本）。

## Capabilities

### New Capabilities

- `mcp-servers`：全局 `~/.neko/mcp.json` 配置解析、校验、原子写回与监听热重载；`stdio` / `Streamable HTTP` 连接管理、退避重连与工具列表热更新；OAuth 2.1 凭据存储（`~/.neko/mcp-auth.json`）与两段式登录（loopback 回调 + 粘贴重定向 URL）；MCP 工具命名、结果转换与截断、按 `exposure` 与 `codemode` / `tool_search` 联动暴露、以及子 agent 继承边界。

### Modified Capabilities

- `plan-mode`：扩展只读工具边界，在 plan 模式下拒绝未声明 `annotations.readOnlyHint === true` 的 MCP 工具（含 codemode 嵌套调用），并在切换 plan 模式与对账时保留 `tool_search` 已加载的 MCP 工具。
- `session-gateway`：新增服务器级 `neko.mcp` 契约以支持 MCP 配置管理、状态订阅、重连与 OAuth 登录流，并递增应用协议版本至 `12`。
- `web-ui`：新增 `/settings/mcp` 设置页（表单 + 原始 JSON 双模式配置、实时状态、工具预览与 OAuth 登录/登出）与聊天区 `mcp__*` / `tool_search` 工具卡展示优化。
- `terminal-ui`：新增 `/mcp` 管理命令与面板（状态查看、启停、重连、OAuth 登录/登出与粘贴回调 URL）、`/help` 条目与聊天区 `mcp__*` / `tool_search` 工具卡展示优化。

## Impact

- 依赖：根 `package.json` 与 `packages/core/package.json` 新增 `"@earendil-works/pi-mcp": "1.6.0"`，`pnpm-lock.yaml` 同步更新；`scripts/build-release.ts` 自动将其与 `cross-spawn` 作为外部运行时依赖保留。不升级已有 Pi 包版本。
- Core：新增 MCP 模块（`mcp-config.ts`、`mcp-auth.ts`、`mcp-manager.ts`、`mcp-tools.ts`、`mcp-types.ts` 及子路径导出）；改动 `runtime.ts`（安装 `neko-mcp` 与 `tool-search`、生命周期关闭）、`agent-change.ts`（联合 `plan` / `codemode` / `tool-search` 对账并保留已加载 MCP 工具）、`plan.ts`（非只读 MCP 守卫）、`subagents.ts`（`coder` 继承 / 只读角色隔离）、`projection.ts`（`mcp__*` 与 `tool_search` 工具摘要）、`protected-terms.json` 与 `core-ui-strings.json`。
- Gateway：`contract.ts` 新增 `NekoMcp`，`server-services.ts` / `client-session.ts` 接入服务；`APPLICATION_PROTOCOL` 升至 `12`。
- Web / TUI：Web 新增 `/settings/mcp` 路由、菜单项与组件，更新 `GatewayConnection`、store 与双语 i18n；TUI 新增 `/mcp` 面板、`/help` 与双语 i18n；移动端不改 API 契约与设置页。
- 文档：`AGENTS.md` 新增「MCP」小节并更新应用协议版本；中英文 README 补充 `mcp.json` 与设置页说明。
- 不在范围内：项目级 `<workspace>/...mcp.json` 与仓库信任体系、MCP Resources 工具（`list_mcp_resources` / `read_mcp_resource`）、legacy SSE 传输、MCP Prompts / Sampling、远程 `pi-env` 进程放置、移动端 MCP 配置入口。不发版，不主动 git commit。
