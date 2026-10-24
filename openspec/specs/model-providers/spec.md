# model-providers Specification

## Purpose

管理模型提供商接入：DeepSeek 为默认 provider，统一处理认证、模型目录与 thinking level 映射。

## Requirements

### Requirement: DeepSeek 接入

系统 SHALL 内置 DeepSeek provider，使用 OpenAI Chat Completions 格式（api.deepseek.com），按 Pi 认证约定优先读取保存的凭据并回退 DEEPSEEK_API_KEY，支持 deepseek 系列模型的 thinking、tool use 与流式输出。缺少凭据 MUST NOT 阻止网关与前端启动。

#### Scenario: 未配置密钥

- **WHEN** 未保存密钥且 DEEPSEEK_API_KEY 未设置时启动
- **THEN** 用户可浏览会话和配置密钥；提交 DeepSeek 输入前收到配置引导，不接受该输入为新消息、不更新时间且不发起模型请求

#### Scenario: thinking 级别映射

- **WHEN** 会话配置 thinking level 为 high
- **THEN** 发往 DeepSeek 的请求携带该 provider 方言对应的 thinking 参数，且回答中的推理内容与正文分离呈现

### Requirement: 模型目录与切换

系统 SHALL 提供可用模型列表（含上下文窗口、价格、支持的能力及思考强度），并允许按会话切换模型与 thinking level。列表 SHALL 仅包含已启用 provider 的模型，并标明各模型所属 provider 是否已具备凭据；切换 MUST 仅允许切到已启用 provider 的模型。能力列表及不支持强度的调整 MUST 遵循已安装 Pi 1.4.0 的约定，TUI/Web MUST 使用同一能力数据，不能根据外部目录扩展选项或覆盖上游映射。模型引用 SHALL 以 provider 与模型 id 共同标识，模型 id 可含 `/`（如 OpenRouter）。切换模型后，系统 MUST 沿用 Pi 的历史转换，不把先前模型的思考内容作为新模型的可见回答文本发送，也不改写持久历史。

#### Scenario: 会话级切换模型

- **WHEN** 用户在某会话中切换模型
- **THEN** 该会话的下一次请求使用新模型，其他会话不受影响

#### Scenario: 已锁定 Pi 的能力

- **WHEN** 使用 Pi 1.4.0 内置 DeepSeek 模型目录
- **THEN** Flash 可选 off/low/high/max，Pro 可选 off/high/max；两端不提供 minimal/medium/xhigh

#### Scenario: 切换到不支持当前强度的模型

- **WHEN** Flash low 切换为 Pro
- **THEN** 遵循 Pi 将强度调整为 high，两端显示相同实际生效值，不将 low 透传为 Pro 的有效选项

#### Scenario: 切换模型后的历史

- **WHEN** 会话中已有他模型产生思考内容的回答，用户切换到另一模型后继续提问
- **THEN** 新请求不把旧思考内容当作回答文本发送，持久历史与两端展示的旧思考内容保持不变

#### Scenario: 列表范围

- **WHEN** 仅启用 DeepSeek 与 OpenRouter 时读取模型列表
- **THEN** 只含这两个 provider 的模型，且每项标明所属 provider 是否已有凭据；其他目录 provider 的模型不出现

#### Scenario: 切到未启用 provider

- **WHEN** 客户端提交把会话模型切换到未启用 provider 模型的请求
- **THEN** 请求被拒绝并说明需先启用该 provider，会话配置保持不变

#### Scenario: 含斜杠的模型 id

- **WHEN** 用户选择 `openrouter/anthropic/claude-haiku-4.5`
- **THEN** provider 解析为 openrouter、模型 id 为 `anthropic/claude-haiku-4.5`，两端展示一致且不同厂商的同名短名可区分

### Requirement: 用户级凭据管理

系统 SHALL 将 UI 保存的凭据按 provider 分别持久保存于宿主用户级独立存储，所有工作区共用，重启后保留，不同 provider 的凭据互不影响。适用范围为目录内的模型 provider 与 Tavily。同一 provider 的保存凭据 SHALL 优先于环境变量；移除后 SHALL 回退环境变量。保存和移除 MUST 不修改进程环境变量；后续请求使用最新凭据，已发出的请求不被强制中断。

#### Scenario: 保存与回退

- **WHEN** 环境变量已有 Key，用户保存另一个 Key 后重启，再移除保存值
- **THEN** 重启后先使用保存值，移除后使用环境变量；环境变量配置状态始终为已配置

#### Scenario: 空值与存储失败

- **WHEN** 用户提交空白 Key，或凭据文件写入失败
- **THEN** 拒绝操作并显示不含密钥的错误，保留原生效凭据；空值不视为删除

#### Scenario: 多 provider 互不影响

- **WHEN** 用户保存或移除某一 provider（如 OpenRouter 或 Tavily）的 Key
- **THEN** 其他 provider（如 DeepSeek）的保存凭据与生效来源保持不变

#### Scenario: 共用环境变量的 provider

- **WHEN** 仅设置 `OPENCODE_API_KEY`
- **THEN** OpenCode Go 与 OpenCode Zen 的环境变量状态均显示已配置，但两者的保存凭据彼此独立

### Requirement: 凭据保密与状态

系统 MUST 仅向前端返回各 provider 的保存状态、环境变量是否配置、当前生效来源及启用状态，不返回已有密钥。凭据文件 SHALL 仅宿主用户可读写；密钥 MUST NOT 写入会话、日志、项目配置或浏览器持久存储。"已配置" SHALL 仅表示存在凭据，不声称已通过远端认证。

#### Scenario: 查看与编辑

- **WHEN** 任一前端打开配置界面
- **THEN** 只读取无敏感内容的各 provider 状态，环境变量状态来自网关进程；输入框为空，可输入替换值，保存或取消后清除输入

### Requirement: 默认模型与思考强度

系统 SHALL 按「会话级显式指定 > CLI `--model` > 用户保存的默认模型 > 配置文件 `defaultModel` > 内置默认」为新会话解析模型，内置默认为 DeepSeek V4.1 Flash（deepseek-flash），强度按所解析模型以 high 为默认换算。用户保存的默认模型 SHALL 按用户持久保存、所有工作区共用、重启后保留，可清除；清除后 SHALL 回落到配置文件或内置默认。已有会话和显式配置 MUST 保留自身设置；自动标题总结 MUST 继续使用独立非思考请求。

#### Scenario: 默认与显式配置

- **WHEN** 用户从任一前端新建无显式模型/强度覆盖、无保存默认模型的会话
- **THEN** 默认值为 Flash high；恢复已有会话不重置其配置，显式指定 off 时保持 off

#### Scenario: 保存值生效与清除

- **WHEN** 用户把某可选模型设为默认后新建会话，随后清除该保存值再新建会话
- **THEN** 前者使用保存的模型并按其能力换算默认强度；后者回落为配置文件 `defaultModel`，无则内置 Flash

#### Scenario: 解析优先级

- **WHEN** CLI `--model`、保存的默认模型与配置文件 `defaultModel` 同时存在
- **THEN** 新会话使用 `--model`；无 `--model` 时使用保存值；两者都无时使用配置文件值

#### Scenario: 保存值的 provider 被取消启用

- **WHEN** 保存的默认模型所属 provider 随后被取消启用，用户新建会话并提交输入
- **THEN** 新会话仍取保存的模型，不静默改用其他模型；提交按 `PROVIDER_DISABLED` 拒绝并提示启用或更换默认

### Requirement: 模型图片能力一致性

系统 SHALL 向两端提供已安装 Pi 1.4.0 的输入类型和图片限制，不使用外部目录覆盖。新图片消息 MUST 在受理时验证实际会话模型支持图片；不支持时保留草稿和附件并提示切换模型或移除图片。历史图片及 read 工具图片结果在模型请求中的转换 SHALL 沿用 Pi，不修改持久历史或伪称非视觉模型能看见原图；工具读取不采用附件提交的能力拒绝策略。

#### Scenario: Flash 与 Pro

- **WHEN** Pi 1.4.0 下用户选择 DeepSeek V4.1 Flash 或 V4 Pro
- **THEN** 两端分别显示 Flash 支持图片、Pro 仅文本，并使用 Flash 声明的图片限制

#### Scenario: 添加后切换模型

- **WHEN** 草稿已有图片时模型切换为 Pro，或另一客户端在提交前更改模型
- **THEN** 不静默移除图片，服务端以受理时能力拒绝无效新输入，前端保留草稿并展示处理选项

#### Scenario: 历史含图但新输入为文字

- **WHEN** 含图片历史的会话切换到 Pro 后发送纯文字
- **THEN** 允许对话，历史原图可查看，模型请求按 Pi 降级图片内容；界面明确当前模型无法查看原图

#### Scenario: 非视觉工具读取

- **WHEN** Pro 通过 read 读取有效的受支持图片
- **THEN** 遵循原生工具保存图片结果并向模型提供占位符和能力诊断，不能把结果展示为模型已看见图片；同一会话的新图片附件提交仍被拒绝

### Requirement: 内置 provider 目录

系统 SHALL 内置一个封闭的模型 provider 目录，仅包含已安装 Pi 1.4.0 中使用纯 API Key 鉴权且无需额外配置的 provider；不属于目录的 provider MUST NOT 可被启用、配置或选用。目录成员由 Pi 的内置 provider 决定，不引入外部模型目录。

#### Scenario: 目录成员

- **WHEN** 用户在任一前端查看模型服务
- **THEN** 可见 DeepSeek、OpenRouter、OpenCode Go、OpenCode Zen、OpenAI、Google、Groq、Mistral、xAI、Together、Fireworks、Cerebras、NVIDIA、Hugging Face、Vercel AI Gateway、Moonshot AI（含 CN）、MiniMax（含 CN）、ZAI（含 Coding CN）、Qwen Token Plan（三个）、Xiaomi MiMo（四个）、Baseten、Ant Ling、Kimi For Coding、Meta 共 32 个 provider，且每项展示名称、环境变量名与 Key 申请链接

#### Scenario: 目录之外的 provider

- **WHEN** 配置文件或 `--model` 指向 Azure、Anthropic、Bedrock、GitHub Copilot 等目录之外的 provider
- **THEN** 该 provider 不出现在模型服务页与模型列表中，其模型被视为未知模型，不能被启用或用于请求

### Requirement: provider 启用设置

系统 SHALL 提供用户级 provider 启用设置：默认仅启用 DeepSeek，且 DeepSeek 始终启用、不可取消；其余 provider 由用户勾选启用。启用 SHALL 持久保存、所有工作区与会话共用，重启后保留。启用只决定 provider 的模型是否可见可选，不要求已有 Key，也 MUST NOT 创建、修改或删除凭据；取消启用 MUST NOT 删除已保存的 Key。

#### Scenario: 默认状态

- **WHEN** 新用户首次打开模型服务设置
- **THEN** 仅 DeepSeek 为已启用且不可取消，其余 provider 均未启用；模型列表只含 DeepSeek 模型

#### Scenario: 启用与取消

- **WHEN** 用户启用 OpenRouter 后重启，再取消启用
- **THEN** 重启后 OpenRouter 仍为已启用；取消后其模型从列表中消失，已保存的 OpenRouter Key 保持不变

#### Scenario: 锁定 DeepSeek

- **WHEN** 任一前端或客户端提交取消 DeepSeek 启用的请求
- **THEN** 请求被拒绝并返回说明，DeepSeek 保持启用

#### Scenario: 启用与 Key 互相独立

- **WHEN** 用户启用某 provider 但尚未保存其 Key，或保存了 Key 但未启用
- **THEN** 前者的模型在选择器中可见但标明未配置 Key 且不可选；后者的模型不出现在列表中

### Requirement: 通用缺 Key 与禁用拦截

对任一目录内 provider，系统 SHALL 在受理新输入与手动压缩前校验该会话当前模型的 provider：缺少凭据时 MUST 以 `PROVIDER_KEY_REQUIRED` 拒绝并指引到配置入口；provider 未启用时 MUST 以 `PROVIDER_DISABLED` 拒绝并指引启用或切换模型。被拒绝的输入 MUST NOT 被接受为新消息、不更新时间且不发起模型请求。校验同样适用于子 agent 的请求，自动标题总结在 provider 不可用时 SHALL 回退而不发起请求。已有会话的历史 MUST 仍可浏览与导出。

#### Scenario: 缺 Key

- **WHEN** 会话使用已启用但未配置 Key 的 OpenRouter 模型，用户提交输入
- **THEN** 以 `PROVIDER_KEY_REQUIRED` 拒绝，前端引导到该 provider 的配置入口，草稿保留

#### Scenario: provider 被取消启用

- **WHEN** 会话使用 OpenRouter 模型，随后用户取消启用 OpenRouter，再次提交输入
- **THEN** 以 `PROVIDER_DISABLED` 拒绝并提示重新启用或切换模型；会话历史与已有内容保持可见

#### Scenario: 指定未启用 provider 启动

- **WHEN** `--model` 或配置文件 `defaultModel` 指向未启用的 provider
- **THEN** 网关与前端正常启动并可浏览会话；提交新输入时按 `PROVIDER_DISABLED` 拒绝，不静默改用其他模型

#### Scenario: DeepSeek 行为保持

- **WHEN** 未配置 DeepSeek Key 时提交 DeepSeek 会话输入
- **THEN** 行为与既有一致，被拒绝并指引到配置入口，不阻止网关与前端启动

### Requirement: 凭据写入健壮性

保存或移除凭据 SHALL 能从中断与短暂占用中恢复。上一次写入的进程中途终止而留下的写入锁，SHALL 在超过固定的过期时限（远大于一次正常写入的耗时）后被视为失效并回收，此后的保存 MUST 正常进行，不得永久报告存储忙。替换凭据文件时遇到其他进程短暂占用（如 Windows 上的杀毒或索引程序）SHALL 有界重试；重试耗尽仍失败时 MUST 返回明确错误，原凭据文件内容 MUST 保持完整，不留下临时文件。

#### Scenario: 崩溃残留的锁

- **WHEN** 凭据写入锁由已终止的进程留下且已超过过期时限，用户随后保存一个 Key
- **THEN** 保存成功，锁被回收

#### Scenario: 正在进行的写入

- **WHEN** 另一进程持有未过期的写入锁
- **THEN** 本次保存等待其释放后完成，或在等待上限后返回存储忙错误，不回收该锁

#### Scenario: 短暂占用

- **WHEN** 替换凭据文件时目标被其他进程短暂占用，随后释放
- **THEN** 保存在重试后成功

#### Scenario: 持续占用

- **WHEN** 目标在全部重试期间都被占用
- **THEN** 返回明确错误，原有凭据保持不变，没有残留临时文件
