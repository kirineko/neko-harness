# Spec Delta

## MODIFIED Requirements

### Requirement: 只读工具边界

plan 模式下系统 SHALL 不向模型提供 `edit`、`write` 与 `job`，并 MUST 在调用执行前拒绝这些工具，包括经其他工具嵌套发起的调用。对于 MCP 工具（`mcp__*`），plan 模式下系统 SHALL 仅放行显式声明 `annotations.readOnlyHint === true` 的只读工具，并在直接调用与 codemode 嵌套调用执行前拒绝未声明只读标记的 MCP 工具，返回说明当前处于只读规划模式的错误结果。`read`、文件搜索、联网搜索、`todo`、`ask_user`、受限 `bash`、只读 MCP 工具与只读子 agent 角色 SHALL 保持可用。退出 plan 模式 MUST 恢复被移除的工具；进出 plan 模式与配置对账时 SHALL 保留当前分支已通过 `tool_search` 加载的 MCP 工具。

#### Scenario: 写工具被拒绝
- **WHEN** plan 模式下模型或嵌套脚本尝试调用 `edit`、`write` 或 `job`
- **THEN** 调用不产生任何文件或进程副作用，模型得到说明当前处于只读规划模式的错误结果

#### Scenario: 调研工具可用
- **WHEN** plan 模式下模型读取文件、搜索代码、联网搜索或向用户提问
- **THEN** 这些调用与 normal 模式行为一致

#### Scenario: 非只读 MCP 工具被拒绝而只读 MCP 工具放行
- **WHEN** plan 模式下模型直接或在 codemode 脚本中分别调用未声明 `readOnlyHint: true` 的 MCP 工具与声明了 `readOnlyHint: true` 的 MCP 工具
- **THEN** 前者在执行前被拒绝且不向 MCP 服务器发出请求；后者正常执行并返回结果

#### Scenario: 进出 plan 模式保留已加载的 MCP 工具
- **WHEN** `codemode: off` 会话通过 `tool_search` 加载了某个 MCP 工具，随后进入 plan 模式再退出
- **THEN** 退出 plan 模式后该 MCP 工具仍在模型已加载工具列表中，无需重新检索
