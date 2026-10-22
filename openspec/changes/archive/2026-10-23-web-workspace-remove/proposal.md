# Proposal

## Why

工作区只能添加、不能移除：`app.neko.workspaces` 登记只增不减，Web 工作区切换器里会永远堆着不再使用的目录。用户没有任何办法清理，而简单地删掉登记记录也无效，因为启动时按已有会话 cwd 的重新登记、Web 每次加载对启动目录的 `add`、fork 与新建会话都会让它"复活"。

## What Changes

- 网关 `neko.workspaces` 契约新增 `remove` 方法；**BREAKING**：`neko.workspaces` 契约版本升到 2，应用协议由 8 升到 9，不再保留旧网关降级路径（Web / TUI / 移动端与网关须同版本）。
- 移除语义是"仅从列表移除"：不删除宿主文件，不归档会话；该工作区的会话保留并随工作区一起被隐藏，重新添加同一目录后恢复。
- core 用独立的「已移除路径」文档记录墓碑。启动扫描已有会话 cwd、fork 这类隐式登记跳过墓碑中的路径；用户显式添加（目录选择面板、新建会话时显式指定 cwd、网关启动目录）清除墓碑。
- 网关拒绝移除：最后一个工作区、仍有运行中或等待回答/批准计划的会话的工作区、未登记的路径；错误沿用 `CODE: 文案` 前缀。
- Web 工作区切换器改为"行容器 + 主按钮 + 移除按钮"：hover/聚焦显示，触屏常驻；Web 启动目录置灰并说明原因；点击后弹确认框，说明不删除文件、会话将被隐藏、重新添加可恢复；移除当前工作区后自动切到列表中的下一个。
- 中英文文案同时补齐，并更新 AGENTS.md 中的应用协议版本与工作区说明。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `workspace-management`: 新增"移除工作区"要求与墓碑语义；修改"已有会话接入与同步"，使隐式登记不复活已移除工作区。
- `session-gateway`: 新增 `remove` 接口及其拒绝规则；应用协议版本升到 9。
- `web-ui`: 工作区切换器提供移除入口、确认框、启动目录与当前工作区处理。

## Impact

- `packages/core/src/runtime.ts`、`workspace.ts`：墓碑文档、`removeWorkspace`、隐式登记过滤、`application-version.ts` 协议常量。
- `packages/gateway/src/contract.ts`、`server-services.ts`、`client-session.ts`：契约方法、版本、服务实现；`mobile/` 适配无需新增接口，但依赖既有 `workspaces.changed` 推送与「选中工作区消失时回退」逻辑。
- `packages/web/src/client/`：`session-list.tsx`、`gateway.ts`、`bootstrap.ts`、`styles.css`、`lib/i18n/{zh,en}.ts`。
- 测试：`gateway/test/workspace-registry.test.ts`、`core/test/workspace.test.ts`、`web/test/workspaces.test.ts`、协议版本相关测试与 CJK 扫描白名单。
- 文档：`AGENTS.md`。
