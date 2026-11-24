# Proposal

## Why

neko-harness 当前将全部 `@earendil-works/*` 依赖精确锁定在 `1.5.0`，而上游 Pi `1.6.0` 已正式发布到 npm（`reference/pi` 含 `v1.6.0` 标签）。`1.6.0` 将 `@earendil-works/chord` 根导出彻底切换为重写后的 Chord v2（移除了 `1.5.0` 的 Chord v1 与 `chord/old`），`pi-durable@1.6.0` 与 `pi-env@1.6.0` 均依赖 Chord v2，同时 `pi-ai@1.6.0` 更新了内置纯 API-Key provider 目录、`pi-tui@1.6.0` 将组件渲染结果改为只读缓存数组；继续停留在 `1.5.0` 不仅会累积网关传输层的迁移跨度，也会阻塞后续基于 `pi-durable` 1.6 原生 Signals / Tool Parking 重构会话内各类交互等待机制。

## What Changes

- 将根包与 `packages/{core,gateway,tui,web}` 使用的 `@earendil-works/{chord,pi-ai,pi-codemode,pi-durable,pi-env,pi-schema,pi-tui}` 精确锁定到 npm 发布的 `1.6.0`，同步更新 `pnpm-lock.yaml`；`v1.6.0` 之后 `main` 上的提交不纳入。
- **BREAKING（本地网关协议）** `packages/gateway` 及各端客户端绑定从 Chord v1 迁移至 Chord v2，并将 `APPLICATION_PROTOCOL` 从 `10` 递增到 `11`：
  - 宿主寻址与生命周期：`hostNamed` 改为 `hostKind("neko")` 地址；服务端注册收拢进 `defineFacet` 并经 `chord.load` 激活，客户端在 `connect` / `get` / `hold` 前执行 `host.load([])`；移除已废弃的 `opaque()`，进程内共享状态改用 `self.open`、`self.writable` 与 `self.derive`；移动设备权限吊销从 `invalidatePrincipal` 改为 `revokedBy` 索引加同步 `revoke`。
  - 契约与引用调用对齐：重命名 7 个服务器级状态契约与 `NekoMobileAdmin` 中与 Chord v2 引用保留属性冲突的 `state` 成员；`NekoSubagent` 参数收敛为扁平必填原语；无参方法调用去掉 `null` 占位参数，方法入参对象改为封闭 schema；客户端状态监听从 `.subscribe` 迁至基于 `Watchable.watch` 的同步取消辅助函数，引用生命周期改读 `ref.state`。
  - 二进制传输链路：`UnixLink`（4 字节大端长度前缀帧）与 `boundedWebSocketLink` 直接收发裸 `Uint8Array` 二进制消息并保留进出站字节上限守卫；旧版文本握手帧或协议版本不同的对端在握手期被明确拒绝并映射为 `ApplicationProtocolError`。
  - 移动入口兼容不变：手机端仍走独立的 HTTPS/WSS JSON-RPC v1，由 `MobileAdapter` 在进程内桥接，`apps/mobile` 与已配对设备无需改动。
- `packages/core` 对齐 Pi 1.6.0：
  - `Context` 导入统一迁移至 `@earendil-works/chord/context`；
  - `nested-changes.ts` 对 `Tool.execute()` 新增的 `ToolPark` 返回分支做透传窄化；
  - `credential-providers.ts` 与 `pi-ai@1.6.0` 对账：内置纯 API-Key 模型 provider 目录由 32 个扩充至 33 个（新增 `qwen-token-plan-individual-cn`），同步更新既有 3 个 Qwen Token Plan 的显示名称与专属首选环境变量，并在环境变量配置状态检测中兼容共享回退环境变量（`QWEN_TOKEN_PLAN_API_KEY`、`QWEN_TOKEN_PLAN_CN_API_KEY`），保持设置页展示与 `models.checkAuth` 一致。
- `packages/tui` 与 `packages/web` 对齐：
  - 适配 `pi-tui@1.6.0` 的 `Component.render(width): readonly string[]` 与容器缓存语义，修复 `HistoryImage` 原地 `.push` 污染缓存数组的问题，放宽自定义组件 `render` 返回类型；
  - 同步网关契约成员改名、无参 RPC 调用与状态监听辅助函数。
- 存储与回退边界：SQLite schema 在 `1.5.0` → `1.6.0` 之间未变，`1.4` / `1.5` 创建的存储原地打开且不清理数据；但 `1.6.0` 写入 `pi.tool` v4 与 `pi.generation` v3 后，`1.5` 发布版无法再读取，不支持降级回退。
- **后续演进计划（本次升级聚焦纯 SDK 与 Chord v2 迁移；以下工作写入路线计划，待本次升级完成并归档后作为独立变更推进）**：
  - **基于 `pi-durable` 1.6 原生 Signals / Tool Parking 重构交互与等待状态机**：立项独立变更，用 `defineSignal`、工具返回 `{ sleep: { signals } }` / `{ wait }` 及 `beforeTool` 停放门禁替换当前占用内存运行槽位的挂起 Promise 与轮询，覆盖四块核心流程：
    1. `ask_user` 提问等待（`packages/core/src/user-questions.ts`）：落盘问题记录后停放工具等待回答 signal，释放活跃 task invocation，支持跨进程重启无损恢复等待态；
    2. `plan` 审批等待与模式门禁（`packages/core/src/plan.ts`）：评估并对齐计划审批衔接、`beforeTool` 只读门禁与原生信号恢复路径；
    3. 工具执行审批（`packages/core/src/tool-approvals.ts`）：以原生停放与审批 signal 取代内存等待表与 `observeCommits` 监听，使待审批调用在网关重启后可继续等待决定而非按中断失败；
    4. `subagent` 等待与并发准入（`packages/core/src/subagents.ts`）：以原生子任务完成等待与准入信号取代 `setTimer` 轮询及内存挂起。
  - 其他不在本次范围内的新接口：`@earendil-works/pi-durable/images/fit`（保持现有图片校验与缩放流水线）、按会话压缩覆盖、Codemode 多命名空间。
- 更新 `AGENTS.md`（「Pi 1.5 使用要点」更新为「Pi 1.6 使用要点」，含 Chord v2、provider 目录数量与应用协议号）及相关开发者说明；不发版、不提交 git commit。

## Capabilities

### New Capabilities

无；沿用现有能力边界。

### Modified Capabilities

- `agent-runtime`: 将持久化会话的 SDK 恢复基线更新至 Pi 1.6.0（原地打开 1.4/1.5 存储且不清理数据，1.6 写入后不支持回退到 1.5）。
- `session-gateway`: 本地 Chord 传输升级为二进制帧协议并递增应用协议版本，明确旧版文本握手帧或异构协议对端的确定性拒绝行为，同时保持移动入口协议独立兼容。
- `model-providers`: 内置封闭模型 provider 目录跟随 Pi 1.6.0 扩充至 33 个（Qwen Token Plan 扩为四个条目并拆分首选环境变量），同时明确主/回退环境变量在状态展示与请求鉴权上的一致性。

## Impact

- 依赖清单：根 `package.json`、`packages/{core,gateway,tui,web}/package.json` 与 `pnpm-lock.yaml`；全部 `@earendil-works/*` 直接与传递依赖统一到 `1.6.0`。
- Core：`Context` 子路径导入（约 17 个文件）、`nested-changes.ts`、`credential-providers.ts`、`runtime.ts`（回退环境变量状态检测）、`application-version.ts`（`APPLICATION_PROTOCOL = 11`）及 `provider-settings.test.ts` 等测试。
- Gateway：`contract.ts`、`gateway.ts`、`server-services.ts`、`session-host.ts`、`subagent-host.ts`、`link.ts`、`unix-link.ts`、`client-session.ts`、`subagent-client.ts`、`approval-queue.ts`、`mobile/{admin,listener,adapter}.ts` 及网关测试套件。
- Web / TUI：`packages/web/src/{mobile-admin.ts,client/lib/gateway.ts}`、`packages/tui/src/{tui.ts,*ui.ts,components/*}`（状态成员名、无参方法调用、`HistoryImage` 与 `render(): readonly string[]`）及对应测试。
- 移动端：`apps/mobile` 线上协议与 Dart 代码不受本次 Chord v2 迁移影响。
- 存储与文档：默认 `~/.neko/neko.sqlite` 原地沿用，单向升级不可回退；更新 `AGENTS.md`，并在本变更的设计与任务尾注中固化下一阶段 Signals / Tool Parking 重构计划。
