# Spec Delta

## ADDED Requirements

### Requirement: 运行环境状态

网关 SHALL 在无需 attach 会话的服务器级应用信息中，以可选字段发布 Windows 命令 shell 的状态：可用时给出所选 bash 的路径及来源（配置、自动探测），不可用时给出缺失状态及简短原因（未找到、配置无效）。该字段仅在 Windows 网关上出现，非 Windows 网关 MUST 省略它。状态 SHALL 在网关启动时确定并在每次应用信息检查时重新计算。该字段 MUST NOT 提升应用协议版本：旧客户端忽略它，新客户端在字段缺失时 MUST NOT 显示 shell 提示。

#### Scenario: Windows 上 Git Bash 可用

- **WHEN** 客户端连接已找到 Git Bash 的 Windows 网关
- **THEN** 应用信息包含 shell 可用状态、bash 路径与来源

#### Scenario: Windows 上缺少 Git Bash

- **WHEN** 客户端连接找不到 Git Bash 的 Windows 网关
- **THEN** 应用信息包含 shell 缺失状态与原因

#### Scenario: 非 Windows 或旧网关

- **WHEN** 客户端连接 macOS 网关或不含该字段的旧网关
- **THEN** 应用信息不含 shell 字段，客户端不显示 shell 提示且其他功能正常

#### Scenario: 安装后重新检查

- **WHEN** 用户在网关运行期间安装 Git for Windows，随后客户端触发应用信息检查
- **THEN** 检查结果中的 shell 状态变为可用

### Requirement: Windows 拉起方优雅关停

在 Windows 上，TUI 与 Web 自动拉起网关时 SHALL 以显式参数启用「stdin 关停」，并保持与子进程 stdin 的管道。拉起方关停自己拉起的网关时 SHALL 先关闭该管道，网关收到 stdin 结束后 MUST 执行与终止信号相同的有界清理（停止任务、关闭存储、释放传输、删除端口文件）并退出；未在时限内退出时拉起方 SHALL 强制结束进程并补删端口文件。未启用该参数的网关（独立 `neko serve`、POSIX 拉起）MUST NOT 因 stdin 结束而退出，POSIX 拉起方的停止流程 MUST 保持不变。

#### Scenario: 正常关停

- **WHEN** Windows 上 TUI 退出并关停它拉起的网关
- **THEN** 网关执行清理并以零退出码退出，端口文件被删除，运行中的 job 被正常结算

#### Scenario: 清理超时

- **WHEN** 网关在关闭 stdin 后未在时限内退出
- **THEN** 拉起方强制结束网关进程并删除端口文件

#### Scenario: 拉起方崩溃

- **WHEN** Windows 上拉起网关的 TUI 进程意外终止，stdin 管道随之关闭
- **THEN** 网关执行同样的有界清理后退出

#### Scenario: 独立网关不受影响

- **WHEN** 用户以 `neko serve` 启动网关，其 stdin 被关闭
- **THEN** 网关继续运行
