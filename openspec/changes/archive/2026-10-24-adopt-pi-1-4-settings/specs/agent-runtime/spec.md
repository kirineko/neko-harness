# Spec Delta

## MODIFIED Requirements

### Requirement: 原生上下文压缩

系统 SHALL 默认保持 Pi 1.4.0 原生自动压缩策略，并提供附带可选要求的手动压缩；用户 MAY 通过配置文件 `context.compaction` 或 UI 保存的设置调整自动压缩的触发条件，优先级为已保存值高于配置文件、后者高于原生默认；两者都未设置时行为 MUST 与默认策略完全一致。摘要模型、思考强度、切分、重试、并发和中止 SHALL 遵循 pi-durable。压缩 MUST 保留原始历史，不更新标题或最近消息时间，用量沿用原生统计。展示状态 SHALL 从原生活动、持久失败、任务及摘要提交回执派生；摘要任务完成不等于摘要已应用，失败 MUST 在活动结束及重启后仍可辨识。

#### Scenario: 默认策略与运行中触发

- **WHEN** 配置文件未设置 `context.compaction`，上下文触发默认阈值、服务端报告溢出，或用户在会话运行中手动压缩
- **THEN** 按原生策略执行后台或阻塞压缩及恢复，不额外建立前端压缩队列或改写阈值

#### Scenario: 配置触发条件

- **WHEN** 配置文件设置 `context.compaction.triggerPercent` 为 1 至 99 的数值
- **THEN** 自动压缩的阻塞阈值对每个模型取其自身上下文窗口的该百分比，与已启用哪些 provider 无关；窗口未知的模型保持原生阈值；后台压缩、溢出恢复、摘要切分与重试仍遵循原生策略；配置文件变更在下次启动时生效

#### Scenario: 混合窗口各按自身比例

- **WHEN** 触发百分比为 80，会话 A 使用 32k 窗口的模型、会话 B 使用 1M 窗口的模型
- **THEN** 会话 A 在上下文约达 25.6k tokens 时、会话 B 在约达 800k tokens 时触发阻塞压缩；启用或停用其他 provider 不改变这两个阈值

#### Scenario: 配置保留与开关

- **WHEN** 配置文件设置 `context.compaction.keepRecentTokens`（正整数）或 `context.compaction.enabled`（布尔）
- **THEN** 摘要保留的近期上下文规模或自动压缩开关按配置执行；`enabled` 为 false 只关闭自动压缩，手动压缩 MUST 继续可用

#### Scenario: UI 保存的设置即时生效

- **WHEN** 用户在 UI 保存或恢复默认压缩设置
- **THEN** 之后的压缩阈值检查与压缩任务使用新值，进行中的压缩不受影响；重启后保留，恢复默认后回落到配置文件值或原生默认

#### Scenario: 非法配置

- **WHEN** `context.compaction` 含未知字段、`triggerPercent` 不在 1 至 99、`keepRecentTokens` 不是正整数或 `enabled` 不是布尔
- **THEN** 启动失败并给出指明配置文件与字段的错误，不静默回落默认值；UI 提交同类非法值 MUST 被拒绝且不落盘

#### Scenario: 完成与无操作

- **WHEN** 摘要任务完成但摘要尚未应用、已过期，或没有可压缩的历史
- **THEN** 分别展示等待应用、跳过或无需压缩；只有摘要已应用才报告成功

#### Scenario: 图片历史压缩

- **WHEN** 被压缩的历史含图片
- **THEN** 沿用文字摘要，不新增视觉总结请求；原图片仍可从历史查看，后续模型上下文遵循原生切分结果

#### Scenario: 持久失败与重复触发

- **WHEN** 压缩失败后活动任务已移除或进程重启，或用户在已有压缩/等待应用期间重复触发
- **THEN** 最新原生失败仍可见，直到原生成功摘要清除；重复请求不产生额外手动压缩，状态仍以真实回执为准

## ADDED Requirements

### Requirement: 模型请求身份与 Pi 一致

系统发往模型厂商的请求 SHALL 使用与 Pi 完全一致的客户端身份：详细格式的 `User-Agent`（`pi/<版本> (<平台>; <运行时>; <架构>)`）和 Pi 的 provider 归属信息。该身份 MUST 由系统显式声明，而不依赖上游默认值；此行为是为了兼容仅识别 Pi 客户端的厂商，不得在没有显式决定的情况下改为其他身份。

#### Scenario: 请求携带 Pi 身份

- **WHEN** 会话、压缩、子 agent 或会话命名向任一模型 provider 发出请求
- **THEN** 请求的 `User-Agent` 以 `pi/` 开头，归属头（适用的 provider）使用 Pi 的归属信息

#### Scenario: 上游默认值变化

- **WHEN** 升级 Pi 后其默认客户端身份与当前不同
- **THEN** 系统发出的身份仍保持显式声明的 Pi 身份，升级验证中的身份测试失败时 MUST 显式更新声明
