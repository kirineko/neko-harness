# Spec Delta

## MODIFIED Requirements

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
