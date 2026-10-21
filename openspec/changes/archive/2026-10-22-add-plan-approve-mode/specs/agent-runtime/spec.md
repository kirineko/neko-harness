# Spec Delta

## ADDED Requirements

### Requirement: 会话模式配置与恢复
运行时 SHALL 在会话配置之外支持切换 plan 模式，切换从下一次模型请求起生效，并与受理输入串行。模式的持久记录 MUST 是权威来源：启动对账与每次受理输入前 SHALL 检查实际工具集与模式说明是否与记录一致，不一致时重新应用，使"模式已保存但配置未应用"的中断状态可恢复。`submit_plan` MUST 只提供给主 agent，子 agent 新建与启动修复中均剔除。

#### Scenario: 配置应用被中断
- **WHEN** 模式已持久为 plan，但进程在应用工具集前退出
- **THEN** 重启后下一次受理输入前工具集与模式说明被修复，写工具不可用

#### Scenario: 切换与输入串行
- **WHEN** 切换请求与新输入同时到达同一会话
- **THEN** 两者按受理顺序依次生效，不出现使用半切换工具集的请求

#### Scenario: 子 agent 无计划工具
- **WHEN** 主 agent 在 plan 模式下启动子 agent
- **THEN** 子 agent 的工具集中没有 `submit_plan`
