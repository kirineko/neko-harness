# Spec Delta

## MODIFIED Requirements

### Requirement: TUI 导出命令
TUI SHALL 提供 `/export [path] [--thinking]`，把当前会话导出为文件并显示最终写入路径。格式由路径扩展名决定：`.md`、`.html`、`.json`；缺省路径时生成 Markdown 的默认文件名并写入 TUI 工作区目录。路径 MAY 用引号包裹含空格的内容，支持 `~/` 前缀（Windows 上同时支持 `~\`），相对路径相对工作区目录解析。`--thinking` 选择包含思考过程。

#### Scenario: 默认导出
- **WHEN** 用户提交 `/export`
- **THEN** 在工作区目录生成带默认名称的 `.md` 文件并显示其完整路径

#### Scenario: 按扩展名选格式
- **WHEN** 用户提交 `/export out/chat.html`
- **THEN** 生成 HTML 文件，图片内嵌，完成时提示路径及未能内嵌的图片数量（若有）

#### Scenario: 包含思考过程
- **WHEN** 用户提交 `/export notes.md --thinking`
- **THEN** 导出的 Markdown 包含每条回答的思考过程

#### Scenario: 路径含空格
- **WHEN** 用户提交 `/export "my chats/a.json"`
- **THEN** 引号内整体作为路径，导出 JSON 到该文件

#### Scenario: Windows 主目录前缀
- **WHEN** Windows 上用户提交 `/export ~\Desktop\chat.md`
- **THEN** 文件写入当前用户主目录下的 `Desktop\chat.md`

## ADDED Requirements

### Requirement: TUI Git Bash 缺失提示

TUI 连接的网关在应用信息中报告 Windows shell 缺失时，TUI SHALL 显示一条英语警告通知，说明 bash 与后台任务不可用，并给出下一步：安装 Git for Windows，或在配置中设置 `shell.path`；配置无效时 SHALL 说明配置路径的问题。同一缺失状态在一次 TUI 运行中 MUST NOT 重复提示，状态变为可用后不再提示。该提示 MUST NOT 写入对话或发送给模型，MUST NOT 阻断输入。网关未提供该字段时 MUST NOT 显示提示。

#### Scenario: 启动时缺少 Git Bash

- **WHEN** Windows 上 TUI 连接的网关报告 shell 缺失（未找到）
- **THEN** TUI 显示一次英语警告，包含安装 Git for Windows 与 `shell.path` 的指引，输入保持可用

#### Scenario: 重连不重复

- **WHEN** 网关重连后仍报告相同的缺失状态
- **THEN** 不再重复显示该警告

#### Scenario: 非 Windows 网关

- **WHEN** TUI 连接 macOS 网关
- **THEN** 不显示任何 shell 提示
