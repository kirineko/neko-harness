# Spec Delta

## MODIFIED Requirements

### Requirement: 普通输入取代待批准计划
会话处于待批准时，用户直接发送的普通输入 SHALL 被正常受理并取代待批准计划，不视为批准；会话保持 plan 模式，模型据此继续调研。若模型调用 `submit_plan` 时会话收件箱中已存在排队的用户输入，新计划版本 SHALL 在同一次持久提交内直接结算为 `superseded`，不暴露短暂的待批准中间状态；会话保持 plan 模式。

#### Scenario: 用户直接补充需求
- **WHEN** 待批准期间用户在输入框发送新的文字
- **THEN** 当前计划置为 superseded，不退出 plan 模式，模型在 plan 模式下继续回答

#### Scenario: 提交时已有排队用户输入
- **WHEN** 模型正在生成并调用 `submit_plan` 期间用户已发送排队普通输入
- **THEN** 新提交的计划版本在单次持久提交内直接记为 superseded，观察者不会看到短暂的待批准状态，随后会话继续在 plan 模式下处理排队输入
