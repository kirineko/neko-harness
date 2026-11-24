# Spec Delta

## Purpose

为 `neko-harness` 提供全局 MCP（Model Context Protocol）服务器接入能力，使主 agent 与合规子 agent 能够通过标准 `mcp.json` 配置、安全凭据管理与 OAuth 2.1 登录发现并调用外部 stdio 与 Streamable HTTP 工具，并与 codemode、tool_search 及只读护栏无缝协同。

## ADDED Requirements

### Requirement: 全局 mcp.json 配置格式与单一真相

系统 SHALL 以数据目录下的全局 `mcp.json`（默认 `~/.neko/mcp.json`）作为 MCP 配置的唯一持久化真相，采用标准 `{ "mcpServers": { "<name>": { ... } } }` 格式。服务器名 MUST 仅含字母、数字、`_` 与 `-`，且 `-` 替换为 `_` 后不得与其他服务器冲突。每条配置 MUST 为 `stdio`（`command`，可选 `args`/`env`/`cwd`）或 `Streamable HTTP`（`http`/`https` `url`，可选 `headers`/`oauth`）；声明 `type: "sse"` MUST 被拒绝。两类条目均支持 `enabled`（默认 `true`）、`description`、`timeout`（正数秒）与 `exposure`（`"auto"`/`"direct"`，默认 `"auto"`）。UI 与 API 的配置写操作 MUST 校验后原子写回该文件，失败时不破坏原文件。

#### Scenario: 首次运行无 mcp.json
- **WHEN** 数据目录下不存在 `mcp.json`
- **THEN** 系统视为空配置，不报错、不创建额外工具，也不写入空配置文件，直到用户主动通过 API 或 UI 保存配置

#### Scenario: 单条非法配置不阻断其他服务器
- **WHEN** `mcp.json` 包含一个合法 stdio 服务器与一个声明 `type: "sse"` 的非法条目
- **THEN** 合法服务器正常加载并连接，非法条目被跳过并在配置错误列表中报告原因

#### Scenario: 命名空间冲突被拒绝
- **WHEN** 配置中同时存在 `my-docs` 与 `my_docs`
- **THEN** 后者被拒绝并说明工具命名空间冲突，前者不受影响

#### Scenario: UI 编辑写回同一份 mcp.json
- **WHEN** 用户在 Web 端新增或修改一个 MCP 服务器并保存
- **THEN** 变更原子写入 `~/.neko/mcp.json`，文件格式可被外部 MCP 客户端直接识别；再次手动打开该文件可见完全一致的配置

### Requirement: 环境变量模板展开与敏感值保护

`stdio` 条目的 `env`、`Streamable HTTP` 条目的 `headers` 与 `oauth.clientSecret` SHALL 支持 `${NAME}` 环境变量引用，仅在运行时建立连接或发起 OAuth 请求时从网关进程环境展开。当引用的环境变量未设置时，该服务器 MUST 进入失败状态并明确指出缺失的变量名，而不影响其他服务器。通过 API 或 Web 写回 `mcp.json` 时 MUST 原样保留 `${NAME}` 模板，不得把展开后的明文值落盘。面向客户端展示的配置快照 SHALL 允许界面区分并默认遮罩敏感字段（如 `headers`、`env`、`oauth.clientSecret`）的明文值。

#### Scenario: 保留环境变量模板
- **WHEN** `mcp.json` 中某 HTTP 服务器的 header 写为 `"Authorization": "Bearer ${DOCS_TOKEN}"`，用户在 Web 端仅修改其 `description` 并保存
- **THEN** 写回 `mcp.json` 后 `headers.Authorization` 仍为 `"Bearer ${DOCS_TOKEN}"`，不会写入展开后的真实令牌

#### Scenario: 环境变量缺失
- **WHEN** `DOCS_TOKEN` 未在网关环境中设置
- **THEN** 该服务器连接失败并在状态中明确指出缺失 `DOCS_TOKEN`，其他已配置服务器正常连接

### Requirement: 配置文件热重载与损坏容错

系统 SHALL 监听全局 `mcp.json` 的外部变更并在防抖后自动重载；由网关自身写回触发的文件事件 MUST 被抑制，不引发重复重连。当外部编辑导致 `mcp.json` 出现 JSON 语法错误或顶层结构非法时，系统 SHALL 保留上一次有效的运行中服务器集合，并在状态快照中报告配置解析错误；文件修复后 SHALL 自动清除错误并同步生效。

#### Scenario: 外部手工编辑生效
- **WHEN** 网关运行期间用户在编辑器中向 `~/.neko/mcp.json` 新增一个启用中的服务器并保存
- **THEN** 网关在防抖窗口后自动读取并启动连接，无需重启网关即可在会话与前端看到该服务器及其工具

#### Scenario: 手工改坏 JSON 不中断现有连接
- **WHEN** 已有两个连接正常的 MCP 服务器，用户误将 `mcp.json` 改出语法错误并保存
- **THEN** 两个已有连接保持可用，状态快照携带可读的语法错误提示；用户修正 JSON 后错误消失并应用新配置

### Requirement: 连接池生命周期与断线重连

网关进程内每个已启用的全局 MCP 服务器 SHALL 维护单一共享连接，在网关启动或配置启用时后台建立连接，不阻塞网关启动。`stdio` 服务器中相对或 `~/` 开头的 `cwd` SHALL 正确解析，`command` 与 `args` 不经 shell 直接启动；停止或网关关闭时 MUST 按规范依次关闭 stdin、发送终止信号并清理整个进程组，不遗留孤儿进程。`Streamable HTTP` 服务器连接或已连接实例意外断开时，系统 SHALL 采用指数退避自动重连，并支持用户手动触发立即重连；连接期间保留上次发现的摘要信息但工具调用返回明确不可用错误。收到服务器发出的工具列表变更通知时，系统 SHALL 重新拉取工具列表并热更新已注册工具。禁用或删除服务器 MUST 关闭对应连接并移除其工具。

#### Scenario: 退避重连与工具刷新
- **WHEN** 一个已连接的 MCP 服务器进程意外退出，随后重新启动成功并返回更新后的工具列表
- **THEN** 系统自动退避重连，重连成功后工具列表更新为最新版本，前端状态从断开/重连中恢复为已连接

#### Scenario: 工具列表变更通知
- **WHEN** 已连接的 MCP 服务器发送 `notifications/tools/list_changed`
- **THEN** 系统主动重新调用 `tools/list` 并将增删改后的工具实时反映到运行时与前端

#### Scenario: 网关关闭清理子进程
- **WHEN** 网关收到关闭指令时存在运行中的 stdio MCP 服务器
- **THEN** 网关关闭所有 MCP 连接并终止其子进程组，不阻塞退出或留下常驻孤儿进程

### Requirement: 远程 HTTP MCP 的 OAuth 2.1 凭据存储

未配置 `Authorization` 头的 Streamable HTTP 服务器 SHALL 支持 MCP OAuth 2.1（资源/授权服务器发现、PKCE、动态客户端注册或预配置 `oauth.clientId`、token 刷新与 step-up scope）。凭据 MUST 持久化至数据目录私有文件 `mcp-auth.json`（0600 权限，原子加锁写盘），按服务器名与规范化 URL 分键隔离，且令牌 MUST NOT 发送至任何前端。遇到 401 或 scope 不足时，服务器状态 SHALL 转入 `auth_required`；登出 MUST 清除对应记录并使连接回到待登录状态。

#### Scenario: 登出清除凭据
- **WHEN** 用户对已登录的 OAuth MCP 服务器执行登出
- **THEN** `mcp-auth.json` 中对应记录被清除，连接重建后回到待登录状态，已有内存令牌不再被复用

### Requirement: OAuth 2.1 两段式登录流

发起 OAuth 登录时，系统 SHALL 先在刷新锁下尝试静默刷新已有 refresh token，成功则直接重连完成。需浏览器授权时，系统 SHALL 启动本机 loopback 回调监听（遵循 `oauth.callbackPort` / `oauth.callbackUrl` 或空闲端口）并返回授权链接，在内存中维护限时单活登录流。无论授权码经 loopback 回调到达还是由用户手动粘贴最终重定向 URL，系统均 SHALL 校验 `state` 与回调路径、换取并保存令牌、关闭临时监听并自动重连服务器。

#### Scenario: 本机浏览器自动完成 OAuth 登录
- **WHEN** 远程 OAuth HTTP 服务器返回 401，用户在 Web 或 TUI 发起登录并在本机浏览器同意授权
- **THEN** 浏览器重定向至 loopback 回调后网关自动换取令牌写入 `mcp-auth.json`、关闭回调端口并重连服务器，状态变为已连接并加载工具

#### Scenario: 远程或 SSH 转发场景粘贴回调 URL 完成登录
- **WHEN** 用户在另一台设备打开授权页，浏览器最终停在无法访问的 `127.0.0.1` 回调地址，用户复制完整地址栏 URL 并提交给网关
- **THEN** 网关校验 `state` 与路径通过后完成令牌换取并自动重连服务器；若 URL 属于其他登录流或缺少授权码则拒绝并给出明确错误

### Requirement: MCP 工具命名、参数规范化与结果转换

每个已连接服务器的工具 SHALL 规范化为 `mcp__<server>__<tool>`（仅 `[A-Za-z0-9_]`，超 64 字符或碰撞时追加稳定哈希后缀），命名空间为 `mcp__<server>`；输入 schema MUST 规范化为含 `properties` 的对象且工具默认 `replay: "unsafe"`。执行结果 SHALL 提供双通道：模型侧透传文本/图片、展开内嵌文本资源、落盘非图片二进制资源，并在文本超 20 KB 时做首尾中间截断且落盘完整文件；程序侧（codemode 脚本）获得完整未截断的 `CallToolResult`（不含 `_meta`）。服务器未连接或待登录时调用 MUST 返回含原因与引导的错误。

#### Scenario: 长名称与碰撞稳定去重
- **WHEN** 某服务器工具名拼接后超过 64 字符，或两个不同工具名规范化后碰撞
- **THEN** 系统生成不超过 64 字符且含稳定哈希后缀的工具名，重启前后名称保持确定一致

#### Scenario: 超长文本结果在模型侧截断而脚本侧完整
- **WHEN** 某 MCP 工具返回 40 KB 文本
- **THEN** 模型直接调用收到不超过 20 KB 的首尾截断文本及完整临时文件路径；codemode 脚本调用收到完整的 `CallToolResult`

#### Scenario: 未登录服务器被调用
- **WHEN** 模型在 OAuth 服务器尚未登录时尝试调用其工具
- **THEN** 调用返回错误结果说明服务器需要登录并引导用户前往设置页或 `/mcp` 完成授权

### Requirement: MCP 与 codemode 及 tool_search 的联动暴露

无已启用 MCP 服务器时，系统 MUST NOT 注入 `tool_search` 工具、`mcp_servers` 提示词段或任何 MCP 命名空间。存在已启用 MCP 服务器时：
- `codemode: on / only` 会话 SHALL 移除 `tool_search`，按服务器向 `codemode` 注入稳定占位的 `mcp__<server>` 命名空间（含单行摘要与 `instructions`）；`exposure: "auto"` 工具保持延迟由脚本经 `searchTools()` / `describeNamespace()` 调用，`exposure: "direct"` 在 `on` 下额外直接声明给模型。
- `codemode: off` 会话 SHALL 自动提供 `tool_search` 工具与 `mcp_servers` 提示词段；`exposure: "auto"` 工具延迟注册并经 `tool_search` 按需加载，`exposure: "direct"` 直接声明给模型。

#### Scenario: 零 MCP 服务器时零开销
- **WHEN** 用户未配置或已禁用全部 MCP 服务器，在 `codemode: off` 会话中发送消息
- **THEN** 模型工具列表不包含 `tool_search`，系统提示词不包含 `mcp_servers` 段

#### Scenario: codemode 关闭时经 tool_search 发现并调用
- **WHEN** 已启用一个 `exposure: "auto"` 的 MCP 服务器，用户在 `codemode: off` 会话中提问
- **THEN** 系统提示词列出该服务器，模型通过 `tool_search` 加载匹配工具后在下一轮直接调用成功

#### Scenario: codemode 开启时经命名空间脚本调用
- **WHEN** 已启用一个 `exposure: "auto"` 的 MCP 服务器，用户在 `codemode: on` 或 `only` 会话中提问
- **THEN** 模型看不到 `tool_search`，`codemode` 提示词段包含 `## mcp__<server>`，脚本可通过 `searchTools()` / `describeNamespace()` 发现并调用 `tools.mcp__<server>__<tool>()`

#### Scenario: direct 暴露策略
- **WHEN** 某服务器配置为 `"exposure": "direct"`
- **THEN** 在 `codemode: off` 与 `codemode: on` 会话中，该服务器工具直接出现在模型工具声明中，无需先调用 `tool_search`

### Requirement: 子 agent 中的 MCP 工具边界

委派子 agent 时，系统 SHALL 仅允许 `coder` 角色继承主会话当前已启用的 MCP 工具；只读角色 `explore` 与 `plan` MUST NOT 获得任何 MCP 工具（包括经 `tool_search` 或 `codemode` 脚本调用）。

#### Scenario: coder 可使用 MCP 工具
- **WHEN** 主会话已连接一个 MCP 服务器并派发 `coder` 子 agent
- **THEN** `coder` 子 agent 可以按继承的 `codemode` 模式发现并调用该 MCP 工具

#### Scenario: explore 与 plan 不暴露 MCP 工具
- **WHEN** 主会话已连接 MCP 服务器并派发 `explore` 或 `plan` 子 agent
- **THEN** `explore` 与 `plan` 子 agent 既看不到 MCP 工具，也无法在 `codemode` 脚本中调用它们
