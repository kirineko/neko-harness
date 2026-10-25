# Spec Delta

## ADDED Requirements

### Requirement: TUI codemode 设置命令

TUI SHALL 提供 `/codemode` 命令，打开选择面板，显示当前生效模式与来源，可选择 off、on、only 或恢复默认，并说明修改只对之后新建的会话生效。`/help` SHALL 列出该命令。网关状态未到达时面板 MUST NOT 允许提交。

#### Scenario: 选择模式
- **WHEN** 用户输入 `/codemode` 并选择 `on`
- **THEN** 面板显示生效模式 `on`、来源「已保存」，已连接的 Web 同步更新

#### Scenario: 帮助
- **WHEN** 用户输入 `/help`
- **THEN** 命令列表包含 `/codemode` 及其说明

### Requirement: TUI codemode 工具卡

TUI SHALL 把 codemode 调用渲染为专用工具卡：标题行显示状态与脚本首行；展开后显示完整脚本、嵌套调用列表（状态符号、工具名、参数预览、耗时、错误）、脚本输出，以及完整输出文件路径（如有）。运行中列表 SHALL 实时更新。折叠时最多显示有限条嵌套调用，并提示其余数量。

#### Scenario: 折叠显示
- **WHEN** 脚本发起了 12 次嵌套调用，卡片处于折叠状态
- **THEN** 卡片显示前若干条和「还有 N 条」的提示，展开后显示全部（受视图上限约束）
