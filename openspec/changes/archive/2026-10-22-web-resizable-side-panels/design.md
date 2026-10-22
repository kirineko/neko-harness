# Design

## Context

- 三个右侧面板（`WorkspacePanel`、`JobPanel`、`SubagentPanel`）由 `chat-page.tsx` 并列挂载，共用右侧同一位置、同一时刻只开一个。
- 只有 `WorkspacePanel` 有调宽：`role="separator"` + 指针捕获 + 键盘，宽度是 `chat-page` 里的 `useState`（`WORKSPACE_WIDTH`：320–720、默认 480、步进 24），经 `style="--workspace-w"` 与 `lg:w-[var(--workspace-w)] lg:max-w-[60vw]` 生效，刷新即丢。
- `JobPanel` / `SubagentPanel` 使用固定 `lg:w-[min(42vw,40rem)]`，且根元素是 `lg:static`（调整柄绝对定位需要 `relative` 锚点）。
- 浏览器本地偏好已有成熟模式：`lib/appearance.ts`（逐项校验、可注入 storage 的 store、`storage` 事件跨标签页同步、`useSyncExternalStore`），以及 `neko.openTarget`、`neko.fileZoom` 等单值键。
- 该变更纯前端，不经 gateway，**不改动契约版本与应用协议版本**。

## Goals / Non-Goals

**Goals:**

- 三个面板共用一个可调宽度，拖拽与键盘体验一致，刷新保持。
- 把调整逻辑做成一份共用代码，避免三处复制。

**Non-Goals:**

- 不重构三个面板的焦点陷阱、`inert`、窄屏判断等重复代码（另行处理）。
- 不为各面板分别记忆宽度；不做面板内部分栏（如子 agent 列表与详情）的拖拽。
- 不改变窄屏抽屉行为，不改变面板互斥与自动打开规则。

## Decisions

### D1：一个共享宽度，而不是每个面板各自一份

三个面板互斥且占据同一位置，各存各的会使切换面板时内容区"跳动"，也要三份键与状态。共享宽度只需一个 store。

- 替代方案：分别记忆。子 agent 内容更宽、工作区文件树更窄，确有差异，但切换跳动的代价更高；用户已选择共用方案。

### D2：宽度常量与范围

在 `lib/layout.ts` 用 `SIDE_PANEL_WIDTH = { min: 320, max: 960, initial: 560, step: 24 }` 取代 `WORKSPACE_WIDTH`，`clampSidePanelWidth` 取代 `clampWorkspaceWidth`。

- 上限从 720 提到 960：子 agent 对话与 diff 需要更宽；真正的屏幕边界由 CSS 的 `max-w-[60vw]` 兜底。
- 默认 560：介于原工作区 480 与 jobs/子 agent 在常见视口下的约 600px 之间，三类内容都能舒适阅读。
- 步进沿用 24。

### D3：`lib/panel-width.ts` 作为唯一权威

仿照 `appearance.ts`：

- `PANEL_WIDTH_KEY = "neko.panelWidth"`，值为整数字符串。
- `parsePanelWidth(raw)`：缺失 / 非有限数 / 非整数文本回落默认；越界夹到边界。
- `createPanelWidthStore({ storage, target })`：`get()`、`subscribe()`、`set(width)`（仅更新内存并通知，用于拖拽中）、`commit()`（写入 storage，调整结束时调用）、`reset()`（回到默认并写入）；监听 `storage` 事件同步其他标签页；`storage` 抛错（隐私模式、禁用）时静默忽略，仅内存生效。
- `usePanelWidth()`：`useSyncExternalStore` 包装，返回 `{ width, set, commit, reset }`。
- 拖拽中只改内存、松手才写 storage，避免每帧写盘并触发其他标签页频繁更新；键盘、双击、Home/End 每次即 `set + commit`。

### D4：`ResizeHandle` 共用组件

`components/resize-handle.tsx`，props：`width`、`onChange`、`onCommit`、`onReset`、`label`（`t("panel.resize")`）。

- 结构：沿用现有 `role="separator"`、`aria-orientation="vertical"`、`aria-valuemin/max/now`、`tabIndex=0`，`absolute inset-y-0 -left-1 w-2 hidden lg:block cursor-col-resize touch-none`，需要面板根为 `relative`。
- 指针：`onPointerDown` 捕获并记录 pointerId、给 `<body>` 加 `is-resizing-panel`；`onPointerMove` 用 `window.innerWidth - clientX`（面板贴右缘）并同时夹到 `min(max, 0.6 * innerWidth)`；`onPointerUp` / `onPointerCancel` / `onLostPointerCapture` 统一走 `end()`：清 pointerId、移除 body 类并 `onCommit()`；组件卸载时也清理 body 类。
- 键盘：←加宽、→收窄（`step`），Home/End 最小/最大，均 `preventDefault` + `stopPropagation`，避免触发面板的 Esc/Tab 处理或页面滚动。
- 双击：`onDoubleClick={onReset}`。
- 视觉：柄本体透明，hover / `:focus-visible` / `[data-dragging]` 时中心 2px 线使用 `--color-sakura-300`（token，三主题共用），不使用字面量色。
- 样式：`styles.css` 增加 `body.is-resizing-panel { user-select: none; cursor: col-resize; }` 以及柄的状态样式。

### D5：面板侧改动

- 三个面板根元素统一为 `fixed inset-0 ... lg:relative lg:z-auto lg:w-[var(--panel-w)] lg:max-w-[60vw] lg:shrink-0`，`style={{ "--panel-w": `${width}px` }}`；`JobPanel` / `SubagentPanel` 的 `lg:static` 改 `lg:relative`。
- 面板自己调用 `usePanelWidth()`，`chat-page` 不再传 `width` / `onWidth`，也删掉 `workspaceWidth` 状态。
- 每个面板在根元素内渲染 `<ResizeHandle />`，位置与现有一致。
- 窄屏沿用 `hidden lg:block` 隐藏柄；固定全屏尺寸不受影响。

### D6：不引入能力探测，不改契约

纯前端偏好，无兼容问题；也无需升级契约或应用协议版本。

## Risks / Trade-offs

- [宽度叠加侧栏后主聊天区过窄：在 1024px 视口，打开侧栏再把面板拉到 60vw 时聊天区仅约 150px] → 沿用既有 60vw 上限，侧栏可折叠；如后续需要，可把上限改为 `min(60vw, 100vw - 侧栏宽 - 最小聊天区宽)`。
- [共享宽度让原本偏好较窄的工作区栏变宽（默认 480 → 560）] → 可拖拽、双击恢复默认；默认值取折中。
- [`lg:static` → `lg:relative` 可能影响 z-index/定位] → 根元素本就在 flex 行内，`relative` 不位移；用手动检查 1024 / 1440 / 1920 三档确认。
- [拖拽期间指针移出窗口或被浏览器取消] → 捕获 + `lostpointercapture` + 卸载清理，确保 body 类不残留；测试覆盖。
- [本地存储被禁用] → 所有读写 try/catch，退回内存。

## Migration Plan

- 无数据迁移。旧版本没有保存宽度，读取不到时使用默认值。
- 可直接发布；回滚后 `neko.panelWidth` 键被忽略，无副作用。
