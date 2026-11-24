# Tasks

## 1. 依赖与锁文件升级（D1）

- [x] 1.1 将根 `package.json` 与 `packages/{core,gateway,tui,web}/package.json` 中的 `@earendil-works/{chord,pi-ai,pi-codemode,pi-durable,pi-env,pi-schema,pi-tui}` 统一精确锁定为 `1.6.0`，刷新 `pnpm-lock.yaml`，运行 `pnpm install --frozen-lockfile` 与 `pnpm ls --depth=1` 验证安装成功且依赖树无重复版本的 `@earendil-works/*` 包

## 2. Core 适配与 Provider 目录对账（D1、D7）

- [x] 2.1 将 `packages/core` 源码与测试中从 `@earendil-works/chord` 导入 `Context` 的语句统一改为 `@earendil-works/chord/context`，在 `packages/core/src/nested-changes.ts` 中对 `Tool.execute()` 新增的 `ToolPark` 返回分支做透传窄化，并将 `packages/core/src/application-version.ts` 的 `APPLICATION_PROTOCOL` 递增至 `11`；运行 `pnpm --filter @neko-harness/core build` 验证类型检查与编译通过
- [x] 2.2 更新 `packages/core/src/credential-providers.ts` 对齐 `pi-ai@1.6.0` 的 33 个纯 API-Key provider（新增 `qwen-token-plan-individual-cn`、同步既有 3 个 Qwen Token Plan 的显示名称与专属首选 `envVar`、增加可选 `fallbackEnvVars`），并在 `packages/core/src/runtime.ts` 的 `credentialStatus()` 中支持回退环境变量状态检测；更新并运行 `pnpm test packages/core/test/provider-settings.test.ts` 验证 33 项对账与兼容回退环境变量用例通过
- [x] 2.3 运行 `pnpm test packages/core` 验证运行时、请求身份（`request-identity.test.ts`）、崩溃到限（`crash-loop.test.ts`）与 UI 文案对账全部通过，同步更新 `AGENTS.md` 中「模型 provider」章节的 provider 数量与应用协议版本说明并核对描述与代码一致

## 3. Gateway Chord v2 传输、契约与服务端迁移（D2、D3、D4、D5、D6）

- [x] 3.1 重写 `packages/gateway/src/unix-link.ts`（4 字节大端长度前缀帧直接收发 `Uint8Array`）与 `packages/gateway/src/link.ts`（`boundedWebSocketLink` 直接实现二进制 `Link` 并保留 `MAX_LINK_BYTES` 进出站字节守卫，提供带 `host.load([])` 的客户端宿主初始化封装）；更新并运行链路测试验证二进制帧收发、非二进制帧关闭与缓冲上限守卫生效
- [x] 3.2 迁移 `packages/gateway/src/contract.ts` 与 `packages/gateway/src/mobile/admin.ts` 至 Chord v2：以 `GatewayKind = hostKind("neko")` 与 `hostAddress: () => GATEWAY_ADDRESS` 取代 `hostNamed`、将 7 个状态契约的保留成员名 `state` 统一重命名为 `snapshot`、将 `NekoMobileAdmin.state` 重命名为 `status`、将 `NekoSubagent` 参数收敛为扁平必填原语 `{ sessionId, attachmentId, target }`、将方法入参对象改为封闭 `obj(...)`，同时将其余 `@earendil-works/chord` 的 `Context` 导入改为 `@earendil-works/chord/context`；验证契约模块类型编译通过且加载时不抛保留字错误
- [x] 3.3 迁移服务端宿主 `packages/gateway/src/{server-services,session-host,subagent-host,gateway}.ts` 与 `packages/gateway/src/mobile/{listener,adapter}.ts`：移除 `local` + `opaque()`，改用单 `defineFacet` 配合 `chord.load`、`self.open`、`self.writable` 与 `self.derive` 管理会话投影及连接附着状态，并将移动设备权限吊销从 `invalidatePrincipal` 迁移为 `HostOptions.revokedBy` + `chord.revoke`；运行 `pnpm test packages/gateway/test/mobile` 验证移动 API v1 协议兼容与设备撤销测试全部通过
- [x] 3.4 迁移客户端绑定 `packages/gateway/src/{client-session,subagent-client,approval-queue}.ts`：实现并采用 `Watchable` 同步取消辅助函数取代 `.subscribe`、改读 `ref.state` 跟踪引用状态、移除无参 RPC 的 `null` 实参，并在 `ready()` 中将首包到达前的链路关闭与底层协议错误统一映射为 `ApplicationProtocolError`；更新网关测试（含 `protocol-version.test.ts`）并运行 `pnpm test packages/gateway` 验证全部通过，同时将 `AGENTS.md` 的「Pi 1.5 使用要点」更新为「Pi 1.6 使用要点」（记录 Chord v2 契约、链路、Facet 生命周期与单向存储升级说明）

## 4. TUI 与 Web 前端适配（D3、D6、D8）

- [x] 4.1 适配 `packages/tui` 至 `pi-tui@1.6.0` 与新网关契约：在 `packages/tui/src/components/history-image.ts` 中对 `render()` 返回的只读数组先浅拷贝再补齐行数，将 `editor.ts` 等自定义组件的 `render` 返回类型对齐为 `readonly string[]`，并同步网关契约 `snapshot` 成员名、无参方法调用与状态监听辅助函数；运行 `pnpm test packages/tui` 验证全部终端测试通过且无原地修改渲染缓存数组的代码
- [x] 4.2 适配 `packages/web`（`src/mobile-admin.ts`、`src/client/lib/gateway.ts` 及相关测试）至重命名后的网关契约成员（`snapshot` / `status`）、无参方法调用与状态监听辅助函数；运行 `pnpm --filter @neko-harness/web build` 与 `pnpm test packages/web` 验证构建和全部 Web 测试通过

## 5. 全仓集成、打包与旧库恢复验证

- [x] 5.1 执行 `pnpm build`、`pnpm check`、`pnpm test:serial` 验证全仓构建、Biome 格式与规则检查、根与 Web 客户端类型检查及全套串行测试全部零错误通过
- [x] 5.2 执行 `pnpm build:release` 与 `pnpm test:package` 验证发布产物不含 `esbuild` 或 `Bun.` 残留且全局 tarball 安装冒烟通过，并使用 `Pi 1.5.0` 创建的 SQLite 存储副本验证原地打开后既有会话、待办、计划、提问与后台任务均可正常读取与继续对话

## Workflow follow-up

- 在本变更完成验证并归档（`/openspec-archive-change`）后，基于已稳定的 Pi `1.6.0` 与 Chord v2 基线单独立项新变更（建议命名 `adopt-durable-signals-parking`，设计蓝图见 `design.md` D9），推进 `@earendil-works/pi-durable` 原生 Signals 与 Tool Parking 重构，不在本次升级变更内混入。
- 后续变更子项 1 — 重构 `ask_user` 提问等待（`packages/core/src/user-questions.ts`）：使用 `defineSignal` 与 `{ sleep: { signals } }` 在问题记录落盘后停放工具任务并释放活跃 invocation，`respondQuestion` 在同一提交中发送 signal 唤醒结算，支持等待期间跨进程重启无损恢复。
- 后续变更子项 2 — 重构工具执行审批等待（`packages/core/src/tool-approvals.ts`）：利用 `beforeTool` / 工具包装层的持久停放与审批 signal 替代内存等待队列与 `observeCommits` 监听，使待审批工具调用跨网关重启继续保持待决等待态。
- 后续变更子项 3 — 对齐 `plan` 审批衔接与模式门禁（`packages/core/src/plan.ts`）：评估并收敛计划待批衔接、`beforeTool` 只读门禁与 `1.6` 原生信号/钩子机制，保持批准时原子派发、取消与模式自愈语义不变。
- 后续变更子项 4 — 重构 `subagent` 等待与并发准入（`packages/core/src/subagents.ts`）：使用原生子任务完成等待与准入 signal 替换 `runtime.setTimer` 轮询与内存挂起等待，保持委派详情、轮次停止、分叉隔离与总用量统计不变。
