# Spec Delta

## ADDED Requirements

### Requirement: 移动运行失败原因

移动 API 的会话快照 SHALL 以可选字段提供最近一次未得到回答的运行的失败原因（原因代码与有界详情），内容与上限同桌面会话视图一致，并随运行结束与新运行开始推送。该字段为新增字段，MUST NOT 提高移动 API 版本；移动 API MUST NOT 因此获得"继续"运行的能力。

#### Scenario: 运行失败

- **WHEN** 手机打开的会话中运行因模型错误结束
- **THEN** 快照携带失败原因，新运行开始后该字段消失

#### Scenario: 新 App 连接旧电脑

- **WHEN** App 连接不提供该字段的电脑
- **THEN** 不显示失败原因，连接与其他功能正常
