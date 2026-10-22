# Proposal

## Why

Web 右侧有三个面板（工作区、后台任务 jobs、子 agent）共用同一个位置，但只有工作区栏能拖拽调宽，且宽度只在内存里，刷新就丢。jobs 与子 agent 面板宽度写死为 `min(42vw, 40rem)`，用户看长输出、长对话或宽 diff 时无法拉宽，想给对话区让出空间时也无法收窄。

## What Changes

- jobs 与子 agent 面板支持与工作区栏相同的左右拖拽调宽，三个面板**共用同一个宽度**：切换面板时位置和宽度不跳动。
- 抽出共用的 `ResizeHandle` 组件（ARIA separator）：指针拖拽、键盘 ←/→（步进）与 Home/End（最小/最大）、双击恢复默认宽度；拖拽期间禁用文本选中并固定 `col-resize` 光标，hover/聚焦/拖拽时显示一条可见的细线。
- 宽度保存到浏览器 `localStorage`（`neko.panelWidth`），刷新和新开标签页保持；读取时逐项校验并回落默认值，跨标签页通过 `storage` 事件同步。不经 gateway，**不涉及契约或应用协议版本**，不影响 TUI / 移动端。
- 宽度范围统一为 320–960px，默认 560px（原工作区默认 480、最大 720，jobs/子 agent 约为视口 42%）；任何情况下面板不超过视口 60%，保证对话区仍可用。窄屏（≤1023px）仍是抽屉/全屏，不显示拖拽柄、不使用该宽度。
- 清理：移除 `WORKSPACE_WIDTH` / `clampWorkspaceWidth`，由统一的侧栏宽度常量替代；`chat-page` 不再持有 `workspaceWidth` 状态；`wspanel.resize` 文案换成通用的面板调宽文案（中英文）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `web-ui`: 新增"右侧面板可调宽"与"面板宽度记忆"要求，覆盖工作区、后台任务、子 agent 三个面板；现有"工作区栏的响应式与可访问性"（可调宽、有上下限）保持有效，新要求把它扩展到另外两个面板。

## Impact

- `packages/web/src/client/components/`：新增 `resize-handle.tsx`；改 `workspace-panel.tsx`、`job-panel.tsx`、`subagent-panel.tsx`（宽度类、`lg:relative`、挂载拖拽柄）。
- `packages/web/src/client/lib/`：`layout.ts` 常量替换；新增 `panel-width.ts`（校验、存取、store、hook）；`i18n/{zh,en}.ts`。
- `packages/web/src/client/pages/chat-page.tsx`：删除 `workspaceWidth` 状态与 props。
- `packages/web/src/client/styles.css`：拖拽柄和拖拽态样式（使用 token）。
- 测试：`web/test/workspace-helpers.test.ts` 改为新常量；新增 `panel-width.test.ts`、`resize-handle.test.tsx`；`layout-tokens.test.ts` 视需要对拍 CSS 中 60vw 上限。
- 文档：`AGENTS.md` 的 Web 小节补充面板宽度偏好。
