# Spec Delta

## MODIFIED Requirements

### Requirement: 传输支持

网关 SHALL 按平台提供基于二进制帧的本地 Chord 传输：macOS/Linux 同时提供 Unix socket（供终端等本地客户端）与 WebSocket（供浏览器）；Windows 不提供 Unix socket，仅提供 WebSocket。所有平台上已启用的本地 Chord 传输 MUST 提供完全相同的服务契约、输入输出校验和取消语义。新版客户端 SHALL 校验目标网关身份，不支持旧版协议回退；链路握手格式或协议版本不同的对端 MUST 被明确拒绝并给出可识别原因，且不影响其他连接。无效帧与超限缓冲 MUST 有界处理而不影响其他连接。可选移动入口 SHALL 使用独立认证与版本化 API，不直接公开本地 Chord 服务，其开放业务保持相同的持久会话语义。

#### Scenario: 浏览器连接

- **WHEN** Web 前端通过 WebSocket 连接网关
- **THEN** 可完成二进制握手、会话列表查询与会话 attach

#### Scenario: Windows 本地客户端连接

- **WHEN** TUI 在 Windows 上连接网关
- **THEN** 通过 WebSocket 完成二进制握手与会话 attach，不尝试 Unix socket

#### Scenario: POSIX 双传输不变

- **WHEN** 网关运行于 macOS/Linux
- **THEN** Unix socket 与 WebSocket 同时可用，已有客户端业务操作保持一致

#### Scenario: 网关身份不匹配

- **WHEN** 客户端连接到身份与发现结果不同的网关
- **THEN** 连接被明确拒绝，不读取或提交该网关的会话内容

#### Scenario: 协议版本不匹配

- **WHEN** 仍运行旧版链路协议（如 Pi 1.5 文本握手帧或更早版本）的网关进程被新版 TUI/Web 连接，或旧版客户端连接新网关
- **THEN** 连接被拒绝并报告协议不兼容、提示更新后重启 TUI/Web 或网关，前端不无限重试、TUI 不再启动竞争实例；同一网关上其他兼容连接继续正常工作

#### Scenario: 无效帧与慢连接

- **WHEN** 某连接发送无法解析的帧、非二进制消息、超过单帧限制，或发送缓冲超过上限
- **THEN** 只关闭该连接并释放相关资源，不无限累积字节或阻塞其他客户端

#### Scenario: 活跃实例与遗留 socket

- **WHEN** 新网关尝试使用已占用的 Unix socket 或端口，或遇到已无监听者的遗留 socket
- **THEN** 活跃实例占用时拒绝启动并给出可操作提示，仅对确认已无监听者的遗留 socket 接管

#### Scenario: 独立移动连接

- **WHEN** 本地 Chord 传输协议升级后用户开启局域网移动入口
- **THEN** 手机仍经认证的版本化移动 API 访问已开放业务而无需随本地 Chord 协议改动，本地 Chord 地址与客户端契约保持隔离
