# Spec Delta

## MODIFIED Requirements

### Requirement: 分节系统提示词

系统 SHALL 以固定顺序的五个命名节组装系统提示词：`preamble`（角色定义）、`rules`（按本次请求启用的工具拼接的规则列表，全局去重；启用的工具指模型可见的工具，加上 codemode 脚本可调用的工具）、`project_context`、`skills`、`cwd`（会话工作区绝对路径）。无内容的节 MUST 省略。preamble SHALL 为无标签角色文本，其余节 MUST 自带 XML 标签，同一次请求的所有节 MUST 共享同一次构建结果。codemode 扩展自带的 `codemode` 段 SHALL 只在会话启用 codemode 时出现，并排在这五节之后。

#### Scenario: 新会话首次请求

- **WHEN** 新会话发起第一次模型请求
- **THEN** 系统提示词按 preamble、rules、project_context、skills、cwd 顺序呈现，preamble 为无标签文本，其余节以对应 XML 标签包裹

#### Scenario: 空内容节省略

- **WHEN** 会话工作区与用户目录均无 AGENTS.md
- **THEN** 系统提示词不包含 `project_context` 节，其余节顺序不变

#### Scenario: 规则随工具集变化

- **WHEN** 两次请求之间启用的工具集发生变化
- **THEN** `rules` 节只包含当前启用工具对应的规则，且不存在重复条目

#### Scenario: only 模式保留脚本工具的规则

- **WHEN** codemode 为 `only` 的会话发起请求，模型可见工具只有 `codemode`、`todo`、`ask_user`、`subagent`
- **THEN** `rules` 节仍包含 edit、bash 等脚本可调用工具的规则，以及 codemode 的规则

#### Scenario: off 模式不变

- **WHEN** codemode 为 `off` 的会话发起请求
- **THEN** 系统提示词与启用 codemode 之前逐字节相同，不含 `codemode` 段

## ADDED Requirements

### Requirement: codemode 工具规则

会话启用 codemode 时，`rules` 节 SHALL 包含一条 codemode 规则：用 `codemode` 批量执行相互独立的工具调用（如 `Promise.allSettled`）、串联调用或过滤大段输出，而不是发出多次单独调用。该规则 MUST 与 Pi 的 codemode 规则一致；未启用 codemode 时 MUST NOT 出现。

#### Scenario: on 模式出现规则
- **WHEN** codemode 为 `on` 的会话发起请求
- **THEN** `rules` 节包含 codemode 规则，且只出现一次
