# prompt-context Specification

## Purpose

为会话组装分节系统提示词并注入项目上下文：固定五节结构、两级 AGENTS.md、标准化目录下的 skills 渐进式披露，以及请求级资源刷新。

## Requirements

### Requirement: 分节系统提示词

系统 SHALL 以固定顺序的五个命名节组装系统提示词：`preamble`（角色定义）、`rules`（按本次请求启用的工具拼接的规则列表，全局去重）、`project_context`、`skills`、`cwd`（会话工作区绝对路径）。无内容的节 MUST 省略。preamble SHALL 为无标签角色文本，其余节 MUST 自带 XML 标签，同一次请求的所有节 MUST 共享同一次构建结果。

#### Scenario: 新会话首次请求

- **WHEN** 新会话发起第一次模型请求
- **THEN** 系统提示词按 preamble、rules、project_context、skills、cwd 顺序呈现，preamble 为无标签文本，其余节以对应 XML 标签包裹

#### Scenario: 空内容节省略

- **WHEN** 会话工作区与用户目录均无 AGENTS.md
- **THEN** 系统提示词不包含 `project_context` 节，其余节顺序不变

#### Scenario: 规则随工具集变化

- **WHEN** 两次请求之间启用的工具集发生变化
- **THEN** `rules` 节只包含当前启用工具对应的规则，且不存在重复条目

### Requirement: AGENTS.md 发现与注入

系统 SHALL 收集两个位置的 AGENTS.md：`~/.agents/AGENTS.md`（用户级，在前）与 `<workspace>/AGENTS.md`（项目级，在后），每个文件渲染为一个带 `path` 属性的 `<project_instructions>` 块。系统 MUST NOT 向父目录遍历，MUST NOT 识别 AGENTS.md 以外的文件名（无 override、无 CLAUDE.md 回退），MUST NOT 扫描 `.neko` 目录。

#### Scenario: 两级文件共存

- **WHEN** 用户级与项目级 AGENTS.md 都存在
- **THEN** `project_context` 节含两个 `<project_instructions>` 块，用户级在前，路径属性为各自的绝对路径

#### Scenario: 仅项目级存在

- **WHEN** 只有 `<workspace>/AGENTS.md` 存在
- **THEN** `project_context` 节只含该项目级块

#### Scenario: 其他文件名不识别

- **WHEN** 工作区只有 `CLAUDE.md` 或 `AGENTS.override.md`
- **THEN** 这些文件不出现在系统提示词中

### Requirement: Skills 目录发现

系统 SHALL 扫描三个位置的技能目录：`~/.agents/skills/<name>/SKILL.md`（用户级）、`<workspace>/.agents/skills/<name>/SKILL.md`（项目级）与随包分发的内置技能目录（内置级）。SKILL.md MUST 解析 YAML frontmatter，`description` 缺失或为空时该技能 MUST 被跳过；`name` 缺省时回落到目录名。同名技能优先级 SHALL 为项目级 > 用户级 > 内置级。MUST NOT 支持 `.neko` 目录或裸 `.md` 文件。内置级目录缺失时 MUST 静默视为空集。

#### Scenario: 两级技能合并

- **WHEN** 用户级有技能 a、b，项目级有技能 b、c
- **THEN** 提示词列出 a、b、c 三个技能，其中 b 采用项目级定义

#### Scenario: 内置级兜底

- **WHEN** 内置级有技能 d，用户级与项目级均无同名技能
- **THEN** 提示词列出技能 d

#### Scenario: 三级同名优先级

- **WHEN** 内置级、用户级、项目级各有一个同名技能 e，内容不同
- **THEN** 提示词中 e 采用项目级定义

#### Scenario: 内置目录缺失

- **WHEN** 内置级目录不存在
- **THEN** 用户级与项目级技能正常发现，无告警

#### Scenario: 无效技能跳过

- **WHEN** 某 SKILL.md 缺少 frontmatter 或 description 为空
- **THEN** 该技能不出现在提示词中，其余技能不受影响

### Requirement: Skills 渐进式披露

系统 SHALL 在 `skills` 节只注入每个技能的 name、description 与 location（SKILL.md 的绝对路径），MUST NOT 内联技能正文；提示词 MUST 指引模型用 `read` 工具按 description 匹配后自行加载技能文件。frontmatter 含 `disable-model-invocation: true` 的技能 MUST NOT 出现在提示词中。

#### Scenario: 元数据注入

- **WHEN** 技能正文有数千行
- **THEN** 提示词中该技能只占 name、description、location 三元组，正文不进上下文

#### Scenario: 禁用模型调用的技能

- **WHEN** 某技能 frontmatter 声明 `disable-model-invocation: true`
- **THEN** 该技能不出现在 `skills` 节

### Requirement: 资源刷新与请求内一致性

系统 SHALL 在新用户输入提交时按会话工作区准备 AGENTS.md 与 skills 快照，仅在该输入进入 transcript 后激活。尚未放入上下文的输入、失败或撤回的输入 MUST NOT 改变活动快照。没有新输入进入上下文时，后续工具轮 MUST 复用活动资源，不因磁盘修改改变系统节。同一边界放入多个输入时，最后一个输入的快照 SHALL 优先。文件修改、删除和权限变化在新输入生效时体现，无需 reload；各节共享构建结果，各会话快照隔离。

#### Scenario: 编辑后自动生效

- **WHEN** 用户在会话进行中编辑了 `<workspace>/AGENTS.md`，随后提交下一条输入
- **THEN** 该输入触发的请求的系统提示词包含编辑后的内容

#### Scenario: 新增技能目录

- **WHEN** 用户在会话进行中新建 `<workspace>/.agents/skills/x/SKILL.md`，随后提交下一条输入
- **THEN** `skills` 节包含技能 x

#### Scenario: run 内修改不改变系统提示词

- **WHEN** 一次 run 中模型调用工具修改了 `<workspace>/AGENTS.md`，工具轮结束后同一 run 发起下一次模型请求
- **THEN** 在没有新输入进入上下文且工具与配置不变时，系统提示词与本 run 第一次请求完全相同，不追加系统更新；修改在新输入进入上下文时生效

#### Scenario: 会话隔离

- **WHEN** 会话 A 与会话 B 共享同一工作区，会话 B 的 run 进行中，用户修改 AGENTS.md 后在会话 A 提交输入
- **THEN** 会话 A 的请求包含修改后的内容；会话 B 当前 run 的后续请求系统提示词不变

#### Scenario: 无快照时加载

- **WHEN** 进程重启后恢复一个未完成的 run，该会话尚无快照
- **THEN** 系统按会话工作区加载资源作为快照，请求正常继续

#### Scenario: 排队或撤回不提前激活

- **WHEN** 当前 run 进行中提交 followUp 输入并随后撤回该排队输入
- **THEN** 当前 run 的后续请求继续使用原活动快照

#### Scenario: 提交被拒绝

- **WHEN** 忙碌会话拒绝了已准备资源的输入
- **THEN** 该输入的资源快照不生效，当前 run 的系统资源不变

#### Scenario: 多输入版本按 placement 生效

- **WHEN** 两个输入分别以不同资源版本提交并依次进入上下文
- **THEN** 每次 placement 激活对应版本；若同批放入，则最后一个输入的资源快照优先

### Requirement: 渲染失败语义

资源读取或解析失败时，对应节 SHALL 返回"省略"而非抛错；单个文件失败 MUST NOT 影响其他文件与其他节。失败 MUST NOT 阻断模型请求。

#### Scenario: 文件不可读

- **WHEN** AGENTS.md 存在但读取失败（权限、编码等）
- **THEN** 该文件对应的块被省略，请求正常继续

#### Scenario: frontmatter 解析失败

- **WHEN** 某 SKILL.md 的 YAML frontmatter 无法解析
- **THEN** 该技能被跳过，其余技能正常注入

#### Scenario: 诊断可见且不暴露正文

- **WHEN** 资源不可读、技能名称含空白或控制字符、frontmatter 非合法映射，或指令文件过大
- **THEN** 诊断只包含路径与固定原因，不包含正文或 YAML 片段；无效技能被跳过，过大指令保留全文且提示历史压缩不能缩短系统输入

### Requirement: 提示词渲染确定性

相同资源、相同顺序的工具声明与工作区 MUST 渲染出逐字节相同的系统节，不依赖进程 locale、文件系统枚举顺序或加载次数。用户级与项目级技能目录 SHALL 各自按 UTF-16 码元顺序排序；随后按用户级在前、项目级在后合并，同名覆盖保留已有位置，不要求合并列表全局排序。

#### Scenario: locale 无关

- **WHEN** 同一组技能目录（名称含大小写混合与非 ASCII 字符）分别在不同 locale 的进程中渲染
- **THEN** 两次渲染的 `skills` 节逐字节相同

#### Scenario: 内容未变不产生更新

- **WHEN** 用户提交新输入时资源被重读，但所有 AGENTS.md 与 SKILL.md 内容均未变化
- **THEN** 该请求不追加任何系统提示词更新

### Requirement: 工具规则与工具接口一致

`rules` 节中某工具的规则 MUST 使用该工具实际声明的参数名称与调用形状描述用法，不得引用工具不存在的参数。对 edit 工具，规则 SHALL 描述 `edits[]` 数组形式：每项 `oldText` 精确匹配且尽量短、同一文件多处修改合并为一次调用、各项基于原始文件匹配且不得重叠。

#### Scenario: edit 规则引用实际参数

- **WHEN** 请求启用了 edit 工具
- **THEN** `rules` 节中的 edit 规则以 `edits[].oldText` 指代匹配文本，并包含多处修改合并为一次调用、各项不得重叠的指引

### Requirement: 内置角色与委派提示
提示词 SHALL 保持五节结构，在角色定义与工具规则中表达内置角色职责、可用工具及委派条件。主 agent SHALL 被引导仅在独立子任务、上下文隔离或并行调查有益时委派，简单任务直接处理；派发时说明目标、材料、约束和交付要求。子 agent SHALL 被要求提交自包含最终报告，由主 agent 汇总与验证，不直接向用户提问或再次委派。explore SHALL 被告知默认使用读取与搜索，必要的 Bash 调用由系统请求逐次用户审批，拒绝后改用其他方法或报告限制，不得绕过或反复请求已拒绝操作；该审批交互不等于自由向用户提问，亦不授予直接写入或编辑工具权限。

#### Scenario: 角色区分
- **WHEN** 分别构建主 agent、explore、plan 与 coder 的提示词
- **THEN** 五节顺序保持不变，各角色职责明确且规则与实际启用工具一致，子 agent 无委派能力

#### Scenario: 用户明确约束
- **WHEN** 用户要求只调研或只规划，主 agent 考虑委派
- **THEN** 委派指引要求保留用户约束，不把调查任务升级成 coder 修改任务

#### Scenario: 命令审批与角色说明
- **WHEN** explore 收到需要命令的调查任务
- **THEN** 提示词说明获批命令可能产生副作用，仍需遵守用户任务约束，不再将 explore 描述为绝对不能执行命令或保证严格只读

### Requirement: 子会话资源快照
子 agent SHALL 按自身工作目录获取两级项目指令与技能资源，遵循新输入提交准备、进入上下文后激活的现有快照规则。任务提交与恢复 MUST NOT 绕过资源边界或改变主会话活动快照；子 agent 的技能读取 MUST NOT 扩大该角色工具权限。

#### Scenario: 委派过程中资源变化
- **WHEN** 子 agent 已开始工具轮后工作区指令文件被修改
- **THEN** 该轮复用子会话活动快照，主会话快照不被改变；重启后的资源重建遵循现有规则

#### Scenario: 受限角色读取技能
- **WHEN** explore 读取包含执行脚本步骤的技能
- **THEN** 技能内容不会授予直接写入工具，也不能绕过每次 Bash 调用的用户审批；未获批准或不可执行的步骤作为限制反馈

#### Scenario: 接续输入刷新资源
- **WHEN** 同一子 agent 空闲期间工作区指令或技能文件变化，随后接续新任务
- **THEN** 新输入按既有准备/激活边界使用新资源快照，旧轮正文与主会话活动快照不被改写

### Requirement: 已有子 agent 接续指引
主 agent 的工具规则 SHALL 说明子 agent 可持久复用及查询，相关后续任务优先考虑接续合适的空闲子 agent，并提供本轮目标、约束和交付要求。新职责、需要上下文隔离或角色不适合时 SHALL 引导创建新身份；不能将忙碌拒绝理解为任务已受理。子 agent SHALL 被告知可使用自身已有上下文，但不可假定看到主会话或获得新增权限。

#### Scenario: 同一调查的追问
- **WHEN** 主 agent 需要补充刚才调查的证据或验证结论
- **THEN** 指引支持使用已有稳定身份接续，不要求重传完整子历史、不因复用绕过 Bash 审批

#### Scenario: 职责不匹配
- **WHEN** 已有 explore 调查完成，而下一步要求实现代码
- **THEN** 不把 explore 接续为 coder；选择或创建符合角色的子 agent 并显式交接必要材料

### Requirement: 后台任务工具规则
启用 `job` 工具时，`rules` 节 SHALL 包含其规则并使用该工具实际声明的动作与参数名：长期运行或不会自行退出的命令（开发服务器、watcher）用 `job` 的 `start`，而不是 `bash`；`start` 返回后用 `output` 读取日志、`stop` 终止；job 无 stdin，不得用于需要交互输入的命令；job 终止后会收到系统回报，不需轮询。未启用 `job` 时 MUST NOT 出现这些规则，且 `bash` 规则不变。

#### Scenario: 规则引用实际参数
- **WHEN** 请求启用了 `job` 工具
- **THEN** `rules` 节以 `start`、`output`、`stop`、`list` 及 `command`、`jobId`、`timeout` 指代用法，并包含长期命令用 `job`、不用于交互命令、终止后自动回报的指引

#### Scenario: 子 agent 不含规则
- **WHEN** 渲染子 agent 的提示词
- **THEN** 其 `rules` 节不包含 `job` 规则，与其工具集一致

### Requirement: 待办工具规则
启用 `todo` 时，`rules` 节 SHALL 使用实际参数说明 `list` 和 `replace`：多步骤任务按需维护列表，保留既有条目 ID，仅在实际完成后标记完成，未知当前列表时先读取。简单问题 MUST NOT 被要求强制建表。未启用该工具时 MUST NOT 出现规则；列表正文 MUST NOT 作为新增系统节注入，既有五节和资源快照边界保持不变。

#### Scenario: 主会话与受限角色
- **WHEN** 分别构建启用 `todo` 的主会话与未启用它的子 agent 提示词
- **THEN** 仅主会话出现准确的列表读取、整体替换和状态维护规则，两者均保留原五节结构

#### Scenario: 压缩后读取
- **WHEN** 模型在压缩后无法确认当前待办内容
- **THEN** 规则引导调用 `todo` 的 `list` 获取持久列表，不从旧摘要猜测或要求另建一份列表

### Requirement: 用户提问工具规则
启用 `ask_user` 时，`rules` 节 SHALL 说明单题、单选/多选（`multiple`）、选项与推荐标记（`recommended`）及选项外的自由文字能力，并给出使用准则：仅在缺少必要的用户决策或偏好、且无法通过读取代码/环境或合理假设自行确定时提问，不把可自行确定的事项抛给用户；问题简短自包含，选项互斥（多选除外）、简短并可单独理解，有明确倾向时用 `recommended` 标出；跳过不代表同意，应基于自身判断继续并说明假设，情况未变时不重复提问；工具等待无需轮询；相互独立的问题可在同一轮连续提出（按序逐个呈现），相互依赖的问题分轮提问；不得用它索取密钥、口令等敏感信息。问答 MUST NOT 替代 Bash 审批或扩大任何工具权限。未启用时不出现规则，子 agent 仍向主 agent 报告缺失信息而非直接询问用户。

#### Scenario: 规则与工具契约一致
- **WHEN** 构建启用 `ask_user` 的主会话提示词
- **THEN** 使用实际声明的 `question`、`multiple`、`options` 及选项的 `id`/`label`/`description`/`recommended` 字段，不描述不存在的批量多题或任意表单能力，并明确等待后通过同一工具取得答案

#### Scenario: 跳过与授权区分
- **WHEN** 用户跳过问题，或以文字表达执行命令的意愿
- **THEN** 规则不把跳过当作默认选项，也不把普通问答答案作为独立 Bash 审批的授权

#### Scenario: 不过度提问且不索取敏感信息
- **WHEN** 构建启用 `ask_user` 的主会话提示词
- **THEN** 规则明确要求先自行确定可确定的事项、仅就必要决策提问，并禁止通过该工具索取密钥或口令

#### Scenario: 回答不刷新资源
- **WHEN** 问题等待期间磁盘上的 AGENTS.md 或 skills 改变，随后用户回答
- **THEN** 原运行继续复用活动资源快照，直到新的普通用户输入按既有 placement 边界生效

### Requirement: Windows shell 环境说明

在 Windows 上启用 bash 或 `job` 工具时，`rules` 节 SHALL 包含一条固定说明：命令运行于 Git for Windows 的 bash（不是 PowerShell 或 cmd，也不是 WSL），路径应使用正斜杠（如 `D:/code`）或 `/d/code` 形式，不要使用反斜杠。该说明 MUST 只依赖平台，同一平台与相同资源下渲染结果保持逐字节一致；非 Windows 平台 MUST NOT 出现该说明，未启用 bash 与 `job` 的角色 MUST NOT 出现该说明。

#### Scenario: Windows 主会话

- **WHEN** 在 Windows 上为启用 bash 的主会话组装提示词
- **THEN** `rules` 节包含 Git Bash 与正斜杠路径的说明

#### Scenario: 非 Windows

- **WHEN** 在 macOS 或 Linux 上组装同一会话的提示词
- **THEN** `rules` 节不包含该说明，其他内容不变

#### Scenario: 无命令工具的角色

- **WHEN** 在 Windows 上为不含 bash 与 `job` 的角色组装提示词
- **THEN** 不出现该说明

### Requirement: 资源文件 BOM 容错

读取 AGENTS.md 与 SKILL.md 时，系统 SHALL 忽略文件开头的 UTF-8 BOM，再按既有规则处理：SKILL.md 的 frontmatter 识别与解析、AGENTS.md 的正文渲染。带 BOM 的文件 MUST 与不带 BOM 的同内容文件产生相同的技能元数据与相同的 `project_context` 渲染结果。CRLF 行尾保持既有的兼容处理。

#### Scenario: 带 BOM 的 SKILL.md

- **WHEN** 某 SKILL.md 以 UTF-8 BOM 开头，随后是合法的 frontmatter 与非空 description
- **THEN** 该技能被正常收录，name 与 description 与去掉 BOM 后的文件一致

#### Scenario: 带 BOM 的 AGENTS.md

- **WHEN** 项目级 AGENTS.md 以 UTF-8 BOM 开头
- **THEN** `project_context` 中渲染的正文不含 BOM 字符
