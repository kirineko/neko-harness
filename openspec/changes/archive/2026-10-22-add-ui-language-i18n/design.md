# Design

## Context

- Web 与移动端界面文案硬编码为中文，TUI 硬编码为英文（`labels.ts` 注明 "Product language is English"，主 spec「一致的终端显示语言」同样固定英语）。三端没有任何 i18n 基础设施；Web `index.html` 写死 `lang="zh-CN"`，Mobile 没有 `flutter_localizations`（`intl` 仅作为传递依赖在 `pubspec.lock` 中），TUI 仅 `--help` 为中文。
- 已有可借用的先例：Web 的 `lib/appearance.ts`（localStorage + `useSyncExternalStore` + 首屏脚本 + storage 事件）；Mobile 的 `PrefsStore` 与 `AppController.themeMode`（`ValueNotifier` + 抽屉/电脑列表页两处选择器）；TUI 的 `--theme` / `NEKO_THEME` 与进程内 `/theme`；core 纯模块子路径（`credential-providers`、`interactions`）经 Dart 契约镜像。
- core 的 `projection.ts` 直接下发英文串（状态 `Thinking...` / `Running <tool>...` / `Retrying (attempt N)...`、系统行 `[context compacted]` / `[new context]`、`Not run: response interrupted.`），`runtime.ts` 抛出带码前缀的英文错误；Web 已用 `message.includes("PLAN_BUSY")` 按码判定。`relativeTime(at, now, language)` 已支持 zh/en。
- Web/Mobile 现有测试大量断言中文文案与中文 aria-label；TUI 测试断言英文。动机与范围见 proposal.md。

## Goals / Non-Goals

**Goals:**

- 三端 zh/en 双语，默认 zh，偏好各端独立保存且切换即时生效。
- 机制性标识（命令、工具名、错误码、键名等）永远原样，且由测试守护。
- 不改 core / gateway / 应用协议；core 下发串在前端映射，未知回退原文。
- 迁移完成后新增硬编码中文字面量会被测试拦住，字典 key 与占位符两种语言必须一致。

**Non-Goals:**

- 不支持第三种语言、不跟随系统、不做复数/性别等复杂 ICU 规则（用词避开复数，必要时拆成两个 key）。
- 不翻译对话与模型数据、不改 gateway 中文错误与启动日志、不动 TUI 主题持久化。
- 不做服务端按语言渲染（语言始终是前端展示层概念）。

## Decisions

### D1 偏好各端独立保存

| 端 | 位置 | 机制 |
|---|---|---|
| Web | localStorage `neko.language`（`"zh"`/`"en"`，缺省即 zh） | 复用 appearance 的 store 模式，storage 事件跨标签同步；首屏内联脚本设置 `<html lang>`（`zh-CN`/`en`） |
| TUI | `<数据目录>/tui.json`（`{ "language": "zh"|"en" }`，保留未知字段） | 启动时同步读取；`--lang` > `NEKO_LANG` > 保存值 > zh；只有 `/language` 写入；原子写（临时文件 + rename），失败仅通知 |
| Mobile | `PrefsStore` 的 `PrefKeys.language` | `AppController.locale`（`ValueNotifier<Locale>`），`MaterialApp.locale` 绑定 |

备选：存入 gateway 的 `app.neko.*` 文档三端共享。否决：需新契约与旧网关探测；Mobile 连接的是他人电脑，语言本是设备偏好；TUI 在网关连接前就要决定语言。TUI 的数据目录沿用 `tui/gateway.ts` 已解析的 `nekoDir`（缺省 `~/.neko`），不新增解析规则。

### D2 Web / TUI：类型化字典 + `t(key, params)`

- `zh` 字典是 key 的权威（`as const` 对象，点分命名空间如 `composer.sendFailed`），`en` 字典声明为同形类型，缺 key 编译期报错；占位符用 `{name}`，`t` 按 params 替换并在缺参时抛错（开发期暴露）。
- Web：`lib/i18n/`（`zh.ts`、`en.ts`、`index.ts`），`useLanguage()` / `useT()` 经 `useSyncExternalStore`，非 React 代码（`storeActions.notice`、各 `lib/*-ui.ts`）用同一 store 的 `getT()`。模块顶层常量的文案（如 `PLAN_UNSUPPORTED_TEXT`、`QUESTION_STATUS_LABEL`）改为函数或在渲染时取值，避免在加载期固化语言。
- TUI：进程内单例语言（`getLanguage()` / `setLanguage()`），`t(key)` 读取当前语言；`labels`、`commands`、`AWAITING_*`、`SKIP_LABEL` 这类顶层常量改为函数。`/language` 切换后触发整体重绘并重建斜杠命令列表与已挂载组件的静态文案（草稿、排队、浏览位置不重建）。现有英文字符串原样成为 `en` 字典。
- 备选：i18next / 第三方库。否决：两端字典规模有限、需严格类型与保护词测试，自带实现更小且无新依赖。

### D3 Mobile：Flutter 官方 gen-l10n

`pubspec.yaml` 加入 `flutter_localizations` 与 `intl`（按仓库的精确范围写法锁定到当前 `pubspec.lock` 已解析版本）并开启 `generate: true`；`l10n.yaml` 指向 `lib/l10n/`，`app_zh.arb` 为模板，`app_en.arb` 同键；`supportedLocales = [zh, en]`，默认 `zh`，不跟随系统（`localeResolutionCallback` 固定回退 zh）。占位符用 ARB 的 `{name}` 与类型声明，不使用复数 ICU。

非 widget 层（`core/pairing`、`core/api` 等）产生的用户可见错误，改为抛带稳定码与参数的类型化错误，由 UI 层映射为本地化文案；个别难以改造处用 `lookupAppLocalizations(locale)`。`debugPrint` 日志不翻译。

### D4 保护词清单：数据文件 + 三端对拍

清单为 `packages/core/src/i18n/protected-terms.json`（`{ term, kind }`，kind 如 `command | cli | key | code | tool | product | tech`），三端测试读取：对每个 key，zh 与 en 文案中出现的保护词集合 MUST 相等（按词边界、大小写敏感匹配；`/plan` 等带前缀的整体匹配；`edit`、`write`、`agent`、`token` 这类同时是普通英文词的条目标记 `auto: false`，不参与自动对拍、只靠评审）。Web/TUI 的测试直接 import，Dart 测试读取同一文件（仓库内相对路径，仓库已有 Dart 镜像 core 常量的先例）。这样 `Bash 审批` 被改写成「命令行审批」时 zh 与 en 集合不等而失败；两侧同时误译的情形由评审与清单本身兜底。

清单范围见 `ui-language` 的「保护词」「数据与内容不翻译」要求；初稿由探索阶段的统计（命令、工具名、错误码、键名、配置键、产品/技术词）整理而来。

### D5 core 下发串：前端映射，契约测试钉住

每端一张映射表（Web/TUI：`core-text.ts`；Mobile：Dart 同名文件）：`[{ pattern, key, params }]`，匹配固定模板（如 `^Running (.+)\.\.\.$` → `status.running`，工具名作参数且原样）；错误按 `CODE:` 前缀取码映射；未匹配返回原文。

契约钉住：core 侧新增一个测试，用真实投影与错误路径生成这些串并与 `packages/core/test/fixtures/core-ui-strings.json` 对拍（core 措辞变更时该测试失败，提示同步更新夹具与前端映射）。Web/TUI 测试以该夹具为输入验证映射覆盖，Dart 测试读取同一夹具。core 源码不变，只新增测试与夹具。

### D6 日期与相对时间

各端提供 `formatDateTime(ms, language)`：`zh` → `zh-CN`，`en` → `en-GB`（TUI 现有先例）；相对时间直接调用 core 已有的 `relativeTime(at, now, language)`（Web 现硬编码 `"zh"`、TUI 缺省 `"en"`，改为传入当前语言）。Mobile 用 `intl` 的 `DateFormat` 与 ARB 文案。

### D7 防回退扫描

- Web/TUI：测试用 TypeScript 编译器 API 解析 `src/client`（Web）与 `src`（TUI）下各文件，收集 `StringLiteral` / `NoSubstitutionTemplateLiteral` / `TemplateHead…` / `JsxText` 中含 CJK 的节点，排除 `i18n/` 目录与显式白名单（文件 + 原因）。注释天然不在 AST 字面量中。
- Mobile：测试逐行扫描 `lib/` 下 `.dart`（排除生成文件与 `debugPrint(` 行、行注释），含 CJK 的字符串字面量失败，带白名单。
- 白名单随迁移收敛，目标为空（`gateway` 下发文案不在 Web/TUI/Mobile 源码内，不受影响）。

### D8 TUI 默认语言切换与帮助

默认语言由英文变中文属有意的可见变更：`en` 字典沿用现有文案，`zh` 为新增；TUI 测试在 setup 中显式固定语言（默认 `en` 以保持原断言，另加 zh 用例），避免大面积改断言。`main.ts` 的 `--help` 先解析 `--lang` / `NEKO_LANG` / 保存值（同一解析函数），再选择中文或英文帮助；非法 `--lang` 以参数错误退出。中文帮助保持现状，英文帮助为其等价翻译。其他子命令（`web`、`serve`、`update`、根命令）帮助不变。

### D9 主 spec 的「英语」表述

terminal-ui 主 spec 约有 18 个要求提及「使用英语 / 英文」。本变更只修改根要求「一致的终端显示语言」，并在其中声明其余表述的字面文案对应 `en`、`zh` 下为等价中文，避免逐条重写大量未变行为的要求。归档后可单独开变更清理这些措辞。

### D10 英文文案约定

简洁、首字母大写、句末不加句号；保持术语一致（`agent` 保护词，复合词用 `sub-agent`，保证保护词边界匹配）；按钮用动词原形；错误提示说明下一步。Web/Mobile 英文由本变更撰写，TUI 英文沿用现状并只做必要统一。

## Risks / Trade-offs

- [规模大：Web 约 80 文件、Mobile 约 35 文件、TUI 约 26 文件] → 四组任务各自独立可验证，基础设施先行；按页面/面板分批迁移并在每批跑字典对齐与防回退测试。
- [顶层常量在加载期固化语言] → 改为函数/渲染期取值，并以「切换语言后断言文案更新」的组件测试覆盖。
- [core 串模板被改动导致映射静默失效] → 契约测试 + 夹具；失效最坏情况是回退显示英文原文。
- [gateway 中文错误在 en 下仍为中文] → 已声明为已知遗留；文档注明，不在本变更处理。
- [TUI 默认语言变化让既有英文用户困惑] → 在 AGENTS.md 与帮助中说明 `NEKO_LANG=en` 与 `/language`；保存后即固定。
- [保护词对拍只能发现 zh/en 不一致，两侧同时误译不会被发现] → 清单评审 + 迁移时逐端人工复核高风险文案（工具卡、审批、命令说明）。
- [Dart 测试读取仓库内 JSON 路径依赖布局] → 沿用现有跨包镜像做法，路径集中在一个测试 helper。
- [英文文案由本变更撰写，可能有措辞问题] → 统一风格约定，评审时抽查；文案均在字典内，后续可低成本修订。

## Migration Plan

无持久数据迁移：偏好缺省即 zh；旧版本保存的数据不含语言字段。发布后 TUI 默认中文，需要英文者设 `NEKO_LANG=en` 或用 `/language` 保存。回滚即移除语言入口并回退字典读取，不影响会话数据。
