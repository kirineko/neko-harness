# Spec Delta

## ADDED Requirements

### Requirement: TUI 语言命令与参数

TUI SHALL 提供 `/language` 命令，以与统一选择面板一致的风格列出「中文」与「English」，标出当前语言，选定后即时生效并写入保存值（见 `ui-language`）。TUI SHALL 支持 `--lang <zh|en>` 参数与 `NEKO_LANG` 环境变量，二者只影响当次进程。`/language` MUST 纳入 `/help` 与斜杠补全，且命令名在任一语言下保持原样。语言切换 MUST 保留输入草稿、附件、排队项、浏览位置与运行中的会话，不中断任务。

#### Scenario: 切换语言

- **WHEN** 用户输入 `/language` 并选择 English
- **THEN** 面板关闭，命令说明、状态栏、提示与后续面板立即为英文，草稿与运行中的任务不受影响

#### Scenario: 忙碌时切换

- **WHEN** agent 正在运行时用户切换语言
- **THEN** 当前运行不中断，状态行与快捷键提示随新语言刷新

#### Scenario: 参数非法

- **WHEN** 用户以 `neko tui --lang fr` 启动
- **THEN** TUI 以说明合法取值为 `zh` 或 `en` 的参数错误退出

## MODIFIED Requirements

### Requirement: 一致的终端显示语言

TUI 自有命令说明、状态、操作提示、选择面板与错误上下文 SHALL 使用当前界面语言（`zh` 默认，`en`，见 `ui-language`）；用户内容、模型回答及原始工具输出 MUST 保留原文。本规格其他要求中以「英语」「英文」或「TUI 语言约定」描述的产品文案，其字面文案对应 `en` 语言；`zh` 语言下 SHALL 使用等价中文，命令名、键名与保护词除外。明暗主题 SHALL 使用一致的语义角色，焦点和选中状态不能仅靠颜色识别；快捷键提示 MUST 对应实际行为。

#### Scenario: 忙碌快捷键
- **WHEN** agent 正在运行
- **THEN** 提示 Enter Queue、Esc Stop（`zh` 下为等价中文，键名不变），Ctrl+C 若中止运行则不得标为退出；有排队消息时排队区提示 Alt+↑ 可选择

#### Scenario: 非英语内容与主题切换
- **WHEN** 用户在英文界面提交中文并切换明暗主题
- **THEN** 用户内容保持中文，产品控件保持当前界面语言，选中项有可见标记且文本可读

#### Scenario: 默认中文
- **WHEN** 用户首次不带任何语言设置启动 TUI
- **THEN** 命令说明、状态栏、面板与提示均为中文，命令名与键名保持原样

#### Scenario: 英文模式
- **WHEN** 语言为 `en`
- **THEN** 产品文字为英语，与此前版本的英文界面一致
