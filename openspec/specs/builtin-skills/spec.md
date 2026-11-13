# builtin-skills Specification

## Purpose

随 neko 包分发的内置技能集：提供技能生态的自举能力（创建技能、发现技能），作为技能发现的最低优先级来源，只读且可被用户级/项目级同名技能覆盖。

## Requirements

### Requirement: 内置技能目录发现

系统 SHALL 扫描随包分发的内置技能目录作为第三级技能来源，其布局与用户级/项目级一致（`<内置目录>/<name>/SKILL.md`），解析规则与失败语义与其他级相同。内置目录缺失或不可读时 MUST 静默视为空集，不告警、不影响其他级。源码运行与构建产物运行 MUST 解析到同一内置目录。

#### Scenario: 内置技能被发现

- **WHEN** 包内内置目录含 `skill-creator/SKILL.md`
- **THEN** 技能列表包含 skill-creator，其来源级别为内置级

#### Scenario: 内置目录缺失

- **WHEN** 内置目录不存在
- **THEN** 技能发现正常返回用户级与项目级结果，不产生告警

#### Scenario: 两种运行形态一致

- **WHEN** 分别以 Node 源码模式与 tsc 构建产物启动
- **THEN** 两种形态发现的内置技能集合相同

### Requirement: 内置技能清单

系统 SHALL 内置 `skill-creator` 与 `skill-finder` 两个技能。skill-creator SHALL 指导创建、评估与迭代 SKILL.md 技能，MUST NOT 包含特定第三方平台的专属操作指引。skill-finder SHALL 在用户表达"是否有某能力的技能"类需求时，引导发现 neko 技能市场中的候选并指引用户通过市场界面安装；skill-finder MUST NOT 让模型代替用户执行安装。内置技能名称 MUST NOT 与技能市场已上架技能同名，以保证用户可共存安装市场版本。

#### Scenario: 创建技能引导

- **WHEN** 用户要求创建一个新技能
- **THEN** skill-creator 的描述能匹配该意图，模型可按其指引产出 SKILL.md

#### Scenario: 发现技能引导

- **WHEN** 用户询问"有没有处理 X 的技能"
- **THEN** skill-finder 指引模型检索市场候选并建议用户在市场界面安装，模型不自行安装

#### Scenario: 与市场版共存

- **WHEN** 用户从市场安装名为 find-skills 的技能
- **THEN** 该安装不与任何内置技能同名冲突，两个技能同时可用

### Requirement: 内置技能只读与可覆盖

内置技能 MUST 随包只读分发，系统 MUST NOT 提供修改或卸载内置技能的入口。同名技能按发现优先级由用户级或项目级版本覆盖内置版本，覆盖不改变内置文件本身。

#### Scenario: 用户级覆盖内置

- **WHEN** 用户级目录存在与内置技能同名但内容不同的技能
- **THEN** 提示词与显式调用使用用户级版本，内置文件保持原样

#### Scenario: 卸载入口拒绝内置

- **WHEN** 前端请求卸载一个仅内置级存在的技能
- **THEN** 该操作被拒绝，内置文件不受影响
