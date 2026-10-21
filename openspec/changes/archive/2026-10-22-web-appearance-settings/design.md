# Design

## Context

- Web 的颜色全部来自 `styles.css` 里 Tailwind v4 `@theme` 定义的三套色阶：`sakura-*`（主色）、`tianyi-*`（辅色）、`ink-*`（中性），外加 `base` / `surface`。组件里有约 730 处 `bg-sakura-100` 之类的用法，构建产物是 `background-color: var(--color-sakura-100)`，因此在更具体的选择器下覆盖这些 CSS 变量即可整站换色，组件不用改。
- 仍有少量硬编码：`body` 的粉蓝渐变、`.logo-gradient`、`.btn-primary` 的白色内高光与 `color-mix(... white)`、粉调 `oklch` 阴影、弹层遮罩 `rgb(50 43 52 / .33)`、diff 增色 `#117555`、`:root{color-scheme: light}` 与 `<meta name="color-scheme" content="light">`、四处 `bg-tianyi-700 ... text-white` 徽章。深色主题下这些会直接坏掉。
- 聊天正文字号、字体、行高没有集中变量：气泡继承 `body`（`--text-base` = 14px），`.md` 行高写死 1.75，标题与代码块用 `rem`，输入框用 `text-base`。
- 本地偏好已有先例：`neko.openTarget` 存 localStorage（`lib/open-workspace.ts`），读写都有 try/catch 降级。Web 没有 CSP，允许 `index.html` 内联脚本。
- 设置区由 `SettingsShell` 的 `MENU` 数组驱动，路由在 `main.tsx` 注册。上下文页已有「一键选择预设档位」的交互可参照。

## Goals / Non-Goals

**Goals:**

- 三套主题共用现有 token 名，只换值；组件代码基本不感知主题。
- 首次绘制即正确，不闪烁。
- 聊天排版四项（字体、字号、字重、行高）用变量驱动，范围限定在聊天正文与输入框。
- 对比度有自动化测试守护。

**Non-Goals:**

- 不走 gateway / 应用协议，不改 TUI、移动端、Dart 契约。
- 不做跟随系统、自定义颜色或字体名、字体文件打包。
- 不重做组件布局；工具卡、侧栏、设置页的字号不随聊天排版变化。

## Decisions

### D1 偏好存 localStorage，不进 gateway 文档

键 `neko.appearance`，值为 JSON `{ v: 1, theme, font, size, weight, leading }`。外观是单设备、单浏览器偏好（字号与屏幕相关），不需要与 TUI/手机同步；这样不提升应用协议，不动 Dart 契约。跨标签页用 `storage` 事件同步。

备选：`app.neko.*` 文档经 gateway 同步。否决：需要新契约方法、协议版本与多端处理，收益只是跨设备同步，且不同屏幕的合适字号本来就不同。

### D2 `data-*` 属性 + CSS 选择器驱动，JS 只写属性

`<html>` 上设置 `data-theme="sakura|light|dark"` 与 `data-chat-font` / `data-chat-size` / `data-chat-weight` / `data-chat-leading`。样式里：

```
:root, [data-theme="sakura"]  { 现有色阶与 token }   (默认，缺省属性即此)
[data-theme="light"]          { 覆盖 sakura/tianyi/ink/base/surface 与派生 token }
[data-theme="dark"]           { 同上，色阶反相 + color-scheme: dark }
[data-chat-size="16"]         { --chat-font-size: 1rem }  ...
```

选择器用「属性选择器」而不是只写在 `:root`，是为了让设置页的主题预览卡在自身节点上设置 `data-theme` 就能显示该主题的真实配色，不必为预览另写样式。未知取值不匹配任何选择器，自然回落默认，所以非法值无需额外处理。

备选：运行时 JS 逐个 `setProperty`。否决：与首屏脚本重复列表，且预览卡无法复用。

### D3 首屏用 `index.html` 内联脚本

脚本同步读 `neko.appearance`，仅当字段是匹配 `/^[a-z0-9-]{1,16}$/` 的字符串时才写入对应 `data-*`（不校验取值列表，列表只在 `lib/appearance.ts` 一处维护，CSS 不认识的值等于默认），并在深色时把 `<meta name="color-scheme">` 设为 `dark`。全部包在 try/catch 内。样式表由 Vite 注入 `<head>` 且阻塞渲染，所以首绘前属性已就位。

`lib/appearance.ts` 是同一套偏好的唯一权威：定义取值常量、`parseAppearance`（逐项回落）、读写（try/catch，沿用 `open-workspace.ts` 写法）、`applyAppearance`（写 `dataset` 与 meta）。React 侧用 `useSyncExternalStore` 订阅内存快照 + `storage` 事件。

### D4 色阶方向：深色用「反相色阶」

沿用 token 名与档位语义——50 最淡、900 最浓——在深色主题里把「淡/浓」换成「相对背景的低/高对比」：`*-50..300` 是接近背景的深色调（气泡/卡片底），`*-700..900` 是浅色文字/强调。这样 `bg-sakura-100 text-sakura-800`、`text-ink-900` 等现有组合在深色下仍是「底色 + 可读文字」。主题取向（具体值实现时用对比度测试调到达标）：

| 主题 | 基调 | `base` / `surface` | 强调（占 sakura 位） | 辅色（占 tianyi 位） |
|---|---|---|---|---|
| 樱花 sakura | 蓝粉白，现状不变 | 近白 / 白 | 樱花粉 | 天依蓝 |
| 纸白 light | 中性冷灰白，克制 | `#fafafa` 系 / 白 | 靛蓝 | 青 |
| 夜墨 dark | 中性冷灰（参考 GitHub Dark / Tokyo Night，非纯黑） | `#0e1116` / `#161b22` | 柔和蓝紫 | 低饱和青 |

`ink-*` 在纸白里用冷灰（去掉紫调），在夜墨里反相为浅灰。夜墨的层级靠明度而非色相，边框与气泡底用低饱和灰蓝避免大面积彩色，代码高亮单独采用 GitHub Dark 的多色方案（`[data-theme="dark"] .hljs-*`），对比度仍由测试守护。

### D5 把硬编码色补成 token

新增并按主题覆盖：

- `--body-gradient`（页面背景渐变）、`--logo-gradient-stops`
- `--on-accent`（强调底色上的文字色；替换四处 `text-white`，暗色下可能是深色）
- `--highlight-inset`（按钮内高光）、`--mix-base`（替代 `color-mix(... white)` 的 `white`）
- `--shadow-tint-a` / `--shadow-tint-b`（阴影色调，深色下改为纯黑低透明度）
- `--overlay`（弹层遮罩）、`--color-diff-add` / 删除色
- `--diff-del`（删除色，避免在靛蓝主题里变成「靛蓝删除线」）、`--scrollbar` / `--scrollbar-hover`、`--focus-ring`（焦点环；樱花主题原先用 sakura-500，实测对白底仅 2.82:1，不满足 3:1，新 token 取略深的 `#d0728a`，其余主题沿用各自的 sakura-500 档）
- `color-scheme`：随主题写在选择器内（原生滚动条、表单控件、`accent-color`）

二维码的 `bg-white` 保留，保证可扫描。

### D6 聊天排版变量与作用范围

`.bubble-user`、`.bubble-assistant`、`.md` 与输入框 textarea 读取：

- `--chat-font-family`：无衬线 = `--font-sans`；衬线 = `"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", Georgia, serif`；等宽 = `--font-mono`。
- `--chat-font-size`：13 / 14 / 16 / 18px（`rem`）。
- `--chat-font-weight`：400 / 500 / 600；`strong` 与标题固定 700 以保持层级。
- 行高两档变量：`--chat-leading`（用户气泡与输入框：1.35 / 1.5 / 1.7，标准 = 现状，来自 Tailwind preflight 的 1.5）与 `--chat-leading-md`（`.md`：1.6 / 1.75 / 2.0，标准 = 现状 1.75）。

`.md` 里标题字号由 `rem` 改为相对 `em`（1.25rem/1.125rem/1rem → 约 1.43em/1.29em/1.14em，在 14px 下与现状等值），使其随字号缩放；行内代码已是 `0.85em`；代码块 `pre` 保持 `0.85rem` 与 `--font-mono` 不变，`.hljs` 与 diff 不受影响。工具卡、侧栏、设置页用 `rem` 的 `text-sm` 等，不受影响。

### D7 设置页：主题预览卡 + 档位 chips + 示例对话

页面 `/settings/appearance`：主题组为三张单选卡（`role="radiogroup"`，卡内用 `data-theme` 的迷你预览）；排版四项沿用上下文页的 chips 交互；下方示例对话复用真实 `.bubble-*` / `.md` / 代码块类，所以预览与实际一致。`SettingsShell` 的 `MENU` 在「上下文」后插入「外观」。

实现时发现设置菜单的 `Link` 默认前缀匹配，在 `/settings/appearance` 上会让「模型服务」（`/settings`）也带上 `aria-current`；给菜单 `Link` 加 `activeOptions={{ exact: true }}` 修正，使当前页高亮与 `aria-current` 唯一。

### D8 对比度测试

测试读取 `styles.css`，对每个主题块解析所需 token（hex/oklch → sRGB），断言关键色对：正文/气泡文字 ≥ 4.5、链接、徽章（`on-accent` 对 `*-700`）、hljs 各色对代码块底、diff 增删、焦点环 ≥ 3。用现有的 `layout-tokens.test.ts` 读 CSS 的方式；解析实现要容忍 `oklch()`，或在 CSS 里统一用 hex 给需要被测的 token。

## Risks / Trade-offs

- [深色下反相色阶与某些组件的「浅色专用」假设冲突，如 `bg-white`、`border-white`、`hover:bg-black/5`] → 实现时全量检索这类字面量，改为 token；二维码是唯一例外。
- [Tailwind 透明度写法如 `bg-sakura-100/50` 依赖 `color-mix`，与 token 覆盖是否兼容] → 实现第一步在两套新主题下构建并截图验证，不兼容则改用显式 token。
- [衬线/等宽字体取决于本机字体，不同平台观感不一致] → 设置页注明；栈末尾提供通用回退；不保证像素一致。
- [内联脚本与 `lib/appearance.ts` 的键名/结构漂移] → 键名与 `data-*` 属性名由测试对拍（读取 `index.html` 文本断言包含常量）。
- [`.md` 标题改相对单位可能让默认 14px 下出现 1px 级差异] → 用与现状等值的 em 值，并在测试里断言默认档计算结果。
- [对比度达标限制了配色自由度] → 主题取向由我定，具体值按测试调整，取向表不是最终色值。

## Migration Plan

纯前端、无数据迁移。默认主题与默认排版与现状一致，未保存偏好的用户看不到变化。回滚：移除菜单项与 `data-*` 样式即可，localStorage 里遗留的 `neko.appearance` 无害。

## Open Questions

- 三套主题的最终色值与预览卡细节留到实现阶段按对比度测试与截图微调，不影响规格与任务划分。
