# Design

## Context

- 动机与业务范围见 [proposal.md](./proposal.md)，外部行为要求见各 capability 的 `specs/*/spec.md`。
- 技术前提（已对照仓库当前 `1.6.0` 已安装依赖与 `reference/pi` 核实）：
  - `@earendil-works/pi-mcp@1.6.0` 是独立包（仅运行时依赖 `cross-spawn`），包含 `McpClient`、`StdioTransport`、`StreamableHttpTransport`、`validateMcpServerConfig`、`createMcpToolName`、`mcpNamespace`、`mcpServerSummary`、`normalizeMcpInputSchema`、`toLlmContent`、`limitMcpContent`，以及 `@earendil-works/pi-mcp/oauth`（两段式 `startMcpSignIn` / `completeMcpSignIn`、`listenForLoopbackSignIn`、`responseFromRedirectUrl`、`createMcpAuthProvider`、`OAuthCallbackServer`）。
  - `reference/pi/packages/mcp` 的 `Unreleased` 新增了 `createMcpResultSchema` 与 `toMcpModelContent` 两个纯 helper（1.6.0 发布包尚未导出）。
  - 已安装的 `@earendil-works/pi-durable@1.6.0` 已内置：
    - `Extension.namespace: ToolNamespace`，`createCodemodeExtension` 会渲染每个选中扩展的 namespace（无工具时也占位，保持 prompt cache 稳定），并从内联预算中跳过 `deferred: true` 工具；
    - `@earendil-works/pi-durable/tool-search`（`createToolSearchExtension()`），搜索 `agent.deferred` 并经 `control: { addTools }` 写入 `AgentDoc.modelTools.add`；
    - `Registry.install(同名扩展)` 支持原地热替换；`wrapSection` / `wrapTool` 可按会话动态裁剪或重组扩展视图；
    - `ToolExecutionResult` 原生区分 `output`（给模型）与 `structuredOutput`（给 codemode 脚本）。
  - `neko-harness` 是单机单网关架构（`packages/core` + `packages/gateway`），所有会话共享一个 `Harness` 与一个 `Registry`。会话工具配置目前由 `packages/core/src/agent-change.ts`（`agentChangeFor` / `agentSyncChange`）统一按 `PlanDoc` × `CodemodeDoc` 计算；`subagents.ts` 在子会话创建时按 `enabledTools(agent)` 与 `READ_TOOLS` 固化子 agent 工具与扩展数组；Web / TUI 均通过 Chord v2 契约直连 gateway（当前 `APPLICATION_PROTOCOL = 11`）。

## Goals / Non-Goals

**Goals:**
- 以 `~/.neko/mcp.json` 为单一持久化真相，保证手写文件与 Web 端可视化配置零冲突、零墓碑。
- 复用 `@earendil-works/pi-mcp` 与 `@earendil-works/pi-durable` 既有的协议、OAuth、codemode 与 `tool_search` 能力，只做薄封装与生命周期/UI 编排。
- 零 MCP 服务器时对现有会话保持零工具、零提示词开销。
- 在单共享 `Registry` 下，同时让 `codemode: off`、`codemode: on`、`codemode: only`、`plan` 模式与 `coder`/`explore`/`plan` 子 agent 各自获得正确的工具视图与安全护栏。

**Non-Goals:**
- 不引入项目级 `<workspace>/...mcp.json`、工作区 lease 或跨机器 `PipeTransport`（从而避免 p2 的 per-location variant 复杂度）。
- 不在 `packages/web` 的静态 HTTP 服务器上新增 OAuth 回调路由；统一通过 `pi-mcp/oauth` 的本机 loopback 回调 + 粘贴重定向 URL 覆盖本机与远程/SSH 转发场景。
- 不实现 MCP Resources 工具、Prompts、Sampling 或旧版 SSE 传输。

## Decisions

### D1 依赖锁定与 1.6.0 薄适配层

- 在根 `package.json` 与 `packages/core/package.json` 的 `dependencies` 新增 `"@earendil-works/pi-mcp": "1.6.0"`，与其他 `@earendil-works/*` 保持完全同版本锁。
- `scripts/build-release.ts` 会自动把根 `dependencies` 保持为 external，因此 `@earendil-works/pi-mcp` 及其唯一依赖 `cross-spawn` 随 npm 安装，不打进单文件 bundle，兼容 Windows/macOS/Linux。
- 由于 `createMcpResultSchema` 与 `toMcpModelContent` 在 `pi-mcp` 1.6.0 尚未导出，我们在 `packages/core/src/mcp-result.ts` 实现一份与 `reference/pi/packages/mcp/src/{result-schema,model-content}.ts` 语义一致的薄封装（约 150 行纯函数，依赖 `toLlmContent` 与 `limitMcpContent`），后续升级 Pi 至 1.7+ 时直接替换为上游导入。
- 备选方案：引入官方 `@modelcontextprotocol/sdk`。会带来额外传递依赖且与 Pi 的命名/截断/OAuth helper 割裂，不采用。

### D2 全局 `mcp.json` 单一真相、校验、原子写回与监听

- 默认路径为 `join(dirname(storagePath), "mcp.json")`（即 `~/.neko/mcp.json`，可通过 `NekoRuntimeOptions.mcpConfigPath` 覆盖供测试隔离）。
- 纯模块 `packages/core/src/mcp-types.ts`（导出子路径 `@neko-harness/core/mcp`）集中定义前后端共用的配置类型、状态枚举、限制常量与名称/脱敏辅助函数。
- 解析器 `packages/core/src/mcp-config.ts`：
  - 基于 `validateMcpServerConfig(name, raw)`（不传 `checkMetadataDocumentCallback`，故 `"clientRegistration": "cimd"` 被明确拒绝，因为 neko 不托管公网 CIMD 文档），再校验 neko 扩展字段 `exposure?: "auto" | "direct"`（缺省 `"auto"`）。
  - 检查 `mcpNamespace(name)` 冲突（如 `a-b` 与 `a_b`），冲突时拒绝后者并写入 `errors`。
  - 单条非法时跳过并记录到 `configErrors`，顶层 JSON 语法错误或非对象时保留上次有效解析结果并在 `configError` 字段报告。
- 原子写回：复用与 `credentials.ts` 相同的独占锁 + 临时文件 + `renameWithRetry` 写盘模式，保证多并发请求串行且不写坏文件；同时保留顶层未知字段与非编辑条目的原始 `${VAR}` 模板。
- 文件监听：对 `mcp.json` 所在目录使用 `fs.watch` + 250ms 防抖（兼容编辑器原子 rename 保存），并通过自写标记/mtime+内容哈希抑制网关自身写回触发的冗余重载。
- 环境变量展开：`expandEnvTemplate(value, env)` 仅在连接前与发起 OAuth 前执行，识别 `${NAME}`，缺失时抛可读错误使该服务器进入 `error` 状态而不影响其他服务器。
- 备选方案：SQLite Doc 存 Web 修改再与只读 `mcp.json` 合并。对列表项增删改需要墓碑机制，用户打开文件与界面不一致，体验差，不采用。

### D3 OAuth 2.1 凭据存储与两段式登录流

- 凭据存储 `packages/core/src/mcp-auth.ts`：管理 `join(dirname(storagePath), "mcp-auth.json")`（0600 权限，独占锁 + 原子 rename 写盘），键名为 `${mcpNamespace(name)}|${new URL(url).href}`（与 Pi 一致：同 URL 不同服务器名各自独立登录），实现 `McpOAuthServerStore`；`withRefreshLock` 用进程内按 key 串行的 Promise 链即可（单网关单数据目录）。
- 判定规则：未配置 `Authorization` 请求头的 HTTP 服务器自动装配 `createMcpAuthProvider({ serverUrl, store, settings: config.oauth ?? {}, clientName: config.oauth?.clientName ?? "neko-harness" })`。连接或工具调用遇到 `McpAuthRequiredError` / `McpOAuthAuthorizationRequiredError` 时，该服务器转入 `auth_required` 状态，保留 `challenge`（含 `resourceMetadataUrl` / `scope`）以支持 step-up scope。
- 登录流（`McpManager` 内存态，单服务器单活，10 分钟 TTL）：
  1. `beginSignIn(server)`：先以 `listenForLoopbackSignIn` 起临时 `OAuthCallbackServer`，再调用 `startMcpSignIn`。若返回 `{ kind: "authorized" }`（refresh token 刷新成功），关闭回调并立刻重连，直接返回 `{ status: "authorized" }`。
  2. 若返回 `{ kind: "redirect", authorizationUrl, redirectUrl, state, scope }`：登记活动登录流，后台继续监听 loopback 回调（命中则自动调用 `completeMcpSignIn`、关闭回调、清理流并重连服务器），同时立即把 `{ status: "redirect", id, authorizationUrl }` 返回给 Web/TUI。
  3. `pasteSignIn(id, pastedUrl)`：通过 `responseFromRedirectUrl(pastedUrl, authorization)` 解析并校验 `state` 与路径，执行 `completeMcpSignIn`、关闭 loopback 监听、清理流并重连服务器。
  4. `cancelSignIn(id)`：中止 AbortController、关闭 loopback 监听并清除流。
  5. `signOut(server)`：清除 `mcp-auth.json` 对应条目，中止进行中的登录流并触发重连（回到 `auth_required`）。
- 令牌永不进入网关快照、日志或工具结果。
- 备选方案：在 `packages/web` 增设 `/mcp/callback` 路由。`neko web` 运行在 `127.0.0.1:8322` 且不承担公网反代职责，loopback + 粘贴 URL 已完整覆盖本机浏览器、TUI 与 SSH 端口转发，无需把 OAuth 状态耦合进静态 Web 服务器。

### D4 连接池、重连策略与生命周期

- `packages/core/src/mcp-manager.ts`（单进程内唯一实例，随 `createNekoRuntime` 创建，`runtime.close()` 时优先关闭）：
  - 每个启用中的服务器对应一个 `ServerRuntime`：保存配置指纹（`configHash`）、`McpClient` 实例、状态机（`disabled | connecting | connected | disconnected | auth_required | error`）、`tools`、服务器 `instructions`、`stderrTail`（受 `pi-mcp` 64 KiB 限制，向前端快照再截断至 4 KiB）、`lastError`、`reconnectAttempt`。
  - 配置重载时按 `configHash` diff：未变化的已连接服务器保持原连接不断开；新增/变更的重建连接；禁用/删除的关闭连接并释放子进程。
  - 启动不阻塞 `createNekoRuntime`：连接在后台异步发起（提供 `waitForReady(timeoutMs)` 供集成测试使用）；运行中若首轮工具调用遇到 `connecting` 中的服务器，短暂等待（最多 5 秒）或直接返回明确状态错误。
  - 退避重连：非认证错误断开后按 1s -> 2s -> 4s ... 上限 60s 退避重连；`auth_required` 与 `disabled` 不自动循环重试；手动 `reconnect(server)` 立刻清零退避并重连。
  - 监听 `client.onNotification("notifications/tools/list_changed", ...)`，触发重新 `listTools()` 并通知工具扩展重建与快照广播。
  - `stdio` 的 `cwd`：展开 `~/`，相对路径相对于 `defaultCwd`（或未指定时 `homedir()`）；`McpClient` 的 `roots` 留空（全局共享进程，不绑定单会话目录）。

### D5 Durable 扩展 `neko-mcp`、`tool-search` 与 `agent-change.ts` 联合对账

```text
Registry (共享):
  - codemode       : createCodemodeExtension({ sandbox, models: false })
  - tool-search    : 无启用 MCP -> tools: [] ；有启用 MCP -> [createToolSearchTool()]
  - neko-mcp       :
      tools        : 所有已连接启用服务器的 mcp__<server>__<tool>
                     (exposure="auto" -> deferred: true; exposure="direct" -> 非 deferred)
      sections     : [mcp_servers] (仅在会话 codemode==="off" 且存在 deferred MCP 服务器时渲染)
      wraps        :
        - wrapSection("codemode") : 把 agent.extensions 中的 neko-mcp 虚拟展开为每启用 server
                                    一个 { name: "mcp:<server>", namespace, tools } 供 codemodeSection 渲染
        - wrapTool("codemode")    : 同上，包装 api.agent() 使脚本内 searchTools / describeNamespace
                                    按 server 命名空间分组与检索
        - wrapTool("tool_search") : 若 tool_search 存在，正常检索 agent.deferred
```

为什么采用「单一固定名 `neko-mcp` 扩展 + `wrapSection/wrapTool` 虚拟展开 namespace」而非「每个 server 一个真实扩展」：
1. `subagents.ts` 在子会话创建时把 `agent.extensions` 固化为扩展名数组；固定名 `neko-mcp` 不会在配置变化后留下失效扩展名或破坏已有子会话结构。
2. 即使某个已启用 server 尚在连接中或待登录，虚拟展开仍会为它输出 `## mcp__<server>` 占位 namespace（无工具时也可提示需登录），避免连接前后改变 system prompt 结构导致缓存失效。
3. `registry.install(nekoMcpExtension)` 与 `registry.install(toolSearchExtension)` 原地热替换即可同步全部主会话，不写入任何会话文档。

`agent-change.ts` 调整：
- `agentChangeFor({ plan, codemode, role })` 新增 `tool-search` 扩展选择规则：
  - `codemode === "off"`：移除 `codemode` 扩展（保留 `tool-search`，当无启用 MCP 时 `tool-search` 为空扩展，零开销）。
  - `codemode === "on" | "only"`：移除 `tool-search` 扩展，保留 `codemode` 扩展。
- **保留 `tool_search` 已加载工具**：`agentSyncChange` 读取当前 `AgentDoc.modelTools`（或解析后已加载的 deferred `mcp__*` 工具名），在非 `only` 模式生成 `modelTools` 变更时（如进出 `plan` 模式），保留已加载的 `mcp__*` 名称在 `modelTools.add` 中，不再用 `null` 或 `{ add: ["submit_plan"] }` 覆盖清零。
- 提示词规则 `prompt/prompt.ts`：`tool_search` 不需要额外硬编码规则（其工具描述本身已包含完整引导）；MCP 工具也不写死规则。

### D6 工具命名、双通道输出与临时文件落盘

- 命名与冲突处理：跨所有已启用服务器先按规范化后的原始名分组，凡超 64 字符或任意两工具发生碰撞的均通过 `createMcpToolName(server, tool, () => true)` 追加 8 位 sha256 后缀，保证名称与服务器排序无关且重启稳定。
- 单次 `execute(args, api, context)`：
  - 通过 `McpManager.callTool(server, tool.name, args, { signal: context.abortSignal })` 发起调用（使用服务器配置的 `timeout` 或默认 60s，progress 通知自动续期）。
  - `output`（模型通道）：经 `toMcpModelContent` + `limitMcpContent(content, saveOutput)`，超 20 KB 文本截断并经 `api.env.createTempDir("neko-mcp-")` 写入临时文件；非图片二进制资源同样写入临时文件返回路径。
  - `structuredOutput`（codemode 脚本通道）：通过 `structuredOutputSchema: createMcpResultSchema(tool.outputSchema)` 返回去 `_meta` 后的完整 `CallToolResult`（`{ content, structuredContent, isError }`），脚本可自行过滤大段结果而不污染上下文。
  - `details`：`{ server, tool: tool.name, ...(fullOutputPath ? { fullOutputPath } : {}) }`，供投影层与 UI 优化展示。

### D7 `plan` 模式只读护栏与子 Agent 边界

- **Plan 模式**：
  - `McpManager` 维护已注册工具的 `readOnlyHint` 查询表（`tool.annotations?.readOnlyHint === true`）。
  - 在 `neko-plan` 的 `ToolTask.beforeTool` 钩子与 `neko-mcp` 工具 `execute()` 中做双重校验：若当前会话 `PlanDoc.mode === "plan"` 且工具属于 MCP 且非 `readOnlyHint === true`，直接拦截并返回明确提示（同时覆盖模型直接调用与 codemode 嵌套调用）。
  - `tool_search` 本身只读且不产生副作用，plan 模式下保持可用，使模型在 `codemode: off` + `plan` 模式下仍可检索并调用只读 MCP 工具。
- **子 Agent**：
  - `subagents.ts` 中 `READ_TOOLS` 不包含 `mcp__*` 与 `tool_search`，因此 `explore` / `plan` 子 agent 既不会获得 MCP 工具，也无法在 `codemode` 脚本中调用它们；
  - `coder` 角色走 `enabledTools(agent)` 排除 `subagent`/`job`/`MAIN_ONLY_TOOLS`，天然继承主会话当前已启用的 MCP 工具（在 `codemode: off` 时一并保留 `tool_search`，在 `on/only` 时经 `codemode` 调用）。

### D8 网关 `neko.mcp` 契约与协议版本 12

- `packages/gateway/src/contract.ts` 新增 `NekoMcp = remote("neko.mcp", { version: 1, params: {}, hostAddress: () => GATEWAY_ADDRESS, variants: { ready: { state: { snapshot: McpStateSchema }, methods: ... } } })`：
  - `snapshot` 字段：`revision`、`configPath`、`configError`（顶层解析错误）、`entryErrors`（单条跳过错误）、`rawJson`（当前磁盘文本，供原始 JSON 编辑器加载，不展开 `${VAR}`）、`servers`（每项含 `name`、`transport: "stdio" | "http"`、`config`、`enabled`、`exposure`、`status`、`error`、`stderrTail`、`tools`、`oauth: { supported, signedIn }`）、`signIns`（进行中的登录流 `{ id, server, status: "waiting" | "failed", authorizationUrl, error? }`）。
  - 方法：`upsertServer`、`removeServer`、`setEnabled`、`saveRawConfig`、`reconnect`、`beginSignIn`、`pasteSignIn`、`cancelSignIn`、`signOut`。
- `server-services.ts` 接入 `mcpHub`（`createStateHub`），订阅 `runtime.onMcpChange` 广播更新；所有写操作经单串行队列防并发写冲突；`client-session.ts` 暴露 `client.mcp`。
- `APPLICATION_PROTOCOL` 由 `11` 升至 `12`（遵循项目既有规则，不维持旧协议降级）。
- 投影层 `packages/core/src/projection.ts`：
  - `summarizeToolCall` 新增 `tool_search` 分支（显示 `query`）与 `mcp__*` 分支（从 `details` 或名称前缀解析 `server / tool` 并展示紧凑参数摘要）。移动端直接复用投影后的 `args` / `name`，不改移动协议版本。

### D9 Web `/settings/mcp`、TUI `/mcp` 与 i18n 对账

- **Web**：
  - `settings-shell.tsx` 菜单新增 `mcp` 项（`/settings/mcp`，位于 `codemode` 下方），`GatewayConnection` 与 `store.ts` 接入 `mcpState`。
  - 页面顶部支持「列表 / 原始 `mcp.json`」切换；服务器卡片展示状态徽标（图标 + 文字）、启停开关、工具数折叠面板、错误/stderr 折叠区、重连/编辑/删除按钮，以及 OAuth 登录/登出/粘贴回调 URL 区；表单弹窗/抽屉支持 stdio / HTTP 切换、键值对行编辑（敏感值密码框 + 显示切换）与高级项（timeout、exposure、oauth 可选字段）。
- **TUI**：
  - 新增 `packages/tui/src/mcp-ui.ts` 与 `/mcp` 命令（含 `/mcp paste <url>` 子命令），沿用 `/codemode` 与 `/jobs` 的面板交互模式；选中服务器后支持启停、重连、发起 OAuth 登录（用平台默认浏览器打开或输出 URL）、登出。
- **文案与术语对账**：
  - `packages/core/src/i18n/protected-terms.json` 新增 `/mcp`、`mcp.json`、`MCP`、`tool_search`、`OAuth` 等受保护术语。
  - Web 与 TUI 中英文字典同步补齐，遵守 CJK 扫描测试与 `core-ui-strings.json` 错误前缀对账。

## Risks / Trade-offs

- **[Risk] 部分远程 OAuth MCP 仅接受白名单内的固定 `client_name` 或预注册 `clientId`** → 在 `mcp.json` 与 Web 高级选项完整透传 `oauth.clientId`、`oauth.clientSecret`、`oauth.clientName`、`oauth.callbackPort`、`oauth.callbackUrl`、`oauth.scope`、`oauth.authServerMetadataUrl`，与 Pi 一致。
- **[Risk] Windows 上 `npx` / `uvx` 等 `.cmd` 包装器在无 shell 启动时失败** → 依赖 `@earendil-works/pi-mcp` 内置的 `cross-spawn` 处理 Windows 可执行文件与 `.cmd` 解析，并在 CI/冒烟中纳入打包校验。
- **[Risk] 某些 MCP 服务器在工具多或启动慢时拖慢首轮体验** → 网关启动不阻塞于 MCP 连接，命名空间提前占位；首轮工具调用若命中 `connecting` 中服务器做有界短等（最多 5s）而非无限挂起。
- **[Risk] 原始 JSON 编辑器与表单编辑并发保存** → 网关侧对 `mcp.json` 写操作串行加锁，并可通过 `revision` 或保存后以最新快照回填避免覆盖丢失。
- **[Risk] `pi-mcp` 1.6.0 与 `reference/pi` main 的小幅接口差（`createMcpResultSchema` / `toMcpModelContent`）** → 隔离在单一内部文件 `packages/core/src/mcp-result.ts` 并配完整单测，未来升 Pi 时一步替换。

## Migration Plan

- `APPLICATION_PROTOCOL` 升至 `12`，遵循项目既有客户端/网关版本匹配提示流程（重启 `neko web` / `neko tui` / `neko serve` 即可）。
- 已有用户无需迁移数据：不存在 `~/.neko/mcp.json` 时行为与升级前完全一致，零额外工具或提示词变化。
- 回滚策略：移除 `~/.neko/mcp.json` 或回退版本即可恢复；SQLite 存储无结构性破坏变更（未新增必需迁移的文档字段）。
