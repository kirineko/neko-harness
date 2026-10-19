# Spec Delta

## ADDED Requirements

### Requirement: Windows shell 环境说明

在 Windows 上启用 bash 或 `job` 工具时，`rules` 节 SHALL 包含一条固定说明：命令运行于 Git for Windows 的 bash（不是 PowerShell 或 cmd，也不是 WSL），路径应使用正斜杠（如 `D:/code`）或 `/d/code` 形式，不要使用反斜杠。该说明 MUST 只依赖平台，同一平台与相同资源下渲染结果保持逐字节一致；非 Windows 平台 MUST NOT 出现该说明，未启用 bash 与 `job` 的角色 MUST NOT 出现该说明。

#### Scenario: Windows 主会话

- **WHEN** 在 Windows 上为启用 bash 的主会话组装提示词
- **THEN** `rules` 节包含 Git Bash 与正斜杠路径的说明

#### Scenario: 非 Windows

- **WHEN** 在 macOS 或 Linux 上组装同一会话的提示词
- **THEN** `rules` 节不包含该说明，其他内容不变

#### Scenario: 无命令工具的角色

- **WHEN** 在 Windows 上为不含 bash 与 `job` 的角色组装提示词
- **THEN** 不出现该说明

### Requirement: 资源文件 BOM 容错

读取 AGENTS.md 与 SKILL.md 时，系统 SHALL 忽略文件开头的 UTF-8 BOM，再按既有规则处理：SKILL.md 的 frontmatter 识别与解析、AGENTS.md 的正文渲染。带 BOM 的文件 MUST 与不带 BOM 的同内容文件产生相同的技能元数据与相同的 `project_context` 渲染结果。CRLF 行尾保持既有的兼容处理。

#### Scenario: 带 BOM 的 SKILL.md

- **WHEN** 某 SKILL.md 以 UTF-8 BOM 开头，随后是合法的 frontmatter 与非空 description
- **THEN** 该技能被正常收录，name 与 description 与去掉 BOM 后的文件一致

#### Scenario: 带 BOM 的 AGENTS.md

- **WHEN** 项目级 AGENTS.md 以 UTF-8 BOM 开头
- **THEN** `project_context` 中渲染的正文不含 BOM 字符
