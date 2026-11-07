# Spec Delta

## ADDED Requirements

### Requirement: TUI 运行失败提示与继续

TUI SHALL 在会话空闲且网关提供失败原因时，在输入区上方显示本地化的失败原因（含有界详情）及 `/continue` 提示；`/continue` 命令 SHALL 请求继续运行，失败时显示本地化错误。失败原因消失时提示 SHALL 随之消失。网关不提供该字段时 MUST NOT 显示提示，`/continue` SHALL 提示当前网关不支持。

#### Scenario: 失败后继续

- **WHEN** 运行因模型错误结束，用户输入 `/continue`
- **THEN** 提示消失，会话进入运行状态，transcript 中不新增用户消息

#### Scenario: 无失败时继续

- **WHEN** 会话最近一次运行已正常回答，用户输入 `/continue`
- **THEN** 显示无法继续的本地化提示，不启动运行

#### Scenario: 旧网关

- **WHEN** TUI 连接不提供失败原因字段的旧网关并输入 `/continue`
- **THEN** 显示网关不支持的提示，其余功能正常
