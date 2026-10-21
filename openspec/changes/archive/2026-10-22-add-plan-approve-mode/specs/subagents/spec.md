# Spec Delta

## ADDED Requirements

### Requirement: 规划模式下的委派限制
主会话处于 plan 模式时系统 SHALL 只允许启动或继续只读角色（explore 与 plan），并 MUST 拒绝启动或继续 coder 角色，拒绝结果说明当前处于只读规划模式。已有 coder 子 agent 的记录与历史保持可查看。

#### Scenario: 启动 coder 被拒绝
- **WHEN** plan 模式下模型请求委派 coder 子 agent
- **THEN** 不创建委派与子会话，模型得到说明限制的错误结果

#### Scenario: 继续已有 coder 被拒绝
- **WHEN** plan 模式下模型尝试继续此前创建的 coder 子 agent
- **THEN** 不开始新一轮，模型得到同样的错误结果，原记录不变

#### Scenario: 只读角色可用
- **WHEN** plan 模式下模型委派 explore 子 agent 做调研
- **THEN** 委派与审批行为与 normal 模式一致
