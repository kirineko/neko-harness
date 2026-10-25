# Spec Delta

## ADDED Requirements

### Requirement: 移动 codemode 调用数据

移动 API 的工具项 SHALL 以可选字段提供 codemode 调用的嵌套调用列表与完整输出文件路径，内容与上限同桌面会话视图一致。该字段为新增字段，MUST NOT 提高移动 API 版本；缺少该字段时 App SHALL 按普通工具项显示。移动 API MUST NOT 因此获得修改 codemode 设置的能力。

#### Scenario: 新 App 连接旧电脑
- **WHEN** App 连接不提供该字段的电脑
- **THEN** codemode 调用按普通工具项显示，连接与其他功能正常

#### Scenario: 运行中的脚本
- **WHEN** 手机打开的会话里有正在运行的 codemode 脚本
- **THEN** 工具项随嵌套调用的开始和结束更新，与电脑端看到的一致
