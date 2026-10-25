# Spec Delta

## ADDED Requirements

### Requirement: 导出中的 codemode 调用

Markdown 与 HTML 导出 SHALL 把 codemode 调用的脚本作为 JavaScript 代码块呈现，并在其后列出嵌套调用（工具名、参数预览、状态、耗时、错误）与脚本输出；JSON 导出 SHALL 在该工具项上包含嵌套调用列表字段。导出 MUST NOT 包含嵌套调用的完整结果正文，也不读取完整输出文件。

#### Scenario: Markdown 导出
- **WHEN** 用户导出含一次 codemode 调用的会话为 Markdown
- **THEN** 该调用显示为脚本代码块、嵌套调用列表与脚本输出，没有嵌套结果正文
