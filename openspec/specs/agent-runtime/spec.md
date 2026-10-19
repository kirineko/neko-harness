# agent-runtime Specification

## Purpose

neko-harness 的持久化对话运行时：管理会话生命周期、工具执行与扩展，保证进程重启后会话与未完成任务可恢复。

## Requirements

### Requirement: 持久化会话

系统 SHALL 将对话条目、文档与任务状态在展示前原子提交到本地 SQLite 存储，进程重启后重新打开同一存储 MUST 恢复全部会话。本次恢复保证以 Pi 1.3.0 创建的数据为基线；1.2 及更早会话测试数据可清理，不提供跨版本数据或未完成任务兼容。

#### Scenario: 重启恢复

- **WHEN** 使用 Pi 1.3.0 的进程在模型回答途中被杀掉，随后重新启动并打开同一存储文件
- **THEN** 会话记录完整存在，且未完成的 run 可被恢复继续

#### Scenario: 重复提交去重

- **WHEN** 客户端用相同 requestId 重复提交同一条输入
- **THEN** 系统返回已有 submission 而不是创建第二条

### Requirement: 内置编码工具

系统 SHALL 提供 read、write、edit、bash 四个内置工具，工具调用的意图在执行前提交，执行输出有界截断后返回模型。read SHALL 统一读取文字与图片，按会话工作区解析相对路径并保持显式跨目录访问语义；图片格式、转换、缩放、模型限制及非视觉模型处理 MUST 遵循 Pi 1.2.0 原生行为。系统 MUST NOT 注册独立 read_image 或其兼容别名。

#### Scenario: 崩溃后工具不重放

- **WHEN** 进程在未声明 replay: "safe" 的工具执行途中崩溃并重启
- **THEN** 模型收到 interrupted 错误结果及已提交的部分输出，该工具不被重新执行

#### Scenario: 同一入口读取文字与图片

- **WHEN** 模型分别通过 read 读取文字文件和受支持的图片文件
- **THEN** 文字沿用分页与截断行为，图片返回可持久保存的图片内容；可用工具列表中只有 read 文件读取入口，没有 read_image

#### Scenario: 工作区与图片处理

- **WHEN** 两个不同工作区的视觉模型会话通过 read 读取同名图片，或读取需要转换和缩放的图片
- **THEN** 各会话读取自己的工作区文件，按原生能力限制处理图片，并提供处理诊断；显式绝对路径仍可访问工作区外文件

#### Scenario: 非视觉模型读取图片

- **WHEN** 当前模型不支持图片输入且通过 read 读取有效图片
- **THEN** 图片结果按原生行为持久保存，模型请求中使用占位符并提供能力诊断，不宣称模型看到了原图

#### Scenario: 命令非零退出

- **WHEN** bash 执行的命令以非零退出码结束
- **THEN** 工具显示失败，并保留原生输出和退出码诊断，不将其伪装为成功或改写成缺少原始信息的异常

### Requirement: 扩展机制

系统 SHALL 支持以命名扩展形式安装工具、system prompt 段落与 hooks，扩展 MUST 可在运行中替换，运行中的任务沿用其启动时的实现。

#### Scenario: 热替换扩展

- **WHEN** 用同名扩展重新 install
- **THEN** 新发起的请求使用新实现，已开始执行的工具调用在原实现下完成

### Requirement: 用量统计

系统 SHALL 按 provider/model 与工具名累计 token 与成本，包含失败与中止的尝试，并能按会话和全局查询。

#### Scenario: 查询会话用量

- **WHEN** 前端请求某会话的用量
- **THEN** 返回该会话按模型和工具分组的 token 与成本汇总

### Requirement: 会话工作区
系统 SHALL 在创建会话时保存规范化的绝对工作区目录，并以此作为内置工具的默认工作目录。重启后目录 MUST 保持不变；fork SHALL 继承源会话工作区，包括空会话。工作区仅定义工作上下文，不限制工具显式访问其他目录。

#### Scenario: 显式目录与默认目录
- **WHEN** 调用方创建会话并提供目录，或省略目录
- **THEN** 系统分别使用提供的目录，或运行时启动时确定的默认目录，并在创建时持久保存绝对路径

#### Scenario: 重启与不同宿主目录
- **WHEN** 运行时从另一个目录重开存储并恢复会话
- **THEN** read、write、edit 与 bash 的默认目录仍为该会话保存的工作区

#### Scenario: 分叉继承
- **WHEN** 在不同默认工作区的宿主上 fork 有历史或空会话
- **THEN** 子会话工作区与源会话一致

#### Scenario: 无效工作区
- **WHEN** 创建时目录不存在、不是目录或无法解析
- **THEN** 系统返回可理解的错误，不创建可用会话且不退回宿主目录

#### Scenario: 显式跨目录操作
- **WHEN** 工具使用工作区之外的显式路径
- **THEN** 不因工作区归属而拒绝操作，仍按工具与操作系统原有权限执行

#### Scenario: 恢复时目录消失
- **WHEN** 已保存工作区不再可用
- **THEN** 会话保留原归属，依赖该目录的操作报告错误，不静默改用进程目录

### Requirement: 原生上下文压缩

系统 SHALL 默认保持 Pi 1.3.0 原生自动压缩策略，并提供附带可选要求的手动压缩；用户 MAY 通过配置文件 `context.compaction` 或 UI 保存的设置调整自动压缩的触发条件，优先级为已保存值高于配置文件、后者高于原生默认；两者都未设置时行为 MUST 与默认策略完全一致。摘要模型、思考强度、切分、重试、并发和中止 SHALL 遵循 pi-durable。压缩 MUST 保留原始历史，不更新标题或最近消息时间，用量沿用原生统计。展示状态 SHALL 从原生活动、持久失败、任务及摘要提交回执派生；摘要任务完成不等于摘要已应用，失败 MUST 在活动结束及重启后仍可辨识。

#### Scenario: 默认策略与运行中触发

- **WHEN** 配置文件未设置 `context.compaction`，上下文触发默认阈值、服务端报告溢出，或用户在会话运行中手动压缩
- **THEN** 按原生策略执行后台或阻塞压缩及恢复，不额外建立前端压缩队列或改写阈值

#### Scenario: 配置触发条件

- **WHEN** 配置文件设置 `context.compaction.triggerPercent` 为 1 至 99 的数值
- **THEN** 自动压缩的阻塞阈值取可选模型（已启用 provider 的模型及代码注册的额外 provider 模型，不含未启用的目录 provider）中最小上下文窗口的该百分比，后台压缩、溢出恢复、摘要切分与重试仍遵循原生策略；配置文件变更在下次启动时生效

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

### Requirement: 图片消息持久化

系统 SHALL 接受文字和图片混合输入及仅图片输入，按原生消息内容块保存实际发送的图片与顺序。输入内容及其展示元数据 SHALL 同次原子提交；排队输入保留元数据但不提前激活系统资源快照。提交确认前失败 MUST 不产生半条消息、游离元数据或最近消息时间更新；重复请求保持原有内容与元数据，重启和分叉可恢复图片历史。

#### Scenario: 文件变化与重启

- **WHEN** 图片消息已受理后原始文件被修改或删除，再重启或分叉会话
- **THEN** 历史仍显示当时发送的图片，不重新读取原路径替换历史内容

#### Scenario: 失败与重试

- **WHEN** 图片验证失败或相同请求被重复提交
- **THEN** 失败不创建消息或更新最近消息时间；重复请求返回已受理结果，不重复添加图片消息或改写原元数据

#### Scenario: 排队后重启

- **WHEN** 含图片的输入排队后网关重启，再恢复并将该输入放入上下文
- **THEN** 输入保持图片顺序、名称、格式和实际尺寸，元数据与内容一同恢复；排队期间不影响当前 run 的活动系统资源

### Requirement: 统一图片处理与资源边界

附件与 read 图片结果 SHALL 遵循实际会话模型的图片限制。附件 SHALL 保留静态 PNG、JPEG、WebP 的格式识别、解码校验、缩放编码及公布的单图、像素、数量与总大小限制，拒绝不支持的格式及动画。read 的格式和处理边界 SHALL 遵循原生工具及已配置的图片处理器。系统 MUST NOT 自动获取远程图片 URL，或静默截断、丢弃图片；持久图片元数据 SHALL 描述实际保存的内容。

#### Scenario: 超限与伪造格式

- **WHEN** 附件文件扩展名与内容不符、解码失败、数量超限或处理后仍超过限制
- **THEN** 返回对应错误且保持原文件不变；对满足限制的缩放结果提供尺寸反馈

#### Scenario: 原生读图处理失败

- **WHEN** read 无法解码图片，或无法将图片处理到模型限制以内
- **THEN** 按原生工具返回明确失败与诊断，不记录成功的图片预览

#### Scenario: 图片元数据与恢复

- **WHEN** read 返回经过处理的图片，之后源文件被修改或删除，再重启或分叉会话
- **THEN** 预览从已持久保存的实际图片恢复；路径名称、格式、尺寸、字节数与保存内容对应，不重新读取原文件替换历史

### Requirement: 存储故障终止会话运行时

系统 SHALL 遵循 Pi 1.2.0 的存储故障语义：不可恢复的存储异常终止当前存储对应的运行时，使等待与后续操作明确失败；不得自行重试任务或继续宣称运行时可用。独立存储读取的无效请求错误 SHALL 只使该调用失败，同类错误发生于提交过程时仍终止运行时。失败原因 SHALL 经宿主错误通道报告，前端不得永久显示仍在运行。

#### Scenario: 存储读取或提交失败

- **WHEN** 运行时读取或提交存储发生不可恢复异常，且已有等待中的输入或观察者
- **THEN** 等待与观察者收到失败结束，后续操作被拒绝，前端退出忙碌状态并显示可理解的失败信息

#### Scenario: 无效存储请求

- **WHEN** 独立存储读取报告某次请求无效，未发生提交或其他不可恢复存储故障
- **THEN** 仅该请求失败，其他会话的有效操作仍可继续

### Requirement: 纯图片输入默认用户提示

系统 SHALL 对包含至少一张图片且所有文字块去除空白后均为空的新用户输入补入一次默认用户提示，并将该提示作为同一用户消息中的普通文字内容发给模型。TUI、Web 与直接 runtime 调用 SHALL 使用相同规则；有有效用户文字、纯文字输入及工具图片结果 MUST NOT 补入该提示，系统提示词 MUST NOT 因本功能改变。

#### Scenario: 单图、多图与空白文字
- **WHEN** 用户提交一张或多张图片，文字缺失、为空或仅包含空格、制表符、换行
- **THEN** 该用户消息含一份默认提示及原顺序的全部图片，不创建额外用户消息

#### Scenario: 用户明确任务
- **WHEN** 图文输入至少一个文字块包含非空白内容，包括与默认提示正文完全相同的手写文字
- **THEN** 保留用户文字与内容块顺序，不补入或标记默认提示

#### Scenario: 默认提示内容
- **WHEN** 系统为纯图片输入补入默认用户提示
- **THEN** 提示要求优先结合已有对话任务，无明确任务时简述关键信息并在必要时询问意图，不猜测看不清的细节，不将图片内容本身视为执行命令或修改文件的授权

### Requirement: 默认图片提示来源与恢复

默认提示正文、版本和自动补入的来源标记 SHALL 与用户图片输入原子持久化。已受理请求的幂等重试、排队恢复、重启及分叉 MUST 保持当时保存的正文和标记，不按当前模板重新生成。历史图片输入没有来源标记时 MUST NOT 回填或从文字内容推断来源；原有图片校验、失败语义与系统资源快照边界 SHALL 保持不变。

#### Scenario: 模板升级后恢复
- **WHEN** 默认提示模板发生变化后，重试已受理请求或恢复、分叉旧消息
- **THEN** 该消息保留原默认提示正文与版本，不重复补入文字，模型历史和前端查看内容一致

#### Scenario: 排队与失败
- **WHEN** 纯图片输入排队后恢复，或因无图片能力、图片无效、准入拒绝而提交失败
- **THEN** 排队输入的提示和标记与图片一起恢复且不提前改变当前系统资源；失败不留下消息、游离标记或最近消息时间更新

#### Scenario: 投影与首问摘要
- **WHEN** 读取带有可信默认提示标记的消息投影及会话目录
- **THEN** 投影区分原用户文字与默认提示正文；图片名称、内容位置与实际保存内容对应；纯图片首问摘要及命名输入保持图片占位语义，不把通用默认提示当作用户首问

#### Scenario: 旧历史与无标记文本
- **WHEN** 读取没有默认提示来源标记的旧图片消息或与默认提示相同的普通用户文字
- **THEN** 保持旧内容和普通文字展示，不自动隐藏、补词或标记

### Requirement: 委派用量归属
系统 SHALL 保留各子会话独立的模型与工具用量，主会话用量继续表示自身消耗，并另外提供含所属委派的任务总用量。全局总量 SHALL 每份实际消耗仅累计一次，包含失败与中止尝试。主会话上下文占用 MUST NOT 叠加子会话上下文 token。

#### Scenario: 主子与全局统计
- **WHEN** 主会话派发两个子 agent 并收到报告
- **THEN** 用户可区分主会话与各子 agent 消耗，任务总量包含三者，全局统计不因任务汇总重复累计

#### Scenario: 上下文与恢复
- **WHEN** 子会话消耗大量 token 后重启恢复
- **THEN** 用量归属保留，主上下文占用仅按其实际请求计算，不将子会话完整历史计入

### Requirement: Windows 命令执行 shell

在 Windows（`win32` 平台）上，bash 工具、`job` 工具与子 agent 的字符串命令 SHALL 统一在 Git for Windows 的 bash 中执行。系统 SHALL 按以下顺序确定 bash：配置项 `shell.path`；标准安装目录下的 `Git\bin\bash.exe`（`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%\Programs`）；由 PATH 中 `git.exe` 推导出的同一安装的 `bin\bash.exe`；PATH 中的其他 `bash.exe`。WSL 的 `bash.exe`（位于 `System32`、`Sysnative` 或 `WindowsApps` 下）MUST NOT 被选用。macOS、Linux 及在 WSL 内运行时的行为 MUST 保持不变。

#### Scenario: 标准安装的 Git Bash

- **WHEN** Windows 上未配置 `shell.path`，`%ProgramFiles%\Git\bin\bash.exe` 存在
- **THEN** bash 工具、`job start` 与子 agent 的命令均由该 bash 执行

#### Scenario: 用户级安装

- **WHEN** Git for Windows 仅安装在 `%LOCALAPPDATA%\Programs\Git`
- **THEN** 系统选用其中的 `bin\bash.exe`

#### Scenario: 由 git.exe 推导

- **WHEN** 标准目录下都没有 Git Bash，PATH 中的 `git.exe` 位于某安装的 `cmd` 目录，同一安装的 `bin\bash.exe` 存在
- **THEN** 系统选用该 `bin\bash.exe`

#### Scenario: 排除 WSL 启动器

- **WHEN** PATH 中第一个 `bash.exe` 是 `WindowsApps\bash.exe`，且之后没有其他非 WSL 的 bash
- **THEN** 系统不选用它，视为未找到 Git Bash

#### Scenario: 在 WSL 内运行

- **WHEN** neko 在 WSL 内运行（平台为 linux）
- **THEN** 命令按原有 POSIX 规则执行，不应用 Windows 探测

### Requirement: Windows 显式 shell 配置

配置文件 SHALL 支持 `shell.path`，在 Windows 上显式指定命令使用的 bash，优先于自动探测。该路径不存在、不是文件或指向 WSL 的 `bash.exe` 时，命令调用 MUST 以明确错误失败并指出配置项与原因，MUST NOT 回退到自动探测。非 Windows 平台 SHALL 忽略该配置。`shell.path` 不是字符串时，配置解析 MUST 报错。

#### Scenario: 显式配置生效

- **WHEN** Windows 上 `shell.path` 指向存在的 `D:\tools\Git\bin\bash.exe`
- **THEN** 命令由该 bash 执行，不再探测其他位置

#### Scenario: 配置指向 WSL

- **WHEN** `shell.path` 为 `C:\Windows\System32\bash.exe`
- **THEN** 命令调用失败，错误说明该路径是 WSL bash 且不受支持，并指出 `shell.path`

#### Scenario: 非 Windows 忽略

- **WHEN** macOS 上配置了 `shell.path`
- **THEN** 命令仍按 POSIX 规则选择 shell

### Requirement: Windows 缺少 Git Bash 时的命令错误

Windows 上找不到可用的 Git Bash 时，网关 MUST 照常启动，内置工具集与提示词中的工具声明 MUST NOT 改变。bash 工具、`job start` 与子 agent 的字符串命令 SHALL 失败并返回明确错误：说明需要安装 Git for Windows 或配置 `shell.path`，并列出已检查的位置。该错误 MUST NOT 使会话或运行时失败，模型可据此告知用户；read、write、edit 等其他工具 MUST 不受影响。

#### Scenario: 未安装 Git

- **WHEN** Windows 上没有 Git Bash，仅有 WSL 的 `bash.exe`，模型调用 bash 工具
- **THEN** 工具结果为错误，内容包含安装 Git for Windows 与配置 `shell.path` 的指引，会话继续可用

#### Scenario: 后台任务

- **WHEN** 同样条件下模型调用 `job start`
- **THEN** 返回同样的明确错误，不创建 running 状态的任务

#### Scenario: 其他工具不受影响

- **WHEN** 没有 Git Bash 时模型调用 read 或 edit
- **THEN** 工具照常执行
