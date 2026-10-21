# Tasks

## 1. 偏好模型与首屏应用

- [x] 1.1 新增 `packages/web/src/client/lib/appearance.ts`：取值常量（主题/字体/字号/字重/行高及默认值）、`parseAppearance`（逐项回落）、localStorage 读写（try/catch 降级）、`applyAppearance`（写 `<html>` 的 `data-theme`/`data-chat-*` 与 meta `color-scheme`）、`useSyncExternalStore` 订阅与 `storage` 事件同步；新增 `test/appearance.test.ts`，覆盖默认值、非法值逐项回落、存储不可用、多标签页同步，运行 `bun test packages/web/test/appearance.test.ts` 通过
- [x] 1.2 在 `index.html` 加首屏内联脚本（只把匹配 `/^[a-z0-9-]{1,16}$/` 的字符串写入 `data-*`，深色时设 meta `color-scheme`，全部 try/catch）；在 `appearance.test.ts` 加对拍：`index.html` 脚本与 `lib/appearance.ts` 的键名、属性名一致，并用 jsdom/happy-dom 式环境（沿用现有 tsx 测试环境）验证脚本执行后属性正确，非法值被忽略
- [x] 1.3 在 `main.tsx` 启动时调用 `applyAppearance` 初始化订阅，验证 `bun run test` 中 web 现有测试仍通过

## 2. 硬编码色 token 化（不改变默认外观）

- [x] 2.1 在 `styles.css` 新增并默认赋值：`--body-gradient`、`--logo-gradient-stops`、`--on-accent`、`--highlight-inset`、`--mix-base`、阴影色调、`--overlay`、`--color-diff-add`/删除色；改写 `body`、`.logo-gradient`、`.btn-primary`、阴影、遮罩与 hljs diff 使用这些 token；`:root` 增加 `color-scheme` 随主题；验证 `bun run build` 通过且默认主题下计算样式与改动前一致（对比构建产物中相应规则的值）
- [x] 2.2 把 `plan-row.tsx`、`question-card.tsx`、`ask-user-row.tsx`、`plan-card.tsx` 的 `text-white` 徽章改为 `text-on-accent`，检索并处理其余浅色字面量（`bg-white`、`border-white`、`hover:bg-black/5`），保留二维码白底；验证 `grep` 无遗留非预期字面量，`bun run test` 与 `bun run check` 通过
- [x] 2.3 在 Tailwind 的 `bg-<color>/<alpha>` 用法上确认与 token 覆盖兼容：构建后检查产物中此类规则是否按变量解析，不兼容的改为显式 token

## 3. 纸白与夜墨主题

- [x] 3.1 在 `styles.css` 增加 `[data-theme="light"]`：覆盖 `base`、`surface`、`sakura`（靛蓝）、`tianyi`（青）、`ink`（冷灰）色阶与 D5 的派生 token；验证切换 `data-theme="light"` 后聊天页、设置页、技能市场、关于页无遗留樱花色区域（构建后在浏览器手动截图核对）
- [x] 3.2 增加 `[data-theme="dark"]`：反相色阶（深蓝灰底、柔和紫粉强调、青辅色）、`color-scheme: dark`、深色阴影与遮罩、hljs 与 diff 配色；验证聊天、工具卡、diff、代码块、工作区栏、弹层、设置页在夜墨下均可读（手动截图核对）
- [x] 3.3 新增 `test/theme-contrast.test.ts`：读取 `styles.css`，对三套主题按 D8 计算关键色对对比度（正文/气泡、链接、徽章 `on-accent`、hljs 各色、diff 增删 ≥ 4.5；焦点环 ≥ 3），未达标时失败；运行 `bun test packages/web/test/theme-contrast.test.ts` 通过，必要时回头微调色值

## 4. 聊天排版变量

- [x] 4.1 在 `styles.css` 增加 `[data-chat-font|size|weight|leading]` 到 `--chat-*` 变量的映射（默认值等于现状：无衬线、14px、400、1.6/1.75），让 `.bubble-user`、`.bubble-assistant`、`.md` 与 `composer.tsx` 输入框读取这些变量；`strong` 与标题固定 700
- [x] 4.2 将 `.md` 标题字号由 `rem` 改为等值 `em`，保持 `pre`/`.hljs`/diff 的字号与字体不变；新增 `test/chat-typography.test.ts` 断言默认档位的计算值与改动前一致、各档位变量存在，运行通过
- [x] 4.3 在 18px 与衬线、等宽、偏粗组合下检查气泡不横向溢出、工具卡与侧栏不变（手动在 375/768/1440 宽度验证）

## 5. 外观设置页

- [x] 5.1 新增 `components/appearance-panel.tsx` 与 `pages/settings-appearance-page.tsx`：主题三张 `radiogroup` 预览卡（卡内 `data-theme`）、字体/字号/字重/行高 chips、示例对话（用户气泡、助手气泡、行内代码、代码块）、恢复默认、字体项「取决于本机字体」提示；选择即保存
- [x] 5.2 在 `settings-shell.tsx` 的 `SettingsSection` 与 `MENU` 增加「外观」（置于「上下文」之后、「手机配对」之前），在 `main.tsx` 注册 `/settings/appearance` 路由
- [x] 5.3 新增 `test/appearance-settings.test.tsx`：点选主题与各档位后偏好与 `<html>` 属性更新、恢复默认、键盘可操作与 `aria-checked`、菜单项高亮 `aria-current`；运行 `bun test packages/web/test/appearance-settings.test.tsx` 通过

## 6. 规格同步与整体验证

- [x] 6.1 运行 `openspec validate web-appearance-settings --strict` 通过
- [x] 6.2 运行 `bun run check`、`bun run test`、`bun run build` 全部通过
- [x] 6.3 启动 `bun run neko web` 手动验证：三主题切换、刷新无闪烁、两个标签页同步、窄屏设置菜单、恢复默认

## Workflow follow-up

- 同步或归档该变更前确认 `openspec/specs/web-ui` 的「二次元主题系统」已按增量更新。
- 归档：`/openspec-archive-change`。
