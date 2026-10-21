# ui-language Specification

## Purpose
定义 Web、TUI、移动端的界面语言：可选语言与默认值、各端的保存与优先级、保护词与数据不翻译的边界、core 下发文案的前端映射，以及字典完整性与防回退守护，使用户可在中文与英文之间切换而不破坏命令、协议与对话数据。

## Requirements

### Requirement: 界面语言取值与默认

Web、TUI 与移动端 SHALL 各自支持界面语言 `zh`（中文，默认）与 `en`（英文）。MUST NOT 提供「跟随系统」；偏好缺失、损坏或取值非法时 MUST 回退 `zh`，且不抛错、不阻止启动。语言偏好 MUST 仅作用于本端界面文案，不改变会话数据，也不影响其他前端。

#### Scenario: 全新安装默认中文

- **WHEN** 用户首次打开 Web、启动 TUI 或打开移动端，且从未设置语言
- **THEN** 三端界面均为中文

#### Scenario: 非法值回退

- **WHEN** 保存的偏好或环境变量不是 `zh` 或 `en`
- **THEN** 该值被忽略并回退 `zh`；非法的 `--lang` 参数使 TUI 以明确的参数错误退出

#### Scenario: 互不影响

- **WHEN** 用户把 Web 设为英文
- **THEN** 同一网关上的 TUI 与移动端语言不变，会话内容与服务端数据不变

### Requirement: Web 语言偏好

Web SHALL 把语言偏好保存在浏览器 localStorage，首屏渲染前应用并同步 `<html lang>`（`zh` 对应 `zh-CN`，`en` 对应 `en`），切换后全站文案即时更新而无需刷新，多个标签页 SHALL 同步。Web SHALL 在设置中提供「语言 / Language」入口，入口标题 MUST 固定为中英双语，选项 MUST 以各自语言书写（「中文」「English」）。

#### Scenario: 切换语言

- **WHEN** 用户在语言页选择 English
- **THEN** 全站界面文案立即为英文，`<html lang>` 为 `en`，刷新后保持

#### Scenario: 多标签页同步

- **WHEN** 同一浏览器两个标签页打开，其中一个切换语言
- **THEN** 另一个标签页无需刷新即更新为同一语言

#### Scenario: 在错误语言下找到入口

- **WHEN** 界面为用户不熟悉的语言
- **THEN** 设置菜单中的语言入口与其选项仍可辨认

### Requirement: TUI 语言偏好

TUI SHALL 按 `--lang`、环境变量 `NEKO_LANG`、保存值、默认 `zh` 的优先级决定语言。保存值位于数据目录下的 `tui.json`（`{ "language": "zh" | "en" }`）。`--lang` 与 `NEKO_LANG` MUST 仅影响当次进程；`/language` SHALL 打开选择面板，选定即时生效并写入保存值。保存值读取失败或损坏时 MUST 回退 `zh` 且不影响启动；写入失败 SHALL 以通知提示且本次进程内仍生效。

#### Scenario: 记住上次选择

- **WHEN** 用户在 TUI 用 `/language` 选择 English 后退出，再次不带参数启动
- **THEN** TUI 以英文启动

#### Scenario: 参数不覆盖保存值

- **WHEN** 保存值为 `en`，用户以 `neko tui --lang zh` 启动并退出，再次不带参数启动
- **THEN** 第一次为中文，第二次仍为英文

#### Scenario: 保存文件损坏

- **WHEN** `tui.json` 不是合法 JSON 或语言字段非法
- **THEN** TUI 以中文正常启动，不报错退出

#### Scenario: 即时切换

- **WHEN** 用户在运行中的 TUI 执行 `/language` 并选择另一语言
- **THEN** 命令说明、状态栏、面板、快捷键提示与帮助立即使用新语言，输入草稿、排队项与会话内容保持不变

### Requirement: 移动端语言偏好

移动端 SHALL 把语言偏好保存在本地偏好存储，启动时恢复，切换后界面即时更新而无需重启。语言选择 SHALL 位于与主题选择相同的两处入口（会话抽屉与电脑列表页），连接电脑之前也可切换。系统无障碍朗读标签 MUST 随界面语言。

#### Scenario: 未连接时切换

- **WHEN** 用户尚未连接任何电脑，在电脑列表页选择 English
- **THEN** 当前页面与其后页面立即为英文，重启 App 后保持

#### Scenario: 无障碍标签

- **WHEN** 语言为英文且用户使用屏幕阅读器
- **THEN** 可交互元素读出英文标签，而不是中文

### Requirement: 保护词保持原样

界面文案中的机制性标识 MUST 在两种语言下保持原样、不被翻译：斜杠命令名与 CLI 子命令、选项名、键名与快捷键、错误码与协议枚举值、配置键与环境变量、工具名（如 `bash`、`edit`、`write`、`todo`）、产品名与技术术语（如 `agent`、`API Key`、`token`、`diff`、`WSL`）。其解释性文字 SHALL 随语言翻译。保护词清单 MUST 以数据文件固化，三端各有测试校验：字典中出现的保护词在 zh 与 en 文案中均原样存在。

#### Scenario: 命令名不被翻译

- **WHEN** 语言为中文或英文时查看 `/plan`、`/compact` 的说明
- **THEN** 命令名原样为 `/plan`、`/compact`，仅说明文字随语言

#### Scenario: 保护词被误翻译

- **WHEN** 某条 zh 或 en 字典文案把应保护的词改写为译名
- **THEN** 保护词对拍测试失败

### Requirement: 数据与内容不翻译

对话内容、模型回答、工具输出与参数、文件路径、会话标题、计划的 `title`/`steps`/`note`、问题与选项、todo 条目、排队预览、技能名称与描述、provider 与模型名、系统提示词、会话命名提示词与导出文件 MUST 保持原文，不随界面语言改变。

#### Scenario: 切换语言不改历史内容

- **WHEN** 用户在含中文对话与英文工具输出的会话中切换界面语言
- **THEN** 对话与工具输出保持原文，仅界面控件文案改变

#### Scenario: 技能原文

- **WHEN** 语言为英文，用户浏览技能市场
- **THEN** 技能名称与描述保持其原文，分组、按钮与状态等界面文案为英文

### Requirement: core 下发串的前端映射

对 core 经投影下发的英文串，前端 SHALL 在界面显示时映射为当前语言：运行状态（`Thinking...`、`Running <tool>...`、`Retrying (attempt N)...`）、系统行（`[context compacted]`、`[new context]`）、工具卡补充（`Not run: response interrupted.`），以及带错误码前缀的错误（`PROVIDER_DISABLED:`、`PROVIDER_KEY_REQUIRED:`、`PLAN_BUSY:`），按错误码映射。映射 MUST NOT 改变 core 与 gateway 的输出与应用协议；无法匹配时 MUST 回退显示原文且不报错。映射模板 MUST 有契约测试，以 core 真实投影的输出为输入，core 改变措辞时测试失败。

#### Scenario: 运行状态

- **WHEN** 语言为中文，agent 正在运行 `bash`
- **THEN** 状态行显示中文的「运行 bash…」，其中工具名 `bash` 原样

#### Scenario: 错误码

- **WHEN** 提交因 provider 未启用而返回 `PROVIDER_DISABLED:` 前缀错误
- **THEN** 界面按错误码显示当前语言的提示，判定逻辑仍依赖错误码而非本地化文案

#### Scenario: 未知串回退

- **WHEN** core 下发了前端未知的状态或系统行文案
- **THEN** 原文显示，无异常

### Requirement: 语言相关的日期与相对时间

界面中的绝对时间与相对时间 SHALL 随界面语言格式化：中文使用 `zh-CN`，英文使用 `en-GB`。同一端同一界面 MUST NOT 混用不同区域格式。

#### Scenario: 会话列表时间

- **WHEN** 语言为英文，会话列表显示 5 分钟前的会话
- **THEN** 相对时间显示为 `5m`，悬浮详情的绝对时间按 `en-GB` 格式

### Requirement: 字典完整性与防回退

每端的中文与英文字典 MUST 键集合一致、占位符一致，缺失键或占位符不一致时测试失败。已迁移目录中新增的 CJK 字符串字面量（注释、白名单与字典文件除外）MUST 使防回退测试失败；英文文案风格为简洁、首字母大写、句末不加句号。

#### Scenario: 缺少英文翻译

- **WHEN** 新增一条 zh 文案而未补 en
- **THEN** 字典对齐测试失败

#### Scenario: 组件内硬编码

- **WHEN** 在已迁移的组件中直接写入新的中文字面量
- **THEN** 防回退测试失败并指出文件与行
