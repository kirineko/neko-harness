# Tasks

## 1. 宽度常量与偏好 store

- [x] 1.1 在 `packages/web/src/client/lib/layout.ts` 用 `SIDE_PANEL_WIDTH`（min 320 / max 960 / initial 560 / step 24）和 `clampSidePanelWidth` 取代 `WORKSPACE_WIDTH` / `clampWorkspaceWidth`；更新 `web/test/workspace-helpers.test.ts`，运行该测试通过，并确认仓库内再无旧名称引用（`rg WORKSPACE_WIDTH`）
- [x] 1.2 新增 `lib/panel-width.ts`：`PANEL_WIDTH_KEY = "neko.panelWidth"`、`parsePanelWidth`、可注入 storage / target 的 `createPanelWidthStore`（`get` / `set` / `commit` / `reset` / `subscribe`、`storage` 事件同步、读写 try/catch）与 `usePanelWidth()`；新增 `web/test/panel-width.test.ts` 覆盖缺失 / 非数字 / 越界 / 小数输入、`set` 不写盘而 `commit` 写盘、`reset`、跨"标签页"事件同步、storage 抛错时仍可内存生效

## 2. 共用调整柄

- [x] 2.1 新增 `components/resize-handle.tsx`：separator 语义与 `aria-value*`、指针拖拽（`innerWidth - clientX`，夹到 `min(max, 60vw)`）、body 的 `is-resizing-panel` 类、`pointerup` / `pointercancel` / `lostpointercapture` / 卸载统一收尾并 `onCommit`、键盘 ←/→/Home/End、双击重置；在 `styles.css` 添加柄的 hover / 聚焦 / 拖拽样式与 `body.is-resizing-panel`（只用 token）
- [x] 2.2 新增 `web/test/resize-handle.test.tsx`（JSDOM，参照 `workspace-sidebar.test.tsx`）：键盘各键与边界、`aria-valuenow` 更新且按键不冒泡到面板 Esc/Tab、指针拖拽实时 `onChange` 与松手 `onCommit`、取消 / 丢失捕获后不再响应、双击重置、拖拽期间 body 类添加与清除（含卸载）
- [x] 2.3 在 `i18n/zh.ts` / `en.ts` 把 `wspanel.resize` 换成通用的 `panel.resize`（中文"调整面板宽度"，英文"Resize panel"），确认字典测试与 CJK 扫描通过

## 3. 接入三个面板

- [x] 3.1 `workspace-panel.tsx`：删除内联拖拽 / 键盘逻辑与 `width` / `onWidth` props，改用 `usePanelWidth()` 与 `<ResizeHandle />`；`chat-page.tsx` 删除 `workspaceWidth` 状态；运行现有工作区栏相关测试通过
- [x] 3.2 `job-panel.tsx` 与 `subagent-panel.tsx`：根元素改为 `lg:relative lg:w-[var(--panel-w)] lg:max-w-[60vw] lg:shrink-0` 并设置 `--panel-w`，挂载 `<ResizeHandle />`；三个面板用同一份宽度，测试验证改一处宽度其余同步、窄屏（≤1023px）无柄
- [x] 3.3 在 1024 / 1440 / 1920 宽度下手动检查：三个面板切换时宽度不跳动、拖拽平滑、60vw 上限生效、刷新后保持、双击恢复；在 375 / 768 下确认抽屉 / 全屏无柄且无横向溢出；三套主题下柄的状态线可见

## 4. 文档与整体验证

- [x] 4.1 更新 `AGENTS.md` Web 小节：三个右侧面板共用宽度、`neko.panelWidth` 存浏览器本地、不经 gateway、不涉及协议版本；核对与实现一致
- [x] 4.2 运行 `bun run check` 与 `bun run test`，全部通过

## Workflow follow-up

- 评审通过后归档本变更（`openspec archive`），确认主 spec 合并了 `web-ui` 的 delta。
