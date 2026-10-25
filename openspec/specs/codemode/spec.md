# codemode Specification

## Purpose
让模型编写在沙箱中运行的 JavaScript 脚本，在脚本里批量、链式地调用会话工具，只把脚本输出交回模型上下文；并规定该模式的开关、可见范围、保护规则与恢复语义。

## Requirements

### Requirement: codemode 模式取值与全局设置

系统 SHALL 提供三种 codemode 模式：`off`、`on`、`only`。全局设置 SHALL 按「UI 保存值 > 配置文件 `codemode.mode` > 内置默认 `off`」解析，并报告生效值与来源（默认、配置文件、已保存）。配置文件中的未知取值 MUST 使配置加载失败并指出字段；UI 提交的未知取值 MUST 被拒绝，且不改变已保存状态。清除保存值 SHALL 回落到配置文件值，未配置时回落到 `off`。

#### Scenario: 未做任何设置
- **WHEN** 配置文件没有 `codemode` 块，UI 也从未保存过
- **THEN** 生效模式为 `off`，来源为默认

#### Scenario: 保存值覆盖配置
- **WHEN** 配置文件设为 `on`，用户在 UI 中保存 `only`
- **THEN** 生效模式为 `only`，来源为已保存；清除保存值后回到 `on`，来源为配置文件

#### Scenario: 非法取值
- **WHEN** 配置文件写成 `"codemode": { "mode": "auto" }`
- **THEN** 配置加载失败，错误指出 `codemode.mode` 只接受 off、on、only

### Requirement: 模式只在新建会话时确定

每个会话 SHALL 在创建时记录当时生效的全局模式，并 MUST 持久保存；之后修改全局设置 MUST NOT 改变已有会话的模式，重启后模式不变。分叉 SHALL 继承源会话的模式。没有模式记录的已有会话 SHALL 视为 `off`。子 agent SHALL 在创建时继承主会话记录的模式，接续时沿用。

#### Scenario: 修改设置不影响已有会话
- **WHEN** 会话 A 在模式为 `off` 时创建，随后全局设置改为 `on`，再创建会话 B
- **THEN** A 仍没有 `codemode` 工具，B 有；重启网关后两者保持不变

#### Scenario: 子 agent 继承
- **WHEN** 模式为 `only` 的主会话派发一个 coder 子 agent
- **THEN** 子 agent 同样处于 `only` 模式，模型只看到 `codemode`

#### Scenario: 升级前的会话
- **WHEN** 升级后打开升级前创建的会话
- **THEN** 该会话按 `off` 运行，工具集与升级前一致

### Requirement: 模型可见工具与脚本可调用工具

`off` 模式 SHALL 不提供 `codemode` 工具，也不加入 `codemode` 提示词段，工具集与本变更之前一致。`on` 模式 SHALL 在原有工具之外提供 `codemode`。`only` 模式 SHALL 只向模型提供 `codemode` 和只限主 agent 的工具（`todo`、`ask_user`、`subagent`，plan 模式下再加 `submit_plan`），其余已启用工具只能在脚本中调用。脚本 SHALL 能调用会话已启用、且允许被其他工具调用的工具，MUST NOT 调用 `codemode` 自身、`todo`、`ask_user`、`submit_plan` 与 `subagent`。

#### Scenario: only 模式直接调用被拒
- **WHEN** `only` 模式下模型直接发出 `bash` 工具调用
- **THEN** 该调用因工具不可用失败，脚本中的 `tools.bash` 照常可用

#### Scenario: 脚本不能派发子 agent 或提问
- **WHEN** 脚本执行 `await tools.subagent({...})` 或 `await tools.ask_user({...})`
- **THEN** 调用以错误拒绝，不创建子 agent，也不产生待回答问题

#### Scenario: 脚本中批量调用
- **WHEN** `on` 模式下模型提交脚本，用 `Promise.all` 并行读取三个文件并只输出各自的行数
- **THEN** 三次 read 各自作为嵌套调用执行，模型上下文只收到脚本输出，不包含文件正文

### Requirement: 与 plan 模式的组合

会话的实际工具集 SHALL 由 plan 模式与 codemode 模式两条持久记录共同确定，MUST NOT 因其中一方的进入或退出而丢失另一方的效果。启动对账与每次受理输入前 SHALL 按两条记录检查，不一致时重新应用。plan 模式移除的工具在脚本中同样不可调用；脚本里的 `bash` MUST 同样经过只读命令判定。

#### Scenario: only 模式下进出 plan 模式
- **WHEN** `only` 模式的会话进入 plan 模式后又退出
- **THEN** plan 期间模型看到 `codemode`、`todo`、`ask_user`、`submit_plan`；退出后回到 `codemode`、`todo`、`ask_user`，仍是 `only` 模式

#### Scenario: plan 模式下脚本写文件
- **WHEN** plan 模式下脚本调用 `tools.edit(...)` 或 `tools.bash({ command: "rm -rf build" })`
- **THEN** 两次调用都在执行前被拒绝，脚本收到错误，文件不变

#### Scenario: 中断后自愈
- **WHEN** 退出 plan 模式的记录已经写入、工具配置尚未应用时进程崩溃
- **THEN** 重启对账按两条记录恢复正确的工具集

### Requirement: 嵌套调用的保护与计量

脚本发起的每个工具调用 SHALL 作为该工具的独立调用执行：参数校验、工具钩子（包括 explore 子 agent 的 bash 逐次审批）与输出上限都与模型直接调用相同。被拒绝或审批未通过的调用 SHALL 在脚本中表现为可捕获的错误。嵌套调用的用量 SHALL 计入各自的工具，不重复计入 `codemode`。脚本 MUST NOT 获得调用模型（分类器、图片生成）的能力。

#### Scenario: explore 子 agent 的脚本执行命令
- **WHEN** `on` 模式下 explore 子 agent 在脚本中调用 `tools.bash`
- **THEN** 该命令进入待审批，用户拒绝后脚本收到错误，命令未执行

#### Scenario: 没有 models 全局
- **WHEN** 脚本引用 `models.classify`
- **THEN** 脚本因该全局不存在而失败，没有产生任何模型请求

### Requirement: 脚本运行环境与资源上限

脚本 SHALL 在隔离沙箱中运行：除注入的工具与全局函数（输出、跨调用存储、工具查找）外，没有文件系统、网络、进程与定时器能力。单个脚本的内存 SHALL 有上限（256 MiB）。全进程同时运行的沙箱数 SHALL 有上限（默认 2）；超出时新脚本 SHALL 有界排队等待，等待超时（60 秒）、停止会话或中止回答时 SHALL 以错误结束，不影响其他会话。脚本输出 SHALL 按 token 预算截断，并把完整输出写入临时文件、在结果中给出路径。

#### Scenario: 并发上限
- **WHEN** 已有 2 个脚本在运行，第 3 个会话提交脚本
- **THEN** 第 3 个脚本等待，前一个结束后开始运行；等待超过 60 秒则以「沙箱繁忙」错误结束

#### Scenario: 停止回答
- **WHEN** 脚本运行中用户停止该会话
- **THEN** 脚本与其未完成的嵌套调用被中止，结果标记为已中止

#### Scenario: 超长输出
- **WHEN** 脚本输出超过默认 token 预算
- **THEN** 模型收到保留首尾的截断文本和完整输出文件的路径

### Requirement: 重启后的脚本恢复

进程在脚本运行中退出后，系统 SHALL 在重启时恢复该脚本：已完成的嵌套调用 MUST NOT 再次执行，脚本拿到与之前相同的结果后继续运行。脚本走了与之前不同的路径、沙箱版本变化或已超过脚本声明的期限时，该调用 SHALL 以说明原因的错误结束，且不再发起新的嵌套调用。跨调用存储 SHALL 按会话保存，分叉时取分叉点的值。

#### Scenario: 运行中重启
- **WHEN** 脚本已完成 5 次 read、第 6 次运行中时网关被强制结束，随后重启
- **THEN** 前 5 次 read 不重新执行，脚本继续并完成，模型收到一次完整结果

#### Scenario: 脚本声明的期限已过
- **WHEN** 脚本首行声明 `timeout_ms` 为 60000，网关停机超过该时长后重启
- **THEN** 该调用以「期限已过」错误结束，不发起新的嵌套调用
