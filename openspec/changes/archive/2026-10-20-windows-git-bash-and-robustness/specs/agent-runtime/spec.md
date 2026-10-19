# Spec Delta

## ADDED Requirements

### Requirement: Windows 命令执行 shell

在 Windows（`win32` 平台）上，bash 工具、`job` 工具与子 agent 的字符串命令 SHALL 统一在 Git for Windows 的 bash 中执行。系统 SHALL 按以下顺序确定 bash：配置项 `shell.path`；标准安装目录下的 `Git\bin\bash.exe`（`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%\Programs`）；由 PATH 中 `git.exe` 推导出的同一安装的 `bin\bash.exe`；PATH 中的其他 `bash.exe`。WSL 的 `bash.exe`（位于 `System32`、`Sysnative` 或 `WindowsApps` 下）MUST NOT 被选用。macOS、Linux 及在 WSL 内运行时的行为 MUST 保持不变。

#### Scenario: 标准安装的 Git Bash

- **WHEN** Windows 上未配置 `shell.path`，`%ProgramFiles%\Git\bin\bash.exe` 存在
- **THEN** bash 工具、`job start` 与子 agent 的命令均由该 bash 执行

#### Scenario: 用户级安装

- **WHEN** Git for Windows 仅安装在 `%LOCALAPPDATA%\Programs\Git`
- **THEN** 系统选用其中的 `bin\bash.exe`

#### Scenario: 由 git.exe 推导

- **WHEN** 标准目录下都没有 Git Bash，PATH 中的 `git.exe` 位于某安装的 `cmd` 目录，同一安装的 `bin\bash.exe` 存在
- **THEN** 系统选用该 `bin\bash.exe`

#### Scenario: 排除 WSL 启动器

- **WHEN** PATH 中第一个 `bash.exe` 是 `WindowsApps\bash.exe`，且之后没有其他非 WSL 的 bash
- **THEN** 系统不选用它，视为未找到 Git Bash

#### Scenario: 在 WSL 内运行

- **WHEN** neko 在 WSL 内运行（平台为 linux）
- **THEN** 命令按原有 POSIX 规则执行，不应用 Windows 探测

### Requirement: Windows 显式 shell 配置

配置文件 SHALL 支持 `shell.path`，在 Windows 上显式指定命令使用的 bash，优先于自动探测。该路径不存在、不是文件或指向 WSL 的 `bash.exe` 时，命令调用 MUST 以明确错误失败并指出配置项与原因，MUST NOT 回退到自动探测。非 Windows 平台 SHALL 忽略该配置。`shell.path` 不是字符串时，配置解析 MUST 报错。

#### Scenario: 显式配置生效

- **WHEN** Windows 上 `shell.path` 指向存在的 `D:\tools\Git\bin\bash.exe`
- **THEN** 命令由该 bash 执行，不再探测其他位置

#### Scenario: 配置指向 WSL

- **WHEN** `shell.path` 为 `C:\Windows\System32\bash.exe`
- **THEN** 命令调用失败，错误说明该路径是 WSL bash 且不受支持，并指出 `shell.path`

#### Scenario: 非 Windows 忽略

- **WHEN** macOS 上配置了 `shell.path`
- **THEN** 命令仍按 POSIX 规则选择 shell

### Requirement: Windows 缺少 Git Bash 时的命令错误

Windows 上找不到可用的 Git Bash 时，网关 MUST 照常启动，内置工具集与提示词中的工具声明 MUST NOT 改变。bash 工具、`job start` 与子 agent 的字符串命令 SHALL 失败并返回明确错误：说明需要安装 Git for Windows 或配置 `shell.path`，并列出已检查的位置。该错误 MUST NOT 使会话或运行时失败，模型可据此告知用户；read、write、edit 等其他工具 MUST 不受影响。

#### Scenario: 未安装 Git

- **WHEN** Windows 上没有 Git Bash，仅有 WSL 的 `bash.exe`，模型调用 bash 工具
- **THEN** 工具结果为错误，内容包含安装 Git for Windows 与配置 `shell.path` 的指引，会话继续可用

#### Scenario: 后台任务

- **WHEN** 同样条件下模型调用 `job start`
- **THEN** 返回同样的明确错误，不创建 running 状态的任务

#### Scenario: 其他工具不受影响

- **WHEN** 没有 Git Bash 时模型调用 read 或 edit
- **THEN** 工具照常执行
