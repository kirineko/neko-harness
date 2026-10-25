# session-file-changes Specification

## Purpose

让用户在不翻聊天记录的情况下，看到本会话中 agent 通过 edit/write 工具修改过哪些文件，并逐次查看每次改动的 diff，作为确认一轮修改结果的统一入口。

## Requirements

### Requirement: 会话改动聚合
系统 SHALL 为每个会话聚合 agent 通过 `edit` 与 `write` 工具成功产生的文件改动，包括 codemode 脚本发起的 `edit` 与 `write` 嵌套调用，按文件给出：工作区相对路径、累计新增与删除行数、操作次数、最近一次改动的先后位置，以及涉及的执行者（主 agent 或子 agent 名称）。失败或被拒绝的调用 MUST NOT 计入。聚合 SHALL 来自会话已保存的条目，不依赖前端已加载的历史分页，且在会话回溯或分叉后与可见条目一致。

#### Scenario: 多次修改同一文件
- **WHEN** 主 agent 先后三次 edit 同一文件，其间一次 edit 因未匹配而失败
- **THEN** 列表中该文件只出现一次，操作次数为 3 次成功之和，失败的那次不计入增删行数

#### Scenario: 子 agent 的改动
- **WHEN** coder 子 agent 在其轮次中 write 了新文件
- **THEN** 该文件出现在父会话的改动列表中，并标明执行者是该子 agent

#### Scenario: 历史未全部加载
- **WHEN** 会话很长，聊天区只加载了最近的消息
- **THEN** 改动列表仍包含更早的改动，与是否已加载聊天历史无关

#### Scenario: 脚本中的改动
- **WHEN** 主 agent 的一个 codemode 脚本对两个文件各调用一次 `tools.edit`，其中一次因未匹配而失败
- **THEN** 成功的那次以主 agent 为执行者出现在列表中，diff 与直接 edit 一致；失败的那次不计入

#### Scenario: 脚本失败或被中止
- **WHEN** 脚本中一次 `tools.write` 成功之后脚本抛出错误，或用户停止了该回答
- **THEN** 已成功的 write 仍计入改动列表（改动没有被撤销），列表在该嵌套调用成功时即更新，不等脚本结束

#### Scenario: 回溯与分叉
- **WHEN** 会话回溯到某个 codemode 调用之前，或从该调用之前的位置分叉
- **THEN** 该调用中脚本产生的改动不出现在回溯后的会话或分叉会话的列表中

### Requirement: 改动列表呈现
Web SHALL 在右侧栏「改动」标签页展示改动文件列表，每行显示文件名与所在目录、新增/删除行数、操作次数及执行者标记；标签上显示改动文件数。列表 SHALL 随 agent 继续修改而更新，无改动时显示空状态说明，且说明范围仅限 agent 的 edit/write 工具改动（不含命令行造成的改动）。

#### Scenario: 实时更新
- **WHEN** 用户打开改动标签页时 agent 又 edit 了一个新文件
- **THEN** 列表无需手动刷新即出现该文件，标签上的文件数同步增加

#### Scenario: 空状态
- **WHEN** 本会话尚无任何成功的 edit/write
- **THEN** 显示空状态，并说明命令行（如 bash）造成的改动不在此列表中

### Requirement: 逐次 diff 查看
用户点击改动文件时，系统 SHALL 按时间顺序展示该文件每一次改动的 diff（含执行者与顺序），复用聊天工具卡的 diff 着色规则。write 造成的改动因无法得知被覆盖前的内容，SHALL 显示为整文件新增并标注 `write`。单次 diff 与单文件总量 SHALL 有体量上限，超出时标注已截断。详情 SHALL 提供「查看当前内容」，切换到该文件在工作区中的当前内容。

#### Scenario: 查看一个文件的多次改动
- **WHEN** 用户点击被 edit 两次的文件
- **THEN** 依次显示两次改动的 diff，增删行有底色区分，每次标明执行者与序号

#### Scenario: write 的表述
- **WHEN** 用户查看由 write 写入的文件的改动
- **THEN** diff 显示为整文件新增并标注 `write`，不声称是相对旧内容的差异

#### Scenario: 跳到当前内容
- **WHEN** 用户在改动详情中点击「查看当前内容」
- **THEN** 切换到文件标签页的查看器并显示该文件当前内容；若文件已被删除，显示文件不存在

### Requirement: 改动范围与边界说明
改动数据 SHALL 仅反映 agent 的 `edit`/`write` 工具调用，MUST NOT 声称等同于磁盘或 git 的实际差异；路径位于工作区之外的改动 SHALL 单独标注「工作区外」，不提供内容查看。聚合 SHALL 对文件数、每文件操作数与 diff 总字节数设置上限，超出时明示不完整而非静默丢弃。

#### Scenario: 工作区外路径
- **WHEN** agent 写入了工作区之外的文件
- **THEN** 列表以「工作区外」标注该条目，可看 diff 但没有查看当前内容的入口

#### Scenario: 超出上限
- **WHEN** 会话累计改动文件数超过上限
- **THEN** 列表显示上限内的文件并明确提示「列表不完整」
