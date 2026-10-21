# Proposal

## Why

Web、移动端的界面文案写死为中文，TUI 写死为英文，用户无法按自己的语言习惯使用，三端的语言约定也不一致。需要一套统一的国际化机制：默认中文，可切换为英文，并保证命令、工具名、错误码等机制性标识不被误翻译。

## What Changes

- 三端新增「界面语言」偏好，取值 `zh`（默认）与 `en`，不提供「跟随系统」；非法值回退 `zh`。各端偏好独立保存，不经 gateway、不提升应用协议：
  - Web：localStorage `neko.language`；设置菜单新增独立的「语言 / Language」页（`/settings/language`）；首屏脚本同步 `<html lang>`；多标签页同步。
  - Mobile：`PrefsStore` 保存，Flutter `gen-l10n` + ARB；语言选择器与现有主题选择器并列（抽屉与电脑列表页，连接前也可切换）。
  - TUI：`~/.neko/tui.json`（`{ "language": "zh" | "en" }`）持久化；`--lang zh|en` 与 `NEKO_LANG` 仅影响当次进程；`/language` 即选即生效并写入保存值；优先级 `--lang` > `NEKO_LANG` > 保存值 > `zh`。`neko tui --help` 随该语言输出。
- 每端建立带类型约束的 zh/en 字典（Web/TUI：`t(key, params)`；Mobile：ARB），把现有硬编码界面文案（含 aria-label、提示、占位符、校验错误）迁入字典。TUI 现有英文即 `en` 字典，需补全 `zh`；Web/Mobile 现有中文即 `zh` 字典，需补全 `en`。TUI 默认语言由英文变为中文。
- 「保护词」统一保持原样：斜杠命令名与 CLI 子命令/参数、键名、错误码与协议枚举值、配置键与环境变量、工具名、产品与技术术语等。保护词清单固化为数据文件，三端测试校验 zh/en 字典均原样保留。
- core 下发的英文串（`Thinking...`、`Running <tool>...`、`Retrying (attempt N)...`、`[context compacted]`、`[new context]`、`Not run: response interrupted.`、`PROVIDER_*`/`PLAN_BUSY` 正文）由前端按固定模板或错误码映射为当前语言文案，未匹配时回退原文；core 与 gateway 不改。
- 日期与相对时间随语言格式化（`zh-CN` / `en-GB`），消除 Web 现有 `toLocaleString()` 混用。
- 新增防回退测试：已迁移目录中新增的 CJK 字面量（注释与白名单除外）使测试失败。
- 英文文案风格：简洁、首字母大写、句末不加句号。

不做：翻译对话内容、工具输出、模型生成的标题/计划/问题/todo、技能名与描述、provider/模型名、系统提示词与会话命名提示词、导出文件；不改 core/gateway 与日志（含 gateway 下发的中文错误，在 `en` 下仍可能显示中文，属已知遗留）；不改 `debugPrint` 日志与代码注释；TUI 主题持久化（`/theme`）暂不处理；不支持其他语言、「跟随系统」、跨设备同步语言。

## Capabilities

### New Capabilities

- `ui-language`: 三端界面语言偏好——取值与默认、各端保存与优先级、字典完整性、保护词、core 下发串的前端映射、日期格式与防回退守护。

### Modified Capabilities

- `web-ui`: 新增「语言」设置菜单与页面要求；升级提示、Git Bash 提示不再限定「中文」，改为随界面语言。
- `terminal-ui`: 「一致的终端显示语言」由「产品文案固定英语」改为随界面语言（`zh` 默认 / `en`），新增 `/language`；会话列表、技能调用/市场、命令审批中的「英语」约定同步调整。
- `mobile-ui`: 新增语言选择与随语言呈现的要求。
- `cli-interface`: `neko tui --help` 随界面语言输出，新增 `--lang`/`NEKO_LANG` 说明；其他命令的帮助仍为中文。

## Impact

- 代码：`packages/web`（新增 `lib/i18n`、字典、语言页与菜单、首屏脚本、全部组件文案迁移、日期格式）、`packages/tui`（新增 i18n 与 `tui.json` 读写、`--lang`/`/language`、全部面板文案迁移、`main.ts` 帮助）、`apps/mobile`（`pubspec` 增加 `flutter_localizations`/`intl`、`l10n.yaml` 与 ARB、`AppController` 语言状态、全部页面文案迁移）、保护词清单数据文件与三端对拍测试。
- 测试：现有 Web/Mobile 中文断言保持（默认 zh）；TUI 原断言英文，测试中显式固定语言；新增字典对齐、保护词、映射契约（用 core 真实投影输出）、语言持久化与防回退测试。
- 协议与依赖：无应用协议、gateway、core 变更；Mobile 新增官方 `flutter_localizations`/`intl`（版本按仓库精确锁定约定）；Web/TUI 无新依赖。
- 文档：AGENTS.md 增加「界面语言」约定。
