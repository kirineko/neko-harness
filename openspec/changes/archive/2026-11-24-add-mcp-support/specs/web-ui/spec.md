# Spec Delta

## ADDED Requirements

### Requirement: Web MCP 设置页列表与 OAuth 交互

Web 设置菜单 SHALL 新增支持中英双语的「MCP」设置页 `/settings/mcp`，实时订阅 `neko.mcp` 快照；网关状态未到达时页面 MUST 显示加载态并禁用所有操作。页面 SHALL 展示每个服务器的名称、传输类型、暴露模式、启停开关、可由颜色之外区分的实时状态、可展开工具清单（含只读标记）、错误与 stderr 尾部以及重连/编辑/删除按钮，并在顶部提示顶层 `mcp.json` 解析错误。对 OAuth HTTP 服务器 SHALL 提供登录（新标签页打开授权链接并在卡片内展示粘贴回调 URL 与取消区）与登出操作。

#### Scenario: 远程 HTTP 服务器完成 OAuth 登录与登出
- **WHEN** 某 HTTP 服务器状态为待登录，用户点击「登录」，随后经浏览器自动回调或粘贴回调 URL 完成授权
- **THEN** 卡片显示已连接与工具数并隐藏等待区；点击「登出」后凭据被清除，服务器回到待登录状态

### Requirement: Web MCP 表单与原始 JSON 双模式配置

Web `/settings/mcp` SHALL 同时提供结构化表单（新增/编辑 stdio 的 command/args/env/cwd 或 Streamable HTTP 的 url/headers/oauth，以及 description/timeout/exposure）与原始 `mcp.json` JSON 编辑器两种配置方式。保存前 MUST 校验并在出错时保留草稿显示原因；敏感字段（`env`、`headers`、`oauth.clientSecret`）默认遮罩并支持显隐切换，保存时原样保留 `${VAR}` 模板。

#### Scenario: 表单新增 stdio 服务器并查看工具
- **WHEN** 用户在 `/settings/mcp` 通过表单添加一个新的 stdio MCP 服务器并保存
- **THEN** 列表立即出现该服务器并显示连接中至已连接的状态变化，展开后可查看发现的工具清单，且另一打开的标签页同步更新

#### Scenario: 通过原始 JSON 编辑器粘贴导入配置
- **WHEN** 用户切换到原始 JSON 模式，粘贴包含多个服务器的 `mcpServers` JSON 并保存
- **THEN** 校验通过后原子写回 `~/.neko/mcp.json` 并立即生效；若 JSON 语法错误或含不支持的 `sse` 字段，页面保留编辑草稿并显示具体错误

### Requirement: Web MCP 与工具发现卡片

Web 聊天区 SHALL 优化 `mcp__*` 工具与 `tool_search` 工具的卡片标题与摘要展示：`mcp__*` 工具卡清晰展示所属服务器与工具名（如 `server / tool`）及简洁参数摘要；`tool_search` 工具卡展示检索关键词与已加载的工具列表。codemode 脚本内发起的 MCP 嵌套调用继续在既有 codemode 卡片的嵌套调用列表中展示。

#### Scenario: 展示直接调用的 MCP 工具与 tool_search
- **WHEN** `codemode: off` 会话中模型先调用 `tool_search` 加载工具，再调用 `mcp__github__list_issues`
- **THEN** `tool_search` 卡片展示搜索词与加载到的工具名，`mcp__github__list_issues` 卡片清晰标注 `github / list_issues` 与参数摘要
