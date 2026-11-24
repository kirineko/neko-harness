# Design

## Context

动机与范围见 `proposal.md`，外部行为契约见 `specs/` 下三个增量规格。当前代码库在 `1.5.0` 下的关键约束如下：

- **网关完全构建在已删除的 Chord v1 之上**：`packages/gateway/src/{contract,gateway,server-services,session-host,subagent-host,link,unix-link,client-session,subagent-client,approval-queue}.ts` 与 `mobile/{admin,listener,adapter}.ts` 使用 `hostNamed`、命令式 `host.serve`、支持可选字段的契约 `input`、以 `"state"` 命名的状态/方法成员、`local` + `opaque()` 进程内引用传递、JSON `Frame` 链路、`invalidatePrincipal(match)`，以及引用上的 `.ready` / `.onStatus` / `member.subscribe(fn)`。Chord v2（`1.6.0` 的 `@earendil-works/chord` 根导出）将上述接口全部重写。
- **跨包导入与严格依赖边界**：pnpm 严格 `node_modules` 下各包只能导入自身声明的依赖；`Context` 在 `1.6.0` 从 `@earendil-works/chord` 根导出移至 `@earendil-works/chord/context`（涉及 `core` 与 `gateway` 约 23 个文件）；发布打包脚本 `scripts/build-release.ts` 保持外部依赖干净，不能引入 Chord 可选的 `/plugins` 或 `/workers`（会拉入 `esbuild` 运行时依赖）。
- **Core 与 TUI 的 `1.6.0` 类型与目录变化**：`pi-durable` 的 `Tool.execute()` 返回类型变为 `ToolExecutionResult | ToolPark`；`pi-ai` 内置纯 API-Key provider 由 32 个增至 33 个，并为 Qwen Token Plan 拆分了按套餐区分的首选环境变量（保留旧共享变量作为回退）；`pi-tui` 的 `Component.render(width)` 返回 `readonly string[]` 且 `Container` 缓存渲染数组。
- **会话等待机制现状**：`ask_user`、`plan` 审批、`tool-approvals` 与 `subagent` 等待目前通过进程内 Promise 挂起、`watchDoc` / `observeCommits` 监听或 `setTimer` 轮询实现。`pi-durable@1.6.0` 原生提供了 Signals 与 Tool Parking，但若与 Chord v2 传输重写同批落地，一旦出现回归将难以区分是链路复制问题还是持久化任务状态机问题。

## Goals / Non-Goals

**Goals:**

- 在不改变业务语义、移动端 JSON-RPC v1 协议与 SQLite 表结构的前提下，完成全部 `@earendil-works/*` `1.6.0` 升级与 Chord v2 迁移，`pnpm check`、`pnpm build`、`pnpm test`、`pnpm build:release` 全部通过。
- 固化本次升级完成后的下一阶段原生 Signals / Tool Parking 重构蓝图，明确四条等待链路的目标映射与不变量，使后续变更可直接按图实施。

**Non-Goals:**

- 本次变更内不改写 `ask_user`、`plan`、`tool-approvals`、`subagent` 的持久化任务等待实现（归入紧随其后的独立变更，见 D9）。
- 不调整 `ChatView` 的消息载荷结构、不改动 `apps/mobile` Dart 代码、不采纳 `@earendil-works/pi-durable/images/fit` 或按会话压缩覆盖。

## Decisions

### D1. 全量精确锁 `1.6.0` 与 `Context` 子路径对齐

根 `package.json` 与 `packages/{core,gateway,tui,web}/package.json` 中的 `chord`、`pi-ai`、`pi-codemode`、`pi-durable`、`pi-env`、`pi-schema`、`pi-tui` 统一精确锁定为 `1.6.0`，刷新 `pnpm-lock.yaml` 并确认依赖树无多版本并存。所有从 `@earendil-works/chord` 导入 `Context` 的源码与测试统一改为 `@earendil-works/chord/context`。不使用 `@earendil-works/chord/plugins` 或 `/workers`，避免将可选 peerDependency `esbuild` 引入运行时。

替代方案：保留部分包在 `1.5.0`——不可行，`pi-durable@1.6.0` 与 `pi-env@1.6.0` 直接依赖 `@earendil-works/chord@1.6.0`，混用会产生两套不兼容的 `Context` 与 Chord 实例。

### D2. Chord v2 宿主寻址、单 Facet 激活与权限吊销

- **寻址**：以 `export const GatewayKind = hostKind("neko")`（注意 `"client"` 在 v2 中为保留字）和 `export const GATEWAY_ADDRESS = GatewayKind()` 取代 `GATEWAY_HOST` / `hostNamed`。所有远程契约统一声明 `hostAddress: () => GATEWAY_ADDRESS`。
- **服务端激活**：Chord v2 移除了宿主上的直接 `serve()` 与 `ready()`，改为通过 `defineFacet<GatewayPrincipal>((host) => { ... })` 注册服务并调用 `await chord.load([{ name: "@neko-harness/gateway", facet }], context)` 激活（插件名必须是合法 npm 包名）。`NekoMobileAdmin` 原先在 `MobileGateway.create` 之后单独注册，迁移后通过可变持有器在同一个 Facet 中一并声明，避免二次 `reload`。
- **客户端就绪**：客户端宿主在 `createHost` 后必须先完成 `await host.load([], BACKGROUND_CONTEXT)` 才能执行 `host.connect`、`host.get` 或 `host.hold`（否则同步抛 `not_ready`）。在 `createGatewayConnection` 中将 `load([])` 与 `connect(link, { principal: { kind: "server" } }, BACKGROUND_CONTEXT)` 纳入内部初始化序列，`ready()` 与后续获取引用的入口统一等待该初始化完成。
- **权限吊销与错误上报**：`HostOptions` 配置 `principalKey: gatewayPrincipalKey` 与 `revokedBy: (p) => p.kind === "mobile" ? ["mobile:all", "device:" + p.deviceId, "grant:" + p.deviceId + ":" + p.grantRevision] : []`；`MobileGateway` 吊销全部移动连接、单台设备或旧授权版本时调用同步的 `chord.revoke(key, context)`（全设备吊销用 `"mobile:all"`，单设备用 `"device:<id>"`，按修订精确吊销时对被淘汰的修订键或连接逐一处理），彻底取代 `invalidatePrincipal(match)`。`HostOptions.onError` 收到的结构化 `HostError` 转换为 `Error` 实例再转交调用方。

替代方案：在 `MobileGateway.create` 后调用 `chord.reload` 追加 `NekoMobileAdmin`——会产生不必要的插件重装周期，用持有器单次 `load` 更直接。

### D3. 远程契约成员重命名、扁平必填 `params` 与方法签名调整

Chord v2 对契约声明新增了三项编译期/声明期约束，统一按以下规则迁移：

1. **重命名保留成员 `state`**：v2 引用自身占用 `then`、`release`、`variant`、`state`、`retry` 五个属性名。将 `NekoSessionDirectory`、`NekoWorkspaces`、`NekoCredentials`、`NekoSearchSettings`、`NekoContextSettings`、`NekoCodemodeSettings`、`NekoDefaultModel` 七个契约的状态成员名统一从 `state` 改为 `snapshot`；将 `NekoMobileAdmin` 的方法 `state` 改为 `status`。同步更新 `client-session.ts`、`web`、`tui`、`mobile/adapter.ts` 与测试中的读取位置。
2. **扁平必填原语 `params`**：无参契约声明 `params: {}`；`NekoChat`（`{ sessionId: str(), attachmentId: str() }`）与 `NekoMobileAdmin`（`{ token: str() }`）本就满足扁平必填原语；`NekoSubagent` 原含可选字段 `{ taskId?: int, agentId?: str }`，改为 `{ sessionId: str(), attachmentId: str(), target: str() }`，其中按 agent 查看编码为 `"agent:" + agentId`、按轮次查看编码为 `"round:" + taskId`，服务端在边界解析并校验格式。
3. **封闭方法入参与无参调用**：Chord v2 的 `snapshotArguments` 要求方法入参对象 schema 为封闭对象（`additionalProperties: false`），因此契约方法入参中的 `obj(...)` 去掉 `{ open: true }`，而状态快照与方法返回值继续保留既有 schema 形状；同时参数为 `nul()` 的方法在 v2 中签名为 `(ctx?: Context) => Promise<R>`，各端移除原先传入的 `null` 占位实参。

替代方案：把 `NekoSubagent` 拆成两个独立契约（按 agent 与按 round）——二者成员与投影逻辑完全一致，用带前缀的必填字符串 `target` 既满足 v2 原语约束又避免契约翻倍。

### D4. 去除 `opaque()` 与进程内状态管理

Chord v2 删除了 `opaque()`。原先网关声明 `Owner`、`Projection`、`ChildProjection`、`ServerState` 四个 `local` 契约只是为了借 `opaque()` 在同一宿主的不同 `serve` 块之间共享进程内对象。在单进程网关的 Facet 作用域内，直接以闭包内的类型化 `Map` 管理共享资源：

- 按 `gatewayPrincipalKey(principal)` 维护当前连接的活跃附着记录（取代 `Owner`），在 `detach`、切换 `attach` 或对象关闭时清理；
- 按会话 ID / 子任务键维护引用计数的 `SessionProjection` 与 `ChildProjection` 实例，配合 `self.open(openFn, closeFn)` 绑定远程服务实例生命周期（取代 `self.resource`）；
- 状态发布统一使用 `const w = self.writable(initial); const view = self.derive([w], ([v]) => v);`：该写法同时支持对象状态与标量状态（如 `NekoChat.revision: int()`），外部事件回调（`follow()`、`onCommits`、`UpdateChecker`）可直接调用 `w.set(next)`，由 Chord 自动计算增量 diff 下发客户端。

替代方案：使用 `defineState` 持久化状态句柄——网关自身的投影状态全部派生自 `core` 的 SQLite 会话存储，无需在 Chord 层再维护草稿事务，且 `defineState` 要求根类型为 JSON 对象，无法直接表达标量 `revision`。

### D5. 二进制 `Link`、有界缓冲与握手期协议不兼容识别

```text
  TUI / CLI                 Gateway                 Browser / Windows TUI
+-----------+             +---------+             +-----------------------+
| UnixLink  | <=========> |         | <=========> | boundedWebSocketLink  |
| 4B UInt32 |  Uint8Array | Chord v2|  Uint8Array | binary ArrayBuffer    |
| + payload |  (proto=1)  |  Host   |  (proto=1)  | + MAX_LINK_BYTES 守卫 |
+-----------+             +---------+             +-----------------------+
```

- **`UnixLink`（`packages/gateway/src/unix-link.ts`）**：直接实现 v2 `Link`（`send(Uint8Array)`、`onMessage`、`close()`、`onClose`），在线路上按「4 字节大端无符号长度 + 原始 `Uint8Array` 负载」分帧，校验单帧上限 `MAX_LINK_BYTES` 与待发缓冲上限，去掉原先的 UTF-8 JSON 解析与伪 WebSocket 适配层。
- **`boundedWebSocketLink`（`packages/gateway/src/link.ts`）**：直接基于底层 socket 实现 v2 `Link`（不再中转 `webSocketLink` 以避免 Node `ws` 与浏览器 `WebSocket` 在 `Buffer` / `ArrayBuffer` 事件形态上的差异）：仅接受二进制帧（收到文本帧或超限帧立即关闭连接），保留进站字节上限与出站 `bufferedAmount` 上限守卫。
- **应用协议递增与握手拒绝映射**：`APPLICATION_PROTOCOL` 由 `10` 递增至 `11`。当旧版（如 `1.5`）对端发送文本 JSON 握手帧或不同协议号的二进制握手帧时，链路会在首个应用信息读取完成前关闭或触发 `protocol_error`；`client-session.ts` 在 `ready()` 尚未拿到 `NekoApplicationInfo` 前若观察到链路关闭或底层协议错误，统一拒绝为 `ApplicationProtocolError`，确保前端立即给出升级/重启提示而不进入重连循环。
- **移动入口隔离**：`MobileGateway` 暴露给手机端的是独立 HTTPS/WSS JSON-RPC v1（`mobile/protocol.ts`），进程内通过 `MobileAdapter` 消费网关服务，手机端协议版本与报文格式保持 100% 不变。

### D6. 客户端 `Watchable` 同步订阅辅助封装

Chord v2 将引用状态成员改为 `Watchable<T>`（同步读 `.value`，异步 `watch(ctx)` 返回 `WatchHandle<T>`），移除了同步 `.subscribe(fn)`；引用自身状态由 `ref.state`（`NativeWatchable<RefState>`）暴露。

在 `@neko-harness/gateway` 中提供内部及客户端共用的薄辅助函数 `subscribeState<T>(watchable: Watchable<T>, listener: (value: T) => void): () => void`（以及针对 `NativeWatchable` 的 `subscribeNative`）：内部创建绑定于连接/组件生命周期的 `AbortController` 启动 `watch(ctx)`，在打开时与每次 `call.kind === "value"` 时幂等触发回调，返回的取消函数同步触发 `abort()` 并屏蔽后续回调。这样 `client-session.ts`、`subagent-client.ts`、`approval-queue.ts`、`web`、`tui` 与测试中的约 35 处订阅点只需最小化替换，无需在每处 UI 组件手写异步清理竞态保护。

### D7. Core 工具停放类型窄化与 Provider 目录回退变量支持

- **工具包装器窄化**：`packages/core/src/nested-changes.ts` 包装 `edit` / `write` 时，对 `await inner.execute(...)` 的返回值先判断是否为 `ToolPark`（如 `!("content" in result)` 或按停放结构判断，附注释说明上游返回联合形状），若为停放则原样返回，仅在 `ToolExecutionResult` 分支读取 `result.isError` 记录改动。
- **Provider 目录与回退环境变量**：
  - `packages/core/src/credential-providers.ts` 的 `MODEL_PROVIDERS` 扩充至 33 项：新增 `qwen-token-plan-individual-cn`（`"Qwen Token Plan Individual CN"`，首选 `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY`），并将 `qwen-token-plan`、`qwen-token-plan-cn`、`qwen-token-plan-individual` 的名称与首选 `envVar` 更新为 `pi-ai@1.6.0` 定义的 `QWEN_TOKEN_PLAN_TEAM_API_KEY`、`QWEN_TOKEN_PLAN_TEAM_CN_API_KEY`、`QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY`。
  - 在 `CredentialProviderSpec` 上增加可选字段 `readonly fallbackEnvVars?: readonly string[]`（上述四个 Qwen 条目分别填入 `["QWEN_TOKEN_PLAN_API_KEY"]` 或 `["QWEN_TOKEN_PLAN_CN_API_KEY"]`）。`runtime.ts` 的 `credentialStatus()` 检查 `[spec.envVar, ...(spec.fallbackEnvVars ?? [])]` 中任一非空环境变量即判定 `environmentConfigured = true`，与 `pi-ai` 的 `models.checkAuth()` 行为严格一致；前端仍只展示首选 `spec.envVar` 保持界面简洁。

### D8. `pi-tui@1.6.0` 只读渲染结果适配

`pi-tui@1.6.0` 将 `Component.render(width)` 返回值改为 `readonly string[]`，且 `Container.render()` 直接复用缓存数组。`packages/tui/src/components/history-image.ts` 在 `measure` 与 `render` 中需要向不足 8 行的回退渲染结果补空行时，改为先复制 `const lines = [...base.render(width)]` 再追加；其余自定义组件（`editor.ts`、`job-report.ts`、`tool-execution.ts`、`assistant-message.ts`、`themed-text.ts`、`version-ui.ts`、`approval-dock.ts` 等）统一将 `render(width: number)` 返回类型标注对齐为 `readonly string[]`（或 `string[]` 子类型兼容处保留自有新数组）。

### D9. 升级完成后的下一阶段计划：采纳 `pi-durable` 1.6 原生 Signals / Tool Parking

本次变更归档后，立即以独立 OpenSpec 变更（建议命名 `adopt-durable-signals-parking`）推进运行时等待模型重构。提前在此固化目标架构与边界，确保本次升级不引入与之冲突的临时封装：

```text
  当前 (1.5 延续至本次升级)                 下一阶段独立变更 (基于 1.6 Signals)
+-------------------------------+       +---------------------------------------+
| 工具调用占用活跃 invocation    |       | 写持久文档 -> 返回 { sleep: {signals} }|
| 内存 Promise + watchDoc/Timer |  ---> | 任务进入 sleeping，释放运行槽位         |
| 进程重启靠中断/补偿逻辑恢复   |       | 用户操作 commit + sendSignal 原子唤醒  |
+-------------------------------+       +---------------------------------------+
```

四个重构子项的目标映射：

1. **`ask_user`（`user-questions.ts`）**：定义按问题/任务绑定的回答 signal（`defineSignal`）；工具首阶段在同一事务中写入 `app.neko.question` 与 `app.neko.questions` 索引后返回 `{ sleep: { signals: [...] }, checkpoint }` 停放任务，释放 invocation；`respondQuestion` 在结算文档的同一 `harness.commit` 中发送 signal 唤醒工具直接产出最终结果，进程在等待期间重启后任务仍保持停放等待用户回答，不再被计入崩溃中断。
2. **`plan` 审批衔接与只读门禁（`plan.ts`）**：`submit_plan` 当前以 `terminate` 结束本轮并在批准时原子提交新输入，语义已闭合；下一阶段重点评估将 `plan` 模式下的阻塞/门禁路径及潜在的内联计划确认与 `beforeTool` 原生信号能力对齐，消除多余的状态对账分支。
3. **工具执行审批（`tool-approvals.ts`）**：利用 `pi-durable` 1.6 支持在 `beforeTool` 钩子或工具执行层停放等待外部 signal 的能力，写入待审批记录后直接停放当前工具调用；`approve` / `deny` 提交决定并发送 signal 恢复执行或直接返回拒绝结果，去掉进程内审批等待表与 `observeCommits` 唤醒循环，实现跨网关重启不断流的审批等待。
4. **`subagent` 等待与并发准入（`subagents.ts`）**：将父会话 `subagent` 工具等待子会话完成及槽位准入时的 `runtime.setTimer` 轮询与内存挂起，替换为基于子任务完成与准入 signal 的持久停放等待。

下一阶段必须保持的外部不变量：`ChatView` 投影字段、`SessionSummary.awaitingAnswer` / `awaitingPlan` 标记、分叉不继承未决等待项、`abort` 与归档取消未决项的语义，以及移动端和 Web/TUI 协议形状全部不变。

## Risks / Trade-offs

- [Chord v2 握手在版本不匹配时直接关闭底层链路，不再有 v1 的 `onProtocolMismatch` 回调] → 在客户端 `ready()` 中捕获首个应用信息水合前的链路关闭与协议错误并统一包装为 `ApplicationProtocolError`；服务端从 `HostOptions.onError` 识别 `protocol_error` 而不影响其他健康连接，由 `protocol-version.test.ts` 专项验证。
- [`Reference` 状态成员在未完成首次水合前同步读 `.value` 会抛 `not_ready`] → 所有初始加载路径使用 `await host.get(Contract, params, ctx, { readyTimeout })` 等待水合完成后再暴露给调用方，或经 `subscribeState` 在首个快照到达后驱动 UI 更新。
- [`pi-tui` 容器缓存渲染数组，任何原地修改都会造成跨帧渲染错乱] → 全局排查 `packages/tui` 中所有 `.render(` 调用点，确保对返回数组绝不执行 `.push` / `.splice` / 下标赋值。
- [`1.6.0` 写入 `pi.tool` v4 / `pi.generation` v3 后无法降级回 `1.5.0`] → 与 `1.4` → `1.5` 升级策略一致，在 `AGENTS.md` 与发布说明中明确单向升级约束，验证阶段用旧库副本而非唯一生产库测试。
- [推迟 Signals / Tool Parking 意味着升级完成时尚未消除等待期的活跃 invocation 占用] → 这是有意的风险隔离：先让 Chord v2 与 `1.6.0` 存储格式稳定落地，再在干净基线上单独改动任务状态机。

## Migration Plan

1. **依赖与锁文件更新**：修改根包与 `packages/{core,gateway,tui,web}/package.json` 至 `1.6.0`，更新 `pnpm-lock.yaml`，验证 `pnpm ls` 无重复 `@earendil-works/*` 版本。
2. **`packages/core` 迁移**：迁移 `Context` 导入路径、窄化 `nested-changes.ts`、更新 `credential-providers.ts`（33 个 provider + 回退环境变量）与 `APPLICATION_PROTOCOL = 11`，跑通 `pnpm test packages/core`。
3. **`packages/gateway` Chord v2 迁移**：依次完成 `unix-link.ts` / `link.ts` 二进制链路、`contract.ts` / `mobile/admin.ts` 契约更新、`server-services.ts` / `session-host.ts` / `subagent-host.ts` / `gateway.ts` 服务端 Facet 化与 `revoke` 改造、`client-session.ts` / `subagent-client.ts` / `approval-queue.ts` / `mobile/{listener,adapter}.ts` 客户端 `Watchable` 适配，跑通 `pnpm test packages/gateway`。
4. **`packages/tui` 与 `packages/web` 适配**：修复 `HistoryImage` 与 `render(): readonly string[]` 类型签名，同步网关重命名成员与无参方法调用，跑通 `pnpm test packages/tui` 与 `pnpm test packages/web`。
5. **全量构建、打包与旧库恢复验证**：执行 `pnpm build`、`pnpm check`、`pnpm test`、`pnpm build:release`、`pnpm test:package`，并用 `1.5.0` 存储副本验证原地打开与会话恢复；同步更新 `AGENTS.md`。
6. **回滚策略**：代码合入或发版前若需回滚，直接还原 `package.json`、`pnpm-lock.yaml` 与源码改动；注意已被 `1.6.0` 写入过的 SQLite 文件不能被 `1.5.0` 打开，本地演练需在备份副本上进行。
7. **后续衔接**：本变更验证通过并归档后，按 D9 启动独立变更重构 `ask_user`、`plan`、`tool-approvals` 与 `subagent` 等待链。
