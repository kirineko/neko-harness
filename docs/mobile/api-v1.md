# neko mobile API v1

手机 App 控制电脑上 Agent 的 JSON-RPC 2.0 协议（design D6/D8，`specs/mobile-api`）。
形状以 `packages/gateway/src/mobile/protocol.ts` 的 TypeBox schemas 为准；
`packages/gateway/test/fixtures/mobile-api-v1/*.json` 是每个方法的请求/结果/通知示例（TS 与 Dart 共用，由 `protocol-fixtures.test.ts` 对拍守护）。

## 传输与认证

- 连接：`wss://<IPv4>:<port>/mobile/v1/ws`，升级头 `Authorization: Neko-Device <deviceId>.<base64url credential>`；认证失败在 upgrade 阶段 401，不进入 JSON-RPC。
- 单帧 ≤ `maxFrameBytes`（256 KiB）；业务 payload ≤ `maxPayloadBytes`（128 KiB）；每连接在途请求 ≤ `maxConcurrentRequests`（8）；发送缓冲 > `maxSendBufferBytes`（2 MiB）关闭（4408）。
- 撤销以 WS close **4401** 送达；握手不兼容以 **4402** 关闭；慢消费者以 **4408** 关闭。非法 JSON/帧只关闭当前连接。
- 连接内第一个请求必须是 `server.hello`；hello 前调用其他方法即关闭。`id` 只对应连接内响应，业务幂等完全依赖持久 `requestId`。

## server.hello

请求/结果/不兼容示例：`hello-request.json`、`hello-result.json`、`hello-error-incompatible.json`。

- 参数：`{ apiVersions: number[], app: { version, platform, build } }`。产品 `app.version` 差异不拒绝；只按 `apiVersions` 与服务端 `[1]` 取交集。
- 结果：`{ apiVersion, serverId, serverName, gatewayVersion, capabilities, limits }`。
  `capabilities` 为 `["workspaces","sessions","chat","subagents","approvals","media","todos","questions","plan"]`（`todos` / `questions` / `plan` 为增量能力，API 版本仍为 1；新 App 连接缺少它们的旧电脑时隐藏对应入口，旧 App 忽略它们）；`limits` 精确为
  `maxFrameBytes=262144`、`maxPayloadBytes=131072`、`pageItems=50`、`chunkBytes=65536`、
  `maxConcurrentRequests=8`、`maxSendBufferBytes=2097152`。
- 无交集：error `data = { code: "incompatible", needs: "app" | "computer" }`。
  App 只支持更高版本（如 `[2]`）→ `needs: "computer"`；只支持更低/无交集 → `needs: "app"`。响应后关闭。

## 错误

统一 JSON-RPC error 信封，`error.data.code` 为稳定枚举（示例见 `error-codes.json`）：

| code | 含义 |
| --- | --- |
| `unauthorized` | 凭据无效/已撤销（连接建立后检测到） |
| `revoked` | 授权被撤销 |
| `incompatible` | 版本无交集（附 `needs`） |
| `invalid_params` | 参数校验失败 |
| `not_found` | 未知方法/对象 |
| `gone` | attachment/会话/轮次已失效 |
| `stale_ref` | 历史游标不存在，重新 attach |
| `content_changed` | 大字段 digest 已变化，重新取条目 |
| `busy_limit` | 并发请求超限 |
| `rejected` | 电脑拒绝受理提交（如凭据缺失），`message` 为原因 |
| `internal` | 内部错误（详情只进 gateway 日志，已脱敏） |

## 方法

参数与结果的权威 schema 见 `MOBILE_API_V1_METHODS`；通知见 `MOBILE_API_V1_NOTIFICATIONS`。

### workspaces

- `workspaces.list → { workspaces: [{ root, name }] }`（`workspaces-list-result.json`）：已登记工作区；不提供新增/删除。
- 通知 `workspaces.changed { revision }`（`workspaces-changed-notification.json`）。

### sessions

- `sessions.list { workspace, query?, cursor? } → { sessions, nextCursor? }`
  （`sessions-list-request.json` / `sessions-list-result.json`）：按工作区过滤、按最近消息时间倒序（无消息时用创建时间，同值按会话 ID 倒序，与 Web 一致；仅打开/attach 不改变顺序）、
  每页 ≤ `pageItems`、`query` 搜索标题/首条预览；`cwd` 必须是已登记工作区（未知工作区拒绝为 `invalid_params`，不落回启动目录）。
- 会话摘要 `{ id, workspace, title, preview, lastUsedAt, lastMessageAt, archived, awaitingAnswer? }`：`lastMessageAt` 为排序/展示用的最近消息时间（无消息时 = 创建时间）；`lastUsedAt` 为最近使用（含打开）时间，仅作回退。`lastMessageAt` 是 v1 内的新增字段：旧 App 忽略它，新 App 连接缺少该字段的旧网关时回退为 `lastUsedAt`。`awaitingAnswer`（可选，声明 `questions` 能力时出现）为真表示该会话有问题在等用户回答，列表应显示「等待回答」而非「运行中」；缺省表示电脑端无法判断，App 不应推测。`awaitingPlan`（可选，声明 `plan` 能力时出现）为真表示该会话（空闲）有已提交的计划等待批准，列表应显示「等待批准」；缺省同样表示无法判断。
- `sessions.create { workspace } → session`（`sessions-create-request.json` / `sessions-create-result.json`）：新会话用电脑默认模型。
- 通知 `sessions.changed { revision }`（`sessions-changed-notification.json`）。

### chat

所有 chat/approvals/media 方法都携带 `subscriptionId`；它只在最近一次 `chat.attach` 有效，旧 id 返回 `gone`。同一连接同时只有一个主会话订阅与一个子 agent 订阅。

- `chat.attach { sessionId } → { subscriptionId, sessionId, snapshot }`：快照 = 状态（`busy/queued?/status/usage/taskUsage/contextUsage/agent/subagents/agents/approvalCount/compaction`；`queued` 为用户排队输入 `[{ id, mode: steer|followUp, preview, images }]`，预览有界，系统输入不出现）+ 尾部 ≤ `pageItems` 条且 ≤ 128 KiB 的 `items` + `historyBefore`（无更早历史为 `null`）+ `streaming`（流式区，文本只带尾部 16K 字符，`textOmitted/thinkingOmitted` 为省略的前缀长度）。
- `chat.detach { subscriptionId } → null`。
- `chat.history { subscriptionId, before, limit? } → { items, historyBefore }`：游标不存在 → `stale_ref`（重新 attach）。
- `chat.content { ref, offset } → { data, nextOffset, total, done }`：按 contentRef 读 UTF-8 字节的 base64 分块（≤ `chunkBytes`）；digest 不符 → `content_changed`。
- `chat.submit { subscriptionId, requestId, text, mode? } → { accepted: true, queued }`：`mode` 缺省 = 忙碌时持久排队（`queued=true`）；`steer` = 引导当前运行。同 `requestId` 重复提交（含断线/gateway 重启后）只产生一条输入；电脑拒绝 → `rejected`。
- `chat.submissionStatus { subscriptionId, requestId } → { status: "accepted" | "unknown" }`；`unknown` 不推断为失败。
- `chat.abort { subscriptionId } → { accepted }`：显式停止；断线绝不映射为 abort。停止会撤回全部排队输入并中止当前运行。
- `chat.steer { subscriptionId, id } → { result, id?, text?, images? }`：把状态 `queued` 中一条仍排队的用户输入改为引导（当前工具轮后放入）。`result` 为 `steered | withdrawn | placed | settled | unknown`；`steered` 时 `id` 为新的提交 id（原 id 随之失效，以状态列表为准），已是引导则原样返回；`placed` 表示已进入会话；仅当电脑无法重新受理时返回 `withdrawn` 并带原文 `text`。不中止当前运行、不影响其他排队项。App 提交时不再预选引导，`chat.submit` 的 `mode` 保留仅为兼容。
- `chat.withdraw { subscriptionId, id } → { result, text?, images? }`：撤回状态 `queued` 中的一条用户排队输入（`id` 取自该列表）；`result` 为 `withdrawn | placed | settled | unknown`，`withdrawn` 时返回完整原文 `text`（技能输入为 `/skill:<name> <args>`）与图片数 `images`，供 App 取回草稿；`placed` 表示已进入会话，不能撤回；不属于该订阅会话的 `id` 为 `unknown`。不撤销当前运行与其他排队项。`queued` 缺省表示电脑端不支持该能力，App 应隐藏排队条与撤回入口。
- 通知 `chat.patch { subscriptionId, seq, upserts, status?, streaming?, streamingAppend? }`：`upserts` 为窗口内变化或新追加条目（整条替换，按 key 定位，新 key 追加到末尾）；`status` 为整块状态；`streaming` 整段替换流式区（`null` 表示结束）；`streamingAppend { text?, thinking? }` 追加到流式区末尾。
- 通知 `chat.reset { subscriptionId, seq }`：已加载条目消失/重排或补丁超限；App 丢弃缓存并重新 attach。

#### 条目 DTO 与 contentRef（D8）

`{ key, type: user|assistant|tool|system, text?, thinking?, note?, error?, skill?, jobId?, tool?, images?, refs? }`。
`tool = { callId, name, summary, status: running|done|error, detail?, output?, result?, diff?, diffAdded?, diffRemoved?, diffTruncated?, durationMs?, note? }`。
字符串字段（`text`、`thinking`、`tool.detail/output/result/diff`）UTF-8 超过 8 KiB 时只带前 2 KiB 预览，并在 `refs[]` 中给出 `{ sessionId, agentId?, key, field, digest, bytes }`。
图片 `images[] = { name, mimeType, width, height, bytes, entryId, contentIndex }`，数据经 `media.read` 读取。

### subagents

- `subagents.open { subscriptionId, agentId? | taskId? } → { subagentSubscriptionId, agentId, snapshot }`：二者恰给一个。按身份打开时连续展示全部轮次；分叉历史按轮次只读（`snapshot.readonly=true`）。快照 `subagents` 字段为该身份的轮次（含本轮用量）。
- `subagents.history { subagentSubscriptionId, before, limit? }`：视图外更早历史游标形如 `entry:<id>`。
- `subagents.close { subagentSubscriptionId } → null`。
- `subagents.stop { subscriptionId, taskId } → { stopped }`：只停精确的活动轮次；已结束 → `gone`。
- 通知 `subagents.patch` / `subagents.reset`：补丁体与 chat 相同，以 `subagentSubscriptionId` 区分。

### approvals

- `approvals.list { subscriptionId } → { approvals }`：当前会话全部子 agent 的待决 Bash 审批 `{ id, version, taskId, agentId?, title?, command, cwd, timeoutSeconds?, requestedAt }`。
- `approvals.get { subscriptionId, id }`：已结算 → `not_found`。
- `approvals.decide { subscriptionId, taskId, id, version, decision: allow|deny } → { status: pending|allowed|denied|cancelled }`：竞争只生效一次；已结算或版本不符时直接返回实际状态。
- 通知 `approvals.changed { subscriptionId, revision }`。

### todos / questions

能力 `todos` / `questions`（声明后才可调用；缺失时 App 隐藏入口，不推测）。`chat.attach` 快照与 `chat.patch` 的状态里携带可选摘要：`todos: { revision, count, completed }`、`questions: { revision, pendingCount }`（缺省 = 电脑端不支持；存在且为 0 = 支持但没有内容）。工具历史项 `tool.interaction` 带有 `todo` / `ask_user` 调用的结构化状态（问题、选项标签、最终答案；不要解析 `result` 文案）。

- `todos.get { subscriptionId } → { revision, items }`（`todos-get-*.json`）：模型维护的有序待办，只读；`items: [{ id, text, status: pending|in_progress|completed }]`，最多 100 项，`id` ≤ 64、`text` ≤ 256 个 UTF-16 码元，整表 JSON ≤ 64 KiB。App 不能修改待办。
- `questions.list { subscriptionId } → { revision, pending }`（`questions-list-*.json`）：等待回答的问题摘要 `{ id, version, preview, multiple, optionCount, createdAt }`（预览 ≤ 256 码元，至多 8 项）。
- `questions.get { subscriptionId, id } → question`（`questions-get-*.json`）：完整记录 `{ id, callId, version, question, multiple, options[{ id, label, description?, recommended? }], status: pending|answered|skipped|cancelled, answer: { optionIds, text } | null, createdAt, settledAt }`。问题与选项为纯文本，`recommended` 仅是提示（不预选）。限制：问题 ≤ 2000、选项 ≤ 12 个、选项 id ≤ 64 / 标签 ≤ 200 / 说明 ≤ 500、自由文字 ≤ 4000 个 UTF-16 码元，问题参数与回答参数各自 JSON ≤ 16 KiB；单题记录远小于 `maxPayloadBytes`，不会被截断。不属于该订阅会话的 `id` → `not_found`。
- `questions.respond { subscriptionId, id, version, response } → question`（`questions-respond-*.json`）：`response` 为 `{ kind: "answer", optionIds?, text? }`（选项与文字至少其一；单选至多一个选项；`optionIds` 返回时按选项顺序）或 `{ kind: "skip" }`。这不是聊天输入：不进入排队与输入历史，工具从原调用继续。第一次有效结算为准；他端已结算、回执丢失后重试、或停止后迟到的请求，得到的是已保存的终态记录（`answered` / `skipped` / `cancelled`）及实际答案，不覆盖。版本不符、非法选项/文字、他会话的问题 → `rejected`（附原因）；参数形状错误 → `invalid_params`；旧订阅 → `gone`。
- 通知 `todos.changed { subscriptionId, revision }`、`questions.changed { subscriptionId, revision }`：失效提示，不含数据。收到后重新调用 `todos.get` / `questions.list`（需要时再 `questions.get`），只接受 revision 不低于已持有的结果；查询期间收到更高的 revision 要再读一次。attach 快照里的 revision 与状态同步取得，之后的变化一定会有通知；重连后重新 attach 并查询，不依赖通知重放。

### plan

能力 `plan`（声明后才可调用；缺失时 App 隐藏入口，不推测）。`chat.attach` 快照与 `chat.patch` 的状态里携带可选摘要 `plan: { revision, pending, version? }`（缺省 = 电脑端不支持；存在且 `pending: false` = 支持但没有待批准计划）；`version` 是最新计划的版本（待批准时即该计划），首个计划出现前缺省。工具历史项 `tool.interaction` 对 `submit_plan` 调用带 `{ kind: "submit_plan", version, title, steps, note }`。手机可以查看与决定计划，也可以用 `plan.exit` 取消计划并退出 plan 模式，但**不能进入** plan 模式（没有 `plan.enter` / `plan.mode` 等方法，一律 `not_found`）。

- `plan.get { subscriptionId, version } → plan`（`plan-get-*.json`）：`{ version, title, steps, note, status: awaiting_approval|approved|revision_requested|superseded|cancelled, feedback: string | null, createdAt, settledAt }`，文本字段；`title` 与 `feedback` 按纯文本显示，`steps` 与 `note` 是 Markdown（客户端不渲染 HTML、不开链接、不加载远程图片）；标题 ≤ 120、步骤 ≤ 30 条且每条 ≤ 500、说明 ≤ 4000、反馈 ≤ 2000 个 UTF-16 码元。不属于该订阅会话的版本 → `not_found`。未知 `status` 按已结算处理。
- `plan.respond { subscriptionId, version, decision } → plan`（`plan-respond-*.json`）：`decision` 为 `{ kind: "approve" }`（会话退出 plan 模式并自动开始执行）或 `{ kind: "revise", feedback }`（反馈 1..2000，会话留在 plan 模式）。这不是聊天输入：不进入排队。第一次有效决定为准；他端已决定、回执丢失后重试、或停止后迟到的请求，得到的是已保存的记录（`approved` / `revision_requested` / `superseded` / `cancelled`）及实际反馈，不覆盖。版本不符或不属于该会话、会话正在运行 → `rejected`（附原因）；参数形状错误（含空反馈、超长反馈、多余字段）→ `invalid_params`；旧订阅 → `gone`。
- `plan.exit { subscriptionId } → { mode: "normal", revision }`（`plan-exit-*.json`）：退出 plan 模式；若有待批准的计划，其状态置为 `cancelled`。幂等：已是普通模式时同样成功。`revision` 是此刻的计划摘要 revision，`plan.changed` 与 `chat.patch` 的 `plan` 摘要随后更新。会话正在运行 → `rejected`；旧订阅 → `gone`；参数形状错误 → `invalid_params`。
- 通知 `plan.changed { subscriptionId, revision }`（`plan-changed-notification.json`）：失效提示，不含数据。计划出现、被决定、被取代或取消时发出；`chat.patch` 的状态里的 `plan` 摘要同步更新，App 据 `version` 重新调用 `plan.get`，只接受 revision 不低于已持有的结果。attach 快照里的 revision 与状态同步取得，重连后重新 attach，不依赖通知重放。
- 断线、关闭 sheet、detach 都不会结算问题；停止运行或归档会话会使问题 `cancelled`。App 不得在重连后自动重发答案。

### media

- `media.read { subscriptionId, agentId?, entryId, contentIndex, offset } → { data, nextOffset, total, done, mimeType }`：`agentId` 缺省读主会话，否则读已打开的子详情；越界或他会话引用 → `invalid_params`。

## 不提供

通用方法转发、任意路径、宿主目录浏览、新增/删除工作区、归档/分叉、模型与思考强度修改、凭据、
技能、job、压缩、上传、升级、配对管理（属本机 admin）、待办直接修改、子 agent 提问。新增移动 API 不修改桌面客户端契约。

## 变更流程

1. 修改 `packages/gateway/src/mobile/protocol.ts` 的 schemas（additive：新方法/新可选字段）。
2. 更新 `packages/gateway/test/fixtures/mobile-api-v1/` 对应示例。
3. `bun test --conditions=neko-source packages/gateway/test/mobile/protocol-fixtures.test.ts` 对拍通过。
4. 同步更新本文件与 App 侧解析（fixtures 为双方共用锚点）。
