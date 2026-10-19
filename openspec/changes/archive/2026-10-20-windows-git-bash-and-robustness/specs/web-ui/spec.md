# Spec Delta

## ADDED Requirements

### Requirement: Web Git Bash 缺失提示

Web 连接的网关在应用信息中报告 Windows shell 缺失时，Web SHALL 在聊天页以简洁中文的非阻断提示说明命令与后台任务不可用，并给出下一步：安装 Git for Windows 后重新检查，或在配置文件中设置 `shell.path`；配置无效时 SHALL 说明配置路径的问题。提示 SHALL 可关闭，关闭后同一缺失状态在本页面会话内 MUST NOT 再次出现；状态变为可用后提示 SHALL 消失。设置中的「关于与更新」页 SHALL 显示当前 shell 状态（可用时显示 bash 路径）。网关未提供该字段时 MUST NOT 显示提示或 shell 状态行，提示 MUST NOT 影响输入、发送与其他面板。

#### Scenario: 缺少 Git Bash

- **WHEN** Windows 网关报告 shell 缺失，用户打开聊天页
- **THEN** 页面显示中文提示，含安装 Git for Windows 与 `shell.path` 的指引，输入框可正常使用

#### Scenario: 关闭后不再出现

- **WHEN** 用户关闭该提示，随后 WebSocket 重连且状态仍为缺失
- **THEN** 提示不再出现

#### Scenario: 安装后恢复

- **WHEN** 用户安装 Git for Windows 后在「关于与更新」页触发检查
- **THEN** shell 状态显示为可用及 bash 路径，聊天页提示消失

#### Scenario: 非 Windows 或旧网关

- **WHEN** Web 连接 Linux 网关或不含该字段的旧网关
- **THEN** 不显示提示，「关于与更新」页不显示 shell 状态行
