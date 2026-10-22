# Design

## Context

- 工作区登记在 `app.neko.workspaces` 文档（`{ items: NekoWorkspace[] }`，挂在根会话上），只有 `registerWorkspace` 一个写入口，经 `addWorkspace`（显式，校验可访问）与启动/分叉的隐式路径（`savedWorkspace`）调用。
- 登记会被四个来源再次写入：
  1. `createRuntime` 启动时遍历所有已有会话（含已归档）与根会话，登记它们的 cwd；
  2. `forkConversation` 登记源会话 cwd；
  3. `createConversation` 经 `addWorkspace(cwd ?? defaultCwd)` 登记；
  4. Web 客户端首次连接时对 `info.workspaceRoot`（Web 启动目录）调用 `workspaces.add`（`GatewayConnection.#connect`）。
- 目录广播：`server-services.ts` 监听提交，`app.neko.workspaces` 变化时同时重算会话目录与工作区状态（`workspaceState.replace`）；移动端 `workspaces.changed` 与 `PrefKeys.workspace` 回退逻辑已处理"选中工作区消失"，无需改动接口。
- Web 会话列表按 `workspaceSessions(state.sessions, state.workspaceRoot)` 过滤；切换由 `GatewayConnection.selectWorkspace/#select` 完成，`#reconcile` 只处理"当前会话消失"。
- 用户已明确：不考虑与旧网关的兼容；需要升级契约版本时统一升级。

## Goals / Non-Goals

**Goals:**

- 提供非破坏性的"移除工作区"，全端目录一致，重启后保持移除，重新添加可恢复会话。
- Web 提供清晰的 UI/UX：发现性、防误触、触屏可用、可访问、中英文齐全。

**Non-Goals:**

- 不删除宿主文件，不归档/删除会话数据；不提供"移除并归档会话"。
- 不在 TUI / 移动端新增移除入口（二者只需继续正确响应目录变化）。
- 不引入 Web 与网关的能力探测或旧网关降级路径。
- 不实现撤销（重新添加即恢复）。

## Decisions

### D1：用独立的"已移除路径"文档做墓碑，而不是在 items 上打标记

新增 `app.neko.workspaces-removed`（`{ paths: string[] }`，`scope: "conversation"`、`history: "latest"`，同根会话），与 `WorkspacesDoc` 在同一次 `harness.commit` 里一起修改。

- 理由：不改动 `WorkspacesDoc` 的形状与版本，避免文档迁移；读取旧存储时新文档取 `initial()`（空列表）即可，无需迁移代码。
- 替代方案：在 `NekoWorkspace` 上加 `removedAt`。否则 `listWorkspaces()`、契约 `WorkspaceSummarySchema` 与所有调用方都要区分，改动面更大。
- 替代方案：仅在 items 中删除并让启动扫描只在文档为空时运行。无法覆盖分叉与 Web 启动目录，且无法区分"从未登记"和"已移除"。

### D2：登记分显式与隐式两条路径

- `registerWorkspace(path, { explicit })`：显式（`addWorkspace`、带 cwd 的 `createConversation`、网关启动时的 `defaultCwd`）在同一提交内把路径从墓碑里去掉再登记；隐式（启动扫描会话 cwd、`forkConversation`）遇到墓碑中的路径直接跳过，不写入。
- 启动时 `defaultCwd` 视为显式：用户从该目录启动 neko，就是要在此工作。
- 路径比较沿用现有规范化后的真实路径字符串。

### D3：`removeWorkspace(path)` 在 core 完成校验与提交

顺序：规范化路径 → 校验已登记（否则 `WORKSPACE_UNKNOWN:`）→ 校验不是最后一个（`WORKSPACE_LAST:`）→ 校验该路径下的非归档会话无活动（`SessionMetadataDoc.status === "running"`、`awaiting`、`awaitingPlan`，否则 `WORKSPACE_BUSY:`）→ 单次提交里删除 item 并加入墓碑。前缀沿用 `CODE: 文案`，网关原样透传，前端经 `core-text` 映射成当前语言（同步 `core-ui-strings` fixture 与测试）。

- 校验与提交放在 core 而非网关，使各前端与未来入口共用同一规则；网关侧用现有 `serialize` 串行化它与 `add`。

### D4：被移除工作区的会话在 core 的会话目录里就被过滤

`listConversations()` 跳过 cwd 在墓碑中的会话，网关的会话目录、移动 API、Web 都自然看不到它们；而不是让每个前端各自按工作区列表过滤。恢复靠"重新显式添加"清掉墓碑，下一次目录刷新即还原。

- 代价：被隐藏会话仍可经已知 id 的 `getConversation` 访问（TUI `--resume <id>` 等）。这不构成泄露，本变更不处理。

### D5：契约与协议版本统一升级

`NekoWorkspaces` 契约 `version: 1 → 2`，新增方法 `remove: rpc({ path }, null)`（输出沿用现有风格，返回 `nil`）；`APPLICATION_PROTOCOL` `8 → 9`。不做能力探测：旧网关与新客户端按现有"应用协议兼容检查"被拒绝，提示更新或重启。所有引用常量的测试自动跟随；`AGENTS.md` 中"应用协议 8"与"网关"小节同步更新。

- 理由：用户明确不需要兼容；统一升级避免"契约版本升了但协议没升"的半兼容状态。

### D6：Web 启动目录在 UI 层不可移除

Web 已有 `info.workspaceRoot`（`/api/info`），首次连接必对其 `add`。允许移除只会在刷新后自己回来，语义混乱，所以 UI 置灰并说明；网关层仍只执行 D3 的通用规则（不知道某个 Web 的启动目录），其他客户端移除了它，Web 下次加载仍会因显式 `add` 把它加回——这是"从该目录启动即显式登记"的既定语义。

### D7：Web UI 结构与交互

- `session-list.tsx` 的工作区选项由单个 `<button class="workspace-option">` 改为 `div.workspace-row`：内含主按钮（切换，保留原有布局、`title`、✓ 与 `is-active`）和 `button.icon-btn.row-remove`（`trash` 图标，`aria-label` 含目录名）。复用现有 `session-row` / `row-more` 的 hover/`:focus-within` 显示模式，并在 `@media (pointer: coarse)` 下常驻。
- 不可移除项：按钮 `disabled` 并设 `title` / `aria-describedby` 说明（启动目录 / 至少保留一个）；不用隐藏，保证行对齐一致、可朗读。
- 点击后关闭 Popover，打开 `Modal`（复用归档确认的 `confirm-body` 结构）：标题"移除工作区"，正文为名称、完整路径（`path-text`）、三句说明（不删除文件 / 会话被隐藏 / 重新添加可恢复）与将被隐藏的非归档会话数（取自 `state.sessions`）。按钮：取消 / 移除（危险色 token，不使用字面量色）。提交期间 `locked`；失败在框内 `role="alert"` 显示映射后的原因。
- `appActions.removeWorkspace(path)` → `GatewayConnection.removeWorkspace`：在 `#operate` 内调用 `workspaces.remove`；若移除的是当前工作区，先选目录中的下一个（用移除前的列表排除自身，取第一个），再提交移除；失败则不切换。
- 外部移除：`workspaces.state.subscribe` 里，若 `#workspace` 已不在目录中，通过 `#operate` 选择目录中的第一个工作区（与 `#reconcile` 同一风格，失败走 `#error`）。
- 文案：`zh.ts` / `en.ts` 同时新增（按钮、确认框、原因说明、`core-text` 映射），英文遵循"简短、首字母大写、句末无句号"，CJK 扫描白名单无需新增。
- 样式：全部使用 token，三套主题共用；危险按钮复用现有 error/sakura 强调色 token，由 `theme-contrast.test.ts` 的对比度约束覆盖。

### D8：移动端与 TUI

- 移动端：保持现状。`workspaces.changed` 触发 `loadWorkspaces`，选中的工作区若消失会回退到保存值或第一项。本变更只补验证用例，不改 Dart。
- TUI：无工作区切换器，不受影响；TUI 启动在被移除目录时按 D2 显式登记。

## Risks / Trade-offs

- [被隐藏的会话在存储中长期留存] → 非破坏性是有意选择；重新添加可恢复，空间占用不处理。
- [用户误以为"移除"会删除数据] → 确认框明确说明，并显示被隐藏会话数；按钮文案用"移除"而非"删除"。
- [墓碑与登记不一致（并发）] → 两者同一次提交修改，网关用 `serialize` 串行化 add/remove。
- [隐式登记漏掉某个来源导致复活] → 所有登记入口集中在 `registerWorkspace`，用测试覆盖启动扫描、分叉、新建、Web 启动目录四个来源。
- [Web 启动目录不可移除让用户困惑] → 置灰并给出原因，而不是隐藏。
- [协议升级使旧网关不可用] → 用户已接受；沿用兼容检查的更新/重启提示。

## Migration Plan

- 存储：无迁移。新文档缺省为空，旧存储行为与原来一致。
- 发布：一起升级网关与各端；旧版本连接会得到"协议不兼容"提示。
- 回滚：回退版本后墓碑文档被忽略，已移除的工作区会在启动扫描时重新登记，无数据丢失。
