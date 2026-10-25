# Spec Delta

## MODIFIED Requirements

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
