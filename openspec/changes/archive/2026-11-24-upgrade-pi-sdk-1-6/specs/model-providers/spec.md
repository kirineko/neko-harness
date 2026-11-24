# Spec Delta

## MODIFIED Requirements

### Requirement: 用户级凭据管理

系统 SHALL 将 UI 保存的凭据按 provider 分别持久保存于宿主用户级独立存储，所有工作区共用，重启后保留，不同 provider 的凭据互不影响。适用范围为目录内的模型 provider 与 Tavily。同一 provider 的保存凭据 SHALL 优先于环境变量；移除后 SHALL 回退环境变量（含上游定义的兼容回退环境变量，环境变量配置状态与请求鉴权保持一致）。保存和移除 MUST 不修改进程环境变量；后续请求使用最新凭据，已发出的请求不被强制中断。

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

#### Scenario: 兼容回退环境变量

- **WHEN** 某 provider 同时具有专属首选环境变量与上游兼容回退环境变量，且宿主仅设置了兼容回退环境变量
- **THEN** 该 provider 的环境变量状态显示为已配置且可用于模型请求；保存独立凭据后优先使用保存值，移除保存值后继续回退到该兼容环境变量

### Requirement: 内置 provider 目录

系统 SHALL 内置一个封闭的模型 provider 目录，仅包含已安装 Pi 1.6.0 中使用纯 API Key 鉴权且无需额外配置的 provider；不属于目录的 provider MUST NOT 可被启用、配置或选用。目录成员由 Pi 的内置 provider 决定，不引入外部模型目录。

#### Scenario: 目录成员

- **WHEN** 用户在任一前端查看模型服务
- **THEN** 可见 DeepSeek、OpenRouter、OpenCode Go、OpenCode Zen、OpenAI、Google、Groq、Mistral、xAI、Together、Fireworks、Cerebras、NVIDIA、Hugging Face、Vercel AI Gateway、Moonshot AI（含 CN）、MiniMax（含 CN）、ZAI（含 Coding CN）、Qwen Token Plan（四个）、Xiaomi MiMo（四个）、Baseten、Ant Ling、Kimi For Coding、Meta 共 33 个 provider，且每项展示名称、环境变量名与 Key 申请链接

#### Scenario: 目录之外的 provider

- **WHEN** 配置文件或 `--model` 指向 Azure、Anthropic、Bedrock、GitHub Copilot 等目录之外的 provider
- **THEN** 该 provider 不出现在模型服务页与模型列表中，其模型被视为未知模型，不能被启用或用于请求
