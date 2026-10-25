# Spec Delta

## ADDED Requirements

### Requirement: 移动 codemode 工具卡

App SHALL 把带嵌套调用数据的 codemode 调用渲染为工具卡：一行摘要显示状态与脚本首行；展开后显示完整脚本（可横向滚动）、嵌套调用列表（状态、工具名、参数预览、耗时、错误）和脚本输出。手机端只能查看，MUST NOT 提供修改 codemode 设置的入口。缺少嵌套调用数据时 SHALL 按普通工具项显示。

#### Scenario: 展开查看
- **WHEN** 用户在手机上展开一个已完成的 codemode 工具项
- **THEN** 看到完整脚本和每个嵌套调用的状态，失败项可通过图形或文字识别
