# neko-harness

在终端或浏览器中使用的本地 AI 编程助手。支持文件读写、命令执行、图片输入、网页搜索、技能调用与子 agent，会话自动保存。

## 安装

支持 Windows、macOS 和 Linux，需要 **Bun 1.4.2 或更新的 1.4.x 版本**。按 [Bun 安装说明](https://bun.sh/docs/installation)装好后运行：

```bash
bun add --global neko-harness
```

找不到 `neko` 命令时，请将 Bun 的 bin 目录加入 `PATH`（`~/.bun/bin`，Windows 为 `%USERPROFILE%\.bun\bin`）。

Windows 还需要安装 [Git for Windows](https://git-scm.com/download/win)，助手执行命令（bash 工具与后台任务）依赖它提供的 Git Bash。neko 会自动查找，也可以在 `neko.config.json`（向上查找，兜底 `~/.neko/config.json`）里指定：

```json
{ "shell": { "path": "C:\\Program Files\\Git\\bin\\bash.exe" } }
```

不支持 WSL 的 `bash.exe`（`C:\Windows\System32\bash.exe`）：配置指向它会被拒绝。没有 Git Bash 时 neko 仍可启动，TUI 与 Web 会提示，bash 与后台任务返回明确错误，其余功能不受影响。

## 开始使用

进入项目目录启动界面，两种界面可以同时使用，无需额外启动服务：

```bash
cd /path/to/your/project
neko tui   # 终端界面
neko web   # 浏览器界面，自动打开
```

首次使用在 TUI 输入 `/login`，或打开 Web「设置 → 模型服务」，填入 [DeepSeek API Key](https://platform.deepseek.com/api_keys)。默认使用 DeepSeek V4.1 Flash，可在界面中切换模型。也可用环境变量提供：

```bash
export DEEPSEEK_API_KEY='你的 API Key'
```

界面保存的 Key 优先于环境变量，仅保存在本机，请勿分享。

默认只启用 DeepSeek。如需使用其他模型服务（OpenRouter、OpenCode Go / Zen、OpenAI、Google、Groq、Mistral、xAI、Together 等 32 个纯 API Key 服务），在 TUI `/login`（空格勾选）或 Web「设置 → 模型服务」中启用并配置 Key，也可用对应环境变量（如 `OPENROUTER_API_KEY`、`OPENCODE_API_KEY`，各服务的变量名显示在配置页中）。启用后模型会出现在 `/model` 与输入框的模型选择器里；取消启用不会删除已保存的 Key，但使用该服务的会话将无法发送新消息，直到重新启用或切换模型。`--model` 的格式为 `provider/modelId`，例如 `openrouter/anthropic/claude-haiku-4.5`。

新会话的默认模型可在模型选择器中「设为默认」（Web 选择器行内操作、TUI `/model` 列表按 `d`，再操作一次取消），设置按用户保存、重启保留。优先级：`--model` > 保存的默认模型 > 配置文件 `defaultModel` > 内置 DeepSeek Flash。只影响之后新建的会话。

## 日常操作

- **工作区**：默认使用启动目录。Web 侧栏可添加、切换项目，浏览文件、查看本次由助手产生的改动，并可在本机用 VS Code 或文件管理器打开。
- **会话**：TUI 用 `/new` 新建、`/sessions` 切换；Web 使用侧栏。
- **模型与思考强度**：TUI 用 `/model`（按服务分组、可输入过滤）和 `/think`；Web 点击输入框中的模型入口（按服务分组、可搜索）。
- **文件与图片**：输入 `@` 引用文件或目录；TUI 用 `Ctrl+V` 粘贴图片（Windows 与 WSL 为 `Alt+V`，避免与终端自带粘贴冲突）；Web 支持粘贴、拖放和选择。识图能力取决于所选模型。
- **上下文**：`/compact` 整理较长对话。默认沿用 pi-durable 的自动压缩策略（接近模型窗口上限才触发），可在 TUI `/context`、Web 设置页「上下文」或配置文件 `context.compaction` 调整触发百分比、保留量与开关，保存值优先。
- **工具结果裁剪**（默认关闭）：配置 `context.pruning`，上下文占用过高时把较旧的工具结果在模型上下文中替换为占位，界面与导出仍显示原始结果，模型需要时会重新执行工具。阈值与保留量可在 `/context` 与设置页修改。
- **复制与导出**：Web 在消息下方复制回答（不含思考过程），顶栏「导出」可选 Markdown、HTML、JSON 及是否包含思考过程；TUI 用 `/copy` 与 `/export [path] [--thinking]`，省略路径时写入工作区目录，不覆盖已有文件。
- **技能**：输入 `/skill:` 选择；Web 可从侧栏进入技能市场，浏览和安装技能。
- **子 agent**：助手会按任务需要委派探索、规划或编码工作，并等待结果后整合。Web 点委派卡片或侧栏、TUI 用 `/agents` 查看过程；可单独停止当前任务，保留后续接续能力。探索子 agent 的 Bash 命令需逐次批准。
- **后台任务**：`npm run dev`、`uv run` 等长命令可由 `job` 工具转入后台（同时最多 4 个），结束时助手会收到回报并继续处理。Web 顶栏「任务」、TUI `/jobs` 查看实时输出或手动停止。重启后运行中的任务标记为已丢失，不会自动重跑。
- **待办列表**：多步骤任务中，助手用 `todo` 工具维护一份有序待办，用户只读。Web 顶栏「待办 n/m」、TUI `/todos`、手机聊天页进度入口查看。列表随会话保存，重启与压缩后仍在，子 agent 不能使用。
- **向你提问**：缺少必要决策时，助手用 `ask_user` 提问：可单选或多选（带「推荐」提示但不预选），可附加文字，也可只回文字或跳过。Web 在输入区上方、TUI 按 `Ctrl+O` 或 `/question`、手机在聊天页回答；选择需点「提交回答」（TUI 按 Enter）才生效。等待期间助手暂停，期间发送的消息仍排队到回答之后；问题与选项按纯文本显示。
- **网页搜索**：默认使用 Tavily（无 Key 时为有限流的 keyless 模式，可在 Web「设置 → 联网搜索」或 TUI `/login` 中配置自己的 Key），也可改用 DeepSeek 搜索与抓取，复用你的 DeepSeek Key：TUI 用 `/search`、Web 在设置页「联网搜索」选择，或用配置 `webSearch.provider` 设置初始值。DeepSeek 搜索按成功请求计费（5 元 / 千次）。
- **手机配对**：Web 设置页「手机配对」开启后用 App 扫码连接。手机需与电脑同一网络，系统防火墙放行所选端口；撤销设备、重新生成证书也在设置页完成。gateway 由 `neko web` 启动时，退出页面会同时停止手机入口，需要长期连接请改用 `neko serve` 或保持 TUI 运行。WSL 默认 NAT 网络下会自动经 `powershell.exe` 转发，无需 portproxy。

助手可以执行命令和修改文件，请在可信项目中使用；工作区目录不限制助手的文件访问范围。

## 常用设置

```bash
neko tui --cwd /path/to/project  # 指定项目目录，Web 也支持
neko tui --theme dark            # 使用深色终端主题
neko web --port 8333             # 更换网页端口
neko web --no-open               # 启动后不自动打开浏览器
```

更多选项见 `neko tui --help` 和 `neko web --help`。

会话与设置保存在 `~/.neko/`，退出不会删除。备份前请先退出所有 neko 界面及服务；备份可能包含 API Key，请妥善保管。

## 升级

先完成任务，退出正在运行的 neko 界面及服务，然后执行 `neko update`，完成后重新启动。

Windows 上的 `neko update` 会显示手动升级指引：先退出 neko，再运行 `bun add --global neko-harness@latest`。

TUI 输入 `/version`，或打开 Web「设置 → 关于与更新」，可查看版本、检查更新，并按提示重启或刷新。若当前版本没有 `neko update` 命令，可重新运行 `bun add --global neko-harness`。

## 许可证

[MIT](LICENSE)。基于 [Pi](https://github.com/earendil-works/pi) 生态构建。
