# Tasks

## 1. 共享契约：保护词清单与 core 串夹具

- [x] 1.1 新增 `packages/core/src/i18n/protected-terms.json`（`{ term, kind }`，覆盖命令、CLI、键名、错误码与枚举值、配置键与环境变量、工具名、产品/技术词），并以统一匹配规则新增纯模块 `protected-terms.ts`（按词边界且大小写敏感，带 `/` 前缀的整体匹配；普通英文词标记 `auto: false` 不参与自动对拍），导出 `findProtectedTerms(text)`；新增 `packages/core/test/protected-terms.test.ts` 覆盖匹配规则与清单格式，运行 `bun test --conditions=neko-source --isolate packages/core/test/protected-terms.test.ts` 通过
- [x] 1.2 新增 `packages/core/test/fixtures/core-ui-strings.json`（`status`、`systemRows`、`toolNote`、`errors` 的原文与参数）与 core 契约测试：用真实 `projection` 输出与 `runtime` 抛出的错误生成这些串并与夹具对拍，措辞变化时失败；不修改 core 源码；运行该测试通过
- [x] 1.3 把保护词清单子路径导出（遵循 `credential-providers` 的纯模块子路径做法）供 Web/TUI 测试 import，验证 `bun run build` 通过且 `packages/web`、`packages/tui` 的测试可 import

## 2. Web：i18n 基础设施与语言页

- [x] 2.1 新增 `packages/web/src/client/lib/i18n/`：`zh.ts`（`as const` 权威字典）、`en.ts`（同形类型）、`index.ts`（`t`/`getT`、`{name}` 占位符替换并缺参抛错、`useLanguage`/`useT`）与 `lib/language.ts`（localStorage `neko.language` 读写，非法/缺失回退 zh，`storage` 事件跨标签同步，`applyLanguage` 同步 `<html lang>`）；新增 `test/language.test.ts` 覆盖默认值、非法回退、存储不可用、多标签页同步、`<html lang>`，运行 `bun test --conditions=neko-source --isolate packages/web/test/language.test.ts` 通过
- [x] 2.2 在 `index.html` 首屏脚本中同步设置 `<html lang>`（只接受 `zh`/`en`），并在 `language.test.ts` 中与 `lib/language.ts` 的键名对拍（沿用 `appearance` 脚本的对拍与 `window.eval` 方式）；`main.tsx` 启动订阅，验证 web 现有测试仍通过
- [x] 2.3 新增 `pages/settings-language-page.tsx` 与语言面板（「中文」「English」互斥选项，原生 radio，键盘可操作），在 `settings-shell.tsx` 的 `MENU` 于「外观」之后、「手机配对」之前加入固定双语的「语言 / Language」，在 `main.tsx` 注册 `/settings/language`；新增 `test/language-settings.test.tsx`（进入页面、切换即时更新、`aria-current`、窄屏菜单），运行通过
- [x] 2.4 新增 `lib/i18n/core-text.ts`（core 下发串映射表：状态、系统行、工具卡补充、`PROVIDER_*`/`PLAN_BUSY` 错误码，未匹配回退原文）并接入状态行、系统行与错误提示；新增 `test/core-text.test.ts` 读取 1.2 的夹具验证覆盖、参数原样与回退，运行通过
- [x] 2.5 新增 `lib/i18n/format.ts`（`formatDateTime`：zh→`zh-CN`，en→`en-GB`；相对时间传入当前语言调用 core `relativeTime`），替换 `session-list.tsx`、`mobile-pairing.tsx` 等处混用的 `toLocaleString`；新增测试覆盖两种语言，运行通过
- [x] 2.6 新增字典对齐与保护词对拍测试 `test/i18n-dictionary.test.ts`（zh/en 键集合、占位符一致，`findProtectedTerms` 在两种语言中的集合相等）与防回退扫描测试 `test/i18n-no-hardcoded.test.ts`（TypeScript 编译器 API 扫描 `src/client` 字面量与 JSX 文本，排除 `i18n/` 与带原因的白名单，初始白名单列出尚未迁移的文件）；运行通过

## 3. Web：文案迁移

- [x] 3.1 迁移聊天主干：`composer.tsx`、`message-list.tsx`、`tool-card.tsx`、`queue-bar.tsx`、`top-bar.tsx`、`question-card.tsx`、`ask-user-row.tsx`、`plan-card.tsx`、`plan-row.tsx` 及 `lib/plan-ui.ts`、`lib/interactions.ts`、`lib/layout.ts`、`lib/store.ts`（含 aria-label、占位符、校验与 notice）；英文沿用设计 D10 约定，`edit`/`write`/`bash` 等保护词原样；从防回退白名单移除这些文件，运行 `bun test --conditions=neko-source --isolate packages/web` 通过且新增「切换语言后文案更新」的组件测试
- [x] 3.2 迁移会话与工作区：`session-list.tsx`、`workspace-picker.tsx`、`workspace-panel.tsx`、`file-tree.tsx`、`file-viewer.tsx`、`changes-list.tsx`、`subagent-panel.tsx`、`job-panel.tsx`、`todo-panel.tsx`、`open-workspace-menu.tsx` 及相关 `lib/*`；白名单同步收敛，web 测试通过
- [x] 3.3 迁移设置与其余：`pages/skills-page.tsx`、`about-page.tsx`、`components/mobile-pairing.tsx`、`model-picker.tsx`、`provider-credential-card.tsx`、`context-settings-panel.tsx`、`appearance-panel.tsx`、`update-notice.tsx`、`settings-shell.tsx` 及 `lib/gateway.ts`、`bootstrap.ts`、`context-settings.ts`、`mobile-admin.ts`、`search-settings.ts`、`open-workspace.ts`、`job-output.ts`、`path-crumbs.ts`、`diff-highlight.ts`；验证防回退白名单为空（或仅余带原因条目）、字典对齐与保护词测试通过
- [x] 3.4 在两种语言下对 Web 做浏览器冒烟（聊天、设置各页、技能市场、关于页、移动端宽度），核对无遗留中文、无溢出，保护词原样；运行 `bun run check`、`bun run test`、`bun run --cwd packages/web build` 通过

## 4. TUI：基础设施与语言命令

- [x] 4.1 新增 `packages/tui/src/i18n/`（`zh.ts`、`en.ts`、`index.ts`：进程内当前语言、`t(key, params)`、`setLanguage` 并通知重绘）与 `language-settings.ts`（读写 `<数据目录>/tui.json`：保留未知字段、原子写、损坏/非法回退 zh、写失败返回错误）；优先级解析函数 `resolveLanguage({ flag, env, saved })`；新增 `test/language-settings.test.ts` 覆盖优先级、仅 `/language` 写入、损坏文件、写失败、未知字段保留，运行 `bun test --conditions=neko-source --isolate packages/tui/test/language-settings.test.ts` 通过
- [x] 4.2 在 `main.ts` 解析 `--lang`（非法值参数错误退出）与 `NEKO_LANG`，启动前确定语言；在 `tui.ts` 注册 `/language` 命令与选择面板（沿用统一选择面板，标出当前项，选定即时生效并写入保存值），纳入 `/help` 与斜杠补全；切换时重建命令列表并重绘，保留草稿、附件、排队项、浏览位置；新增测试覆盖面板选择、即时切换、忙碌时切换不中断，运行通过
- [x] 4.3 在 TUI 侧新增 core 串映射（复用 `core-text` 同款表与夹具）与 `formatDateTime`（`relativeTime` 传入当前语言、绝对时间随 zh-CN/en-GB），接入状态行（`view.status`）、系统行与错误提示；新增测试覆盖映射与回退，运行通过
- [x] 4.4 新增 TUI 字典对齐/保护词对拍测试与基于 TypeScript 编译器 API 的防回退扫描测试（含初始白名单）；测试 setup 显式固定语言（默认 `en` 保持原英文断言），运行 `bun test --conditions=neko-source --isolate packages/tui` 通过

## 5. TUI：文案迁移与帮助

- [x] 5.1 把现有英文文案迁入 `en` 字典并补全 `zh`：`labels.ts`（`commands`、`labels`）、`help-ui.ts`、`tui.ts`、`question-dock.ts`、`plan-dock.ts`、`approval-*`、`queue-ui.ts`、`workspace.ts`（`AWAITING_*`）及 `components/*`；顶层常量改为函数；保护词（命令名、键名、`Allow once`/`Deny` 的快捷键行为、工具名）原样；运行 `bun test --conditions=neko-source --isolate packages/tui` 通过且新增 zh 用例
- [x] 5.2 迁移其余面板：`provider-ui.ts`、`skill-market-ui.ts`、`context-ui.ts`、`search-ui.ts`、`jobs-ui.ts`、`todos-ui.ts`、`subagents-ui.ts`、`version-ui.ts`、`shell-notice.ts`、`export-command.ts`、`file-completion.ts`；技能名/描述、provider/模型名保持原文；防回退白名单收敛，测试通过
- [x] 5.3 `main.ts` 的 `--help` 改为随语言输出：中文保持现状并新增 `--lang`、`NEKO_LANG` 与「`/language` 保存默认」说明，英文为等价翻译（`Usage:`/`Options:`/`-h, --help Show this help`）；新增测试覆盖 zh/en 两种帮助，并验证 `neko web --help` 等其他命令帮助不变；运行 `bun packages/cli/dist/main.js tui --help` 与 `NEKO_LANG=en` 的输出符合 `cli-interface` 规格
- [x] 5.4 在两种语言下对 TUI 做端到端冒烟（启动、`/help`、`/language` 切换、忙碌态、`/plan`、审批、`/skills`），核对无遗留中英混排；运行 `bun run check`、`bun run test` 通过

- [x] 5.5 核对 `packages/cli` 对 `neko tui --help` 的转发不会提前用中文覆盖（`--lang`/`NEKO_LANG` 能传到 TUI 解析），并更新 `packages/cli/test` 中相关断言；运行 CLI 相关测试通过

## 6. Mobile：基础设施与语言选择

- [x] 6.1 在 `apps/mobile/pubspec.yaml` 加入 `flutter_localizations` 与 `intl`（按仓库精确范围写法锁定到 `pubspec.lock` 当前解析版本）并开启 `generate: true`，新增 `l10n.yaml` 与 `lib/l10n/app_zh.arb`（模板）/`app_en.arb`；运行 `flutter pub get` 与 `flutter gen-l10n` 成功，`flutter analyze` 无新增问题
- [x] 6.2 在 `AppController` 增加 `locale`（`ValueNotifier<Locale>`）、`setLocale` 与启动恢复（`PrefKeys.language`，缺省/非法 zh）；`main.dart` 的 `MaterialApp.router` 绑定 `locale`、`localizationsDelegates`、`supportedLocales` 与固定回退 zh；在 `neko_drawer.dart` 与 `computers_page.dart` 的主题选择器旁加入语言选择；新增 widget/单元测试覆盖默认 zh、连接前切换、重启恢复、非法值回退，运行 `flutter test` 相关用例通过
- [x] 6.3 新增 Dart 版 core 串映射（读取 1.2 夹具验证）、日期/相对时间（`intl` 与 ARB），并新增字典对齐测试（zh/en ARB 键与占位符一致）与保护词对拍测试（读取 `protected-terms.json`，路径集中在一个测试 helper）；新增防回退扫描测试（排除生成文件、`debugPrint(` 行、行注释，带白名单）；运行通过

## 7. Mobile：文案迁移

- [x] 7.1 迁移 `features/chat`、`features/approvals`、`features/plan`、`features/questions`、`features/todos`、`features/subagents` 的界面文案与无障碍标签到 ARB；`子 agent` 等保护词按 D10 约定（英文 `sub-agent`）；运行 `flutter test` 与 `flutter analyze` 通过，并补充英文语言下的 widget 用例
- [x] 7.2 迁移 `features/sessions`、`features/computers`、`features/connect` 与 `ui/` 通用组件；`lib/core/pairing`、`api`、`rpc` 中面向用户的错误改为类型化错误（稳定码 + 参数）并由 UI 层本地化，`nekopair:`、`pinnedHost` 等协议标识原样；`debugPrint` 日志保持不译；防回退白名单收敛为空（或仅余带原因条目）
- [x] 7.3 在中英两种语言下对 Mobile 做模拟器冒烟（未连接页切换、扫码页、会话、计划/提问/审批、子 agent），核对无遗留中文与溢出；运行 `flutter analyze`、`flutter test` 通过

## 8. 文档与整体验收

- [x] 8.1 在 `AGENTS.md` 新增「界面语言」一节（各端存放位置与优先级、字典与保护词清单位置、core 串映射与夹具、防回退白名单规则、TUI 默认中文与 `NEKO_LANG=en`、已知遗留：gateway 中文错误），并更新 README 中 TUI 帮助相关示例（如有）；验证文档所述命令可执行
- [x] 8.2 整体验收：运行 `bun run check`、`bun run test`、`bun run build`，`cd apps/mobile && flutter analyze && flutter test`，确认三端防回退白名单收敛、字典与保护词测试全部通过；`openspec validate add-ui-language-i18n --strict` 通过

## Workflow follow-up

- 评审后归档该变更，并把 `ui-language` 同步为主 spec。
- 归档后单独评估是否清理 terminal-ui 主 spec 中其余「使用英语」措辞。
