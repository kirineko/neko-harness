# Spec Delta

## ADDED Requirements

### Requirement: 服务器级 MCP 管理服务

网关 SHALL 提供服务器级 `neko.mcp` 契约，支持无需 attach 会话即可订阅全局 MCP 状态并管理服务器。快照 SHALL 包含 `revision`、配置路径、配置错误、原始 `mcp.json` 文本、各服务器配置与运行状态（`connecting | connected | disconnected | auth_required | error | disabled`、工具清单及只读标记、错误/stderr 尾部、OAuth 凭据状态）及进行中登录流摘要，且 MUST NOT 包含 OAuth 令牌。契约 SHALL 提供服务器增删改、原始 JSON 保存（校验后原子写盘）、启停、重连与 OAuth 登录/粘贴回调 URL/取消/登出方法并在成功后广播最新快照。新增该服务 SHALL 将应用协议版本由 11 递增至 12，沿用版本不匹配即拒绝连接的约束。

#### Scenario: 多端实时同步配置与连接状态
- **WHEN** Web 端新增并启用一个 MCP 服务器，且 TUI 与另一浏览器标签页同时在线
- **THEN** 所有客户端收到更新后的 `neko.mcp` 快照，实时看到该服务器从连接中变为已连接及其发现的工具列表

#### Scenario: 非法配置或原始 JSON 被拒绝
- **WHEN** 客户端提交包含非法服务器名、无效 URL、旧版 `sse` 传输或语法错误的原始 JSON
- **THEN** 网关拒绝操作并返回可识别错误，原 `mcp.json` 与运行中服务器不受影响

#### Scenario: OAuth 登录流经网关协调且不泄露令牌
- **WHEN** 客户端对需认证的 HTTP 服务器发起登录，经 loopback 回调或粘贴 URL 完成授权
- **THEN** 网关广播状态变为已连接并清除待完成登录流；整个过程中快照与返回值均不包含任何 OAuth token

#### Scenario: 协议版本递增
- **WHEN** 协议版本 11 的旧客户端连接版本 12 的新网关，或新版客户端连接旧网关
- **THEN** 连接以可识别的协议不兼容错误被拒绝，不进入部分可用状态
