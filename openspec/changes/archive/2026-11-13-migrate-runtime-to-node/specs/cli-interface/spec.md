# Spec Delta

## ADDED Requirements

### Requirement: 运行时版本检查

已发布的 `neko` SHALL 在执行任何命令之前检查 Node 版本。低于包声明的最低版本（22.19.0）时，命令 SHALL 向标准错误输出一条包含所需最低版本与当前版本的简短说明并非零退出，MUST NOT 启动网关或界面，MUST NOT 读写会话、凭据与配置，也 MUST NOT 以未捕获的模块加载或语法错误代替该说明。

#### Scenario: Node 版本过低

- **WHEN** 用户在低于最低版本的 Node 上运行 `neko`、任一子命令、`neko --version` 或 `neko --help`
- **THEN** 标准错误只有一条说明，写明需要的最低 Node 版本与当前版本；退出码非零，不输出堆栈，不创建或修改 `~/.neko` 下的文件

#### Scenario: Node 版本满足

- **WHEN** 用户在等于或高于最低版本的 Node 上运行任一命令
- **THEN** 命令按原有行为执行，不输出与版本检查有关的内容
