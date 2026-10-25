# conversation-export Specification

## Purpose

定义会话内容如何被复制与导出：哪些文本可复制、可导出为哪些格式、默认包含哪些内容，以及导出文件的命名与安全约束。规则与前端无关，Web 与 TUI 共用同一结果。

## Requirements

### Requirement: 可复制文本规则
系统 SHALL 以统一规则提取单条消息的可复制文本：assistant 条目 MUST 只取回答正文，不含 thinking、工具调用与提示行；用户条目取其原始文本；`/skill:` 调用 MUST 还原为 `/skill:<name>`，有参数时追加空格与参数，不含展开后的技能正文。

#### Scenario: assistant 含 thinking
- **WHEN** 一条 assistant 条目同时有 thinking 与正文
- **THEN** 可复制文本只包含正文

#### Scenario: 技能调用
- **WHEN** 用户条目为 `/skill:pdf 合并两个文件` 的展开结果
- **THEN** 可复制文本为 `/skill:pdf 合并两个文件`；无参数时为 `/skill:pdf`

#### Scenario: 默认图片提示
- **WHEN** 用户条目只含图片并带系统补充的默认图片提示
- **THEN** 可复制文本不包含该默认提示

### Requirement: 最后一条回答
系统 SHALL 把"最后一条回答"定义为已提交条目中最后一个正文去除空白后非空的 assistant 条目；仅含 thinking、工具调用或被中止且无正文的条目 MUST 被跳过；流式中尚未提交的内容 MUST NOT 参与。没有符合条件的条目时视为无可复制内容。

#### Scenario: 工具轮之后的最终回答
- **WHEN** 会话末尾依次为带正文的 assistant、工具结果、仅含工具调用的 assistant
- **THEN** 最后一条回答为前面那个带正文的 assistant 条目

#### Scenario: 无回答
- **WHEN** 会话只有用户消息或为空
- **THEN** 判定为无可复制内容

### Requirement: 导出格式与范围
系统 SHALL 支持把当前会话导出为 Markdown、HTML、JSON 三种格式，三者基于同一份已提交转录，按转录顺序包含用户、assistant、工具与系统条目。流式中尚未提交的内容 MUST NOT 导出。空转录 MUST 拒绝导出并给出明确原因。

#### Scenario: 同一转录三种格式
- **WHEN** 对同一会话分别导出三种格式
- **THEN** 三者包含相同顺序的条目与相同的可读文本，仅表示方式不同

#### Scenario: 空会话
- **WHEN** 会话没有任何已提交条目
- **THEN** 导出被拒绝并提示尚无内容可导出，不生成文件

#### Scenario: 运行中导出
- **WHEN** 会话正在生成回答时发起导出
- **THEN** 导出包含发起时已提交的条目，不含流式半成品，未完成的工具调用标明未完成状态

### Requirement: 默认内容取舍
导出 MUST 默认不含 thinking，用户可显式选择包含；包含时 thinking MUST 与正文分开呈现。工具条目 SHALL 包含名称、参数摘要、参数详情（若有）、结果、错误状态与耗时（若有）；`/skill:` 调用 SHALL 按"可复制文本规则"还原；系统补充的默认图片提示 MUST NOT 导出。

#### Scenario: 默认不含 thinking
- **WHEN** 用户未选择包含思考过程而导出
- **THEN** 任一格式的输出均不包含 thinking 文本

#### Scenario: 选择包含 thinking
- **WHEN** 用户选择包含思考过程而导出
- **THEN** 每条有 thinking 的 assistant 条目先呈现 thinking，再呈现正文，二者可区分

#### Scenario: 失败的工具调用
- **WHEN** 转录包含返回错误的工具调用
- **THEN** 导出中该工具条目带有错误标识及其错误文本

### Requirement: Markdown 导出格式
Markdown 导出 SHALL 以会话标题、模型、工作区与导出时间开头，其后按角色分节。assistant 正文与用户文本 MUST 按 Markdown 原样输出；工具调用 SHALL 折叠呈现，其中的参数与结果放入代码围栏，围栏长度 MUST 超过内容中最长的反引号序列，使任意内容不会破坏文档结构。

#### Scenario: 内容含代码围栏
- **WHEN** 工具结果文本自身包含三个反引号的代码块
- **THEN** 导出的围栏更长，结果完整保留且后续条目不被吞入代码块

#### Scenario: 图片
- **WHEN** 用户或工具条目含图片
- **THEN** 导出以包含名称、类型和尺寸的占位文字表示，不嵌入图片字节

### Requirement: HTML 导出格式
HTML 导出 SHALL 生成无需网络、无脚本的单文件静态页面，用户与 assistant 条目区分显示，工具调用与 thinking 可折叠。模型与用户内容中的原始 HTML MUST 被转义而不是执行；链接 MUST 仅保留 http、https、mailto 目标；页面 MUST 声明禁止脚本与外部资源加载的内容安全策略。

#### Scenario: 内容含脚本标签
- **WHEN** assistant 正文含 `<script>` 或带事件属性的 HTML
- **THEN** 导出文件中这些内容以文本显示，打开页面不执行任何脚本

#### Scenario: 危险链接
- **WHEN** Markdown 链接目标为 `javascript:` 地址
- **THEN** 导出页面不生成可点击的该链接，仅保留其文字

#### Scenario: 图片内嵌
- **WHEN** 会话含可读取的图片
- **THEN** 图片以内嵌数据的形式出现在对应条目中，离线可见

### Requirement: HTML 图片内嵌预算与失败
HTML 导出 SHALL 对内嵌图片的总大小设置上限，超出上限的图片以占位文字替代并在文件中说明；单张图片读取失败 MUST NOT 使整个导出失败，而是替换为占位说明；导出完成时 SHALL 向用户报告被替换的图片数量。

#### Scenario: 超出预算
- **WHEN** 会话图片总大小超过内嵌上限
- **THEN** 上限之内的图片照常内嵌，其余以占位替代，用户得知有图片未内嵌

#### Scenario: 单张图片不可读
- **WHEN** 某张图片的读取失败
- **THEN** 导出继续完成，该位置显示"图片不可用"占位

### Requirement: JSON 导出格式
JSON 导出 SHALL 输出带格式标识与整数版本号的单个文档，包含会话标题、模型、工作区、导出时间与按序条目；条目 MUST 带类型字段，图片仅含元数据，不含字节；输出 MUST 为合法 JSON 且保留所有文本的原始内容。

#### Scenario: 可被程序解析
- **WHEN** 导出 JSON 并由标准 JSON 解析器读取
- **THEN** 解析成功，版本号存在，条目顺序与转录一致，文本与原文逐字符相同

### Requirement: 导出文件命名
导出文件的默认名称 SHALL 由会话标题与导出时间生成并带对应扩展名；标题中的路径分隔符、控制字符及 `\ / : * ? " < > |` MUST 被替换，名称 MUST 限长，标题为空时使用固定的回退名称。

#### Scenario: 标题含非法字符
- **WHEN** 会话标题为 `修复 a/b:c?`
- **THEN** 默认文件名不含 `/`、`:`、`?`，且仍以对应扩展名结尾

#### Scenario: 超长或空标题
- **WHEN** 标题为空或长度超过上限
- **THEN** 空标题使用回退名称，超长标题被截断，文件名仍有效

### Requirement: 导出中的 codemode 调用

Markdown 与 HTML 导出 SHALL 把 codemode 调用的脚本作为 JavaScript 代码块呈现，并在其后列出嵌套调用（工具名、参数预览、状态、耗时、错误）与脚本输出；JSON 导出 SHALL 在该工具项上包含嵌套调用列表字段。导出 MUST NOT 包含嵌套调用的完整结果正文，也不读取完整输出文件。

#### Scenario: Markdown 导出
- **WHEN** 用户导出含一次 codemode 调用的会话为 Markdown
- **THEN** 该调用显示为脚本代码块、嵌套调用列表与脚本输出，没有嵌套结果正文
