# Spec Delta

## ADDED Requirements

### Requirement: TUI MCP 管理命令与面板

TUI SHALL 提供 `/mcp` 命令（纳入 `/help` 与斜杠补全，命令名在中英文下保持原样），打开轻量 MCP 管理面板，实时显示所有已配置服务器的名称、类型、连接状态、工具数、配置或连接错误摘要以及待完成的 OAuth 登录提示。网关状态未到达时面板 MUST NOT 允许提交操作。

在面板中用户 SHALL 可对选中的服务器执行：启停切换、立即重连、对 OAuth HTTP 服务器发起登录（打开授权链接或输出供复制的链接）与登出；当存在等待中的 OAuth 登录流时，用户 SHALL 可通过 `/mcp paste <url>` 提交粘贴的重定向 URL 完成授权或取消登录。配置新增、删除与详细字段编辑保持由 `~/.neko/mcp.json` 与 Web `/settings/mcp` 承担，面板提示配置文件路径。

#### Scenario: 查看状态并重连服务器
- **WHEN** 用户在 TUI 输入 `/mcp`，选中一个连接失败的服务器并触发重连
- **THEN** 面板显示该服务器错误摘要并在触发重连后实时更新为连接中或已连接，已连接的 Web 同步收到状态更新

#### Scenario: TUI 中完成 OAuth 登录与粘贴回调
- **WHEN** 用户在 `/mcp` 面板对需认证服务器发起登录，并在无本地浏览器可达 loopback 时运行 `/mcp paste <redirectUrl>`
- **THEN** 网关完成令牌换取并自动重连服务器，TUI 通知登录成功并刷新状态

#### Scenario: 帮助与补全列出 /mcp
- **WHEN** 用户输入 `/help` 或在输入框键入 `/m`
- **THEN** 帮助列表与斜杠补全包含 `/mcp` 及其当前语言说明

### Requirement: TUI MCP 与工具发现卡片

TUI 聊天区工具渲染 SHALL 优化 `mcp__*` 与 `tool_search` 的标题与摘要展示：`mcp__*` 显示服务器与工具名及参数摘要，`tool_search` 显示搜索关键词与已加载工具数量/名称；codemode 脚本内的 MCP 嵌套调用沿用既有 codemode 卡片展示。

#### Scenario: 渲染 MCP 工具与 tool_search 调用
- **WHEN** 会话中发生 `tool_search` 与 `mcp__docs__search` 调用
- **THEN** TUI 工具卡片分别清晰展示检索结果摘要与 `docs / search` 标题，不以难以阅读的原始长前缀覆盖参数摘要
