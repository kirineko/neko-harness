# Tasks

## 1. Core：墓碑与移除

- [x] 1.1 在 `packages/core/src/runtime.ts` 新增 `app.neko.workspaces-removed` 文档，并让 `registerWorkspace` 区分显式 / 隐式：隐式跳过墓碑，显式（`addWorkspace`、带 cwd 的 `createConversation`、启动时的 `defaultCwd`）同次提交清除墓碑；用 `core/test/workspace.test.ts` 验证启动扫描、分叉、显式添加、新建会话四种来源
- [x] 1.2 实现 `removeWorkspace(path)`：校验已登记、非最后一个、无运行 / 等待回答 / 等待计划的会话（错误码 `WORKSPACE_UNKNOWN:` / `WORKSPACE_LAST:` / `WORKSPACE_BUSY:`），单次提交删除 item 并写墓碑；加入 `NekoRuntime` 类型；用单元测试覆盖三类拒绝、成功、重复移除与重启后仍保持移除
- [x] 1.3 `listConversations()` 跳过 cwd 在墓碑中的会话；用测试验证移除后会话不在目录，重新添加后恢复，归档状态保持
- [x] 1.4 把 `APPLICATION_PROTOCOL` 由 8 升到 9（`packages/core/src/application-version.ts`），运行引用该常量的 core / gateway / tui / web 测试确认通过

## 2. Gateway：契约与服务

- [x] 2.1 `NekoWorkspaces` 契约版本升到 2，新增 `remove` 方法（入参 `{ path }`）；服务端经 `serialize` 调用 `runtime.removeWorkspace`，成功后目录广播（`server-services.ts`），错误前缀原样透传
- [x] 2.2 在 `client-session.ts` 暴露 `workspaces.remove`；在 `gateway/test/workspace-registry.test.ts` 新增：Unix 与 WS 双客户端移除并广播、被拒绝时目录不变、与 `add` 并发、移除后会话目录不含其会话
- [x] 2.3 验证移动端：在 `gateway/test/mobile/api-workspaces.test.ts` 补用例，移除后 `workspaces.list` 缩小并推送 `workspaces.changed`；确认 `sessions_controller.dart` 的回退逻辑无需修改（读代码并在 PR 说明中记录）

## 3. Web 客户端行为

- [x] 3.1 在 `GatewayConnection` 增加 `removeWorkspace(path)`：移除当前工作区时先选目录中的下一个再提交，失败不切换；订阅工作区目录，当前工作区被外部移除时自动切到第一个；在 `appActions` 暴露；用 `web/test/workspaces.test.ts` 覆盖移除当前、移除其他、外部移除、失败不切换
- [x] 3.2 增加 core 错误前缀的前端映射（`WORKSPACE_UNKNOWN:` / `WORKSPACE_LAST:` / `WORKSPACE_BUSY:`）并更新 `core/test/fixtures/core-ui-strings.json`；`core-ui-strings.test.ts` 通过

## 4. Web 界面

- [x] 4.1 把 `session-list.tsx` 的工作区选项改为"行容器 + 主按钮 + 移除按钮"，保留 `title`、✓、`is-active`；不可移除项（启动目录、仅剩一个）置灰并带说明；在 `styles.css` 增加 `.workspace-row` / `.row-remove`，hover / `:focus-within` 显示、`(pointer: coarse)` 常驻、只用 token；用组件测试验证按钮可达、点击不触发切换、置灰原因
- [x] 4.2 新增移除确认框（复用 `Modal` 与 `confirm-body`）：名称、完整路径、三句说明与被隐藏会话数、提交期间锁定、失败 `role="alert"`、取消 / Esc 后焦点回到触发控件；用测试覆盖成功、被拒绝、取消、重复提交
- [x] 4.3 `zh.ts` / `en.ts` 同时补全文案（英文：简短、首字母大写、句末无句号），确认字典测试与 CJK 扫描通过；在 375 与 1440 宽度手动检查无横向溢出，并在三套主题下检查危险按钮对比度（`theme-contrast.test.ts` 通过）

## 5. 文档与整体验证

- [x] 5.1 更新 `AGENTS.md`：应用协议 9、`neko.workspaces` 契约 v2、移除语义与墓碑、Web 启动目录不可移除；核对内容与实现一致
- [x] 5.2 运行 `bun run check` 与 `bun run test`，全部通过；手动验证：移除非当前 → 移除当前自动切换 → 重启网关后保持移除 → 重新添加后会话恢复

## Workflow follow-up

- 评审通过后归档本变更（`openspec archive`），确认主 spec 合并了 `workspace-management`、`session-gateway`、`web-ui` 的 delta。
