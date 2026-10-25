# Spec Delta

## ADDED Requirements

### Requirement: Web codemode 设置页

Web 设置菜单 SHALL 提供「代码模式」页 `/settings/codemode`，显示当前生效模式及来源，并允许选择 off、on、only 或恢复默认。每个选项 SHALL 简要说明其含义；页面 MUST 说明修改只对之后新建的会话生效。保存结果 SHALL 以网关广播的状态为准；网关状态未到达时 MUST NOT 把选项显示为默认值或允许提交。

#### Scenario: 修改并同步
- **WHEN** 用户在设置页选择 `only`
- **THEN** 页面显示生效模式 `only`、来源「已保存」，另一个已打开的 Web 页面同步更新

#### Scenario: 已有会话
- **WHEN** 用户修改模式后回到一个已有会话
- **THEN** 该会话的工具不变，设置页的说明已提示只影响新会话

### Requirement: Web codemode 工具卡

Web SHALL 把 codemode 调用渲染为专用工具卡：折叠时显示状态、名称和脚本首行；展开后显示带语法高亮的完整脚本、嵌套调用列表（状态图标、工具名、参数预览、耗时、错误）、脚本输出，以及完整输出文件路径（如有）。运行中列表 SHALL 实时更新。状态 MUST 可通过颜色之外的图形或文字区分；列表超出上限时 SHALL 显示省略数量。

#### Scenario: 运行中的脚本
- **WHEN** 脚本正在运行且已发起 4 次嵌套调用
- **THEN** 展开的卡片列出 4 行，已结束的显示成功或失败及耗时，其余显示运行中

#### Scenario: 失败的脚本
- **WHEN** 脚本抛出错误
- **THEN** 卡片显示失败状态与错误输出，已完成的嵌套调用仍列出
