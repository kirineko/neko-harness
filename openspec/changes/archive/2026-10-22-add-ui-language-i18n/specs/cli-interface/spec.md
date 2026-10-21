# Spec Delta

## MODIFIED Requirements

### Requirement: 帮助输出语言与术语统一

根命令与全部子命令的帮助输出 SHALL 默认使用中文，网关组件的术语 SHALL 统一为「网关」，用法行中的占位符（如 `[选项]`、`<路径>`）SHALL 使用中文。例外：`neko tui --help` SHALL 随界面语言（`--lang`、`NEKO_LANG`、保存值，见 `ui-language`）输出，`en` 时整段使用英文并以 `Usage: neko tui [options]`、`Options:` 与 `-h, --help Show this help` 对应结构；其他命令的帮助保持中文。

#### Scenario: 各入口语言一致

- **WHEN** 用户在默认语言下分别运行 `neko --help`、`neko tui --help`、`neko web --help`、`neko serve --help`、`neko update --help`
- **THEN** 输出均为中文，且网关组件均称「网关」，无中英文混排（协议名、文件名、环境变量名等专有标识除外）

#### Scenario: TUI 帮助随语言

- **WHEN** 用户运行 `neko tui --lang en --help` 或设置 `NEKO_LANG=en` 后运行 `neko tui --help`
- **THEN** 输出为英文，`--theme`、`--lang`、`NEKO_THEME`、`NEKO_LANG` 等标识原样，说明文字为英文；此时 `neko web --help` 仍为中文

### Requirement: 帮助输出结构统一

每个命令的帮助输出 SHALL 以 `用法: neko <命令> [选项]`（无选项时可省略 `[选项]`）开头，选项列于 `选项:` 段、两空格缩进且描述列对齐，并以 `-h, --help 显示此帮助` 作为选项段收尾；根命令 SHALL 额外列出全部子命令与 `-v, --version`。`neko tui` 在英文语言下 SHALL 使用等价结构（`Usage:`、`Options:`、`-h, --help Show this help`），`neko tui --help` 的选项段 SHALL 列出 `--lang <zh|en>` 并在尾部补充说明 `NEKO_LANG` 与「`--lang` 与 `NEKO_LANG` 只影响当次，`/language` 保存默认」。

#### Scenario: 子命令用法行显示真实命令名

- **WHEN** 用户运行 `neko web --help` 或 `neko serve --help`
- **THEN** 用法行分别为 `用法: neko web [选项]` 与 `用法: neko serve [选项]`，不出现 `main.ts`

#### Scenario: 根命令帮助列出全部入口

- **WHEN** 用户运行 `neko --help` 或不带参数运行 `neko`
- **THEN** 输出按 tui、web、serve、update 顺序列出子命令，并包含 `-v, --version` 说明

#### Scenario: TUI 帮助说明语言参数

- **WHEN** 用户运行 `neko tui --help`
- **THEN** 选项段列出 `--lang <zh|en>`，尾部说明 `NEKO_LANG`，以及 `--lang` 与 `NEKO_LANG` 只影响当次、`/language` 保存默认
