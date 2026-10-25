# AGENTS.md

## 项目

neko-harness：基于 Pi 生态（pi-durable / pi-ai / chord / pi-env / pi-tui 1.4.0，全部精确锁版本）的 agent harness monorepo。Bun 推荐 1.4.4（任意 1.4.x 可用）。设计决策见 `openspec/changes/archive/2026-10-11-bootstrap-neko-harness/design.md`。

## 常用命令

```bash
bun install --frozen-lockfile # 安装（按 bun.lock 安装）
bun run build              # tsc 构建全部 workspace 包（web 含 vite build）
bun run test               # Bun test（源码条件 + 多 worker 并行，隐含文件隔离）
bun run test:serial        # 原顺序执行（--isolate）；怀疑并行引入的失败或时序问题时先用它复现
                           # 不要在同一台机器上同时跑两套完整测试：部分用例用 ps 按固定标记判断进程，会互相干扰
bun run check              # biome check + 根/Web 客户端类型检查
bun run check:write        # biome 修复 + 根/Web 客户端类型检查

bun run neko tui        # 启动终端 UI（自动拉起 gateway；需 DEEPSEEK_API_KEY）
bun run neko web        # 启动 Web UI（静态 8322，自动拉起 gateway WS 8321）
bun run neko serve      # 仅启动 gateway（Unix socket + WebSocket）
# 或构建后：bun packages/cli/dist/main.js tui|web|serve（bin 名 neko）
```

发版：推送 `vX.Y.Z` tag 触发唯一的 `.github/workflows/release.yml`（没有 push / PR CI），流程与发布说明（`docs/releases/vX.Y.Z.md`）见 `docs/dev/releasing.md`。

单个示例（需要 `DEEPSEEK_API_KEY`）：`bun --conditions=neko-source packages/core/examples/chat.ts`

## 约定

- TypeScript strict + `noUncheckedIndexedAccess` + `erasableSyntaxOnly` + `verbatimModuleSyntax`（`tsconfig.base.json`，风格参照 `reference/pi`）。
- 相对导入带 `.ts` 扩展名（`rewriteRelativeImportExtensions` 在构建时改写成 `.js`）；TS 运行用 Bun，构建用 tsc。
- Biome：tab 缩进、双引号、lineWidth 120（`biome.json`）。
- 上游 pi 依赖为实验性包：只升版本不裹代码，升级走显式 OpenSpec 变更；core/gateway 做薄封装隔离上游类型。
- 文档放置规则见 `docs/README.md`：入口文档在根目录与 `docs/`（`dev/`、`mobile/`、`releases/`），包内文档跟随包；英文文档不含中文，开发者内部文档只有中文。改文档路径要同步引用（含源码注释）。
- 不要修改 `openspec/`（除非该变更本身要求）与 `reference/`（只读参考，已 gitignore）。
- 不要提交 lockfile 之外的意外文件；不主动 git commit。
- 真实 API key 只从环境变量读取，不打印、不落盘。

## 模型 provider

- 凭据 / provider 目录是 core 的纯模块 `credential-providers.ts`（子路径 `@neko-harness/core/credential-providers`，前端共用）：`MODEL_PROVIDERS`（Pi 1.4.0 里纯 API Key 的 32 个 provider，封闭集合）与 `SEARCH_CREDENTIAL_PROVIDERS`（Tavily）。目录的 `envVar` 由 `provider-settings.test.ts` 与 Pi 的 `checkAuth` 对账，升级 Pi 时该测试失败即需显式更新目录；Azure / Anthropic / Cloudflare / Bedrock / Vertex / OAuth 类 provider 不在范围内。
- 运行时注册目录内全部 Pi provider，但只有「已启用」的才可选：启用集合存于 `app.neko.provider-settings` 文档（缺省仅 deepseek，DeepSeek 锁定不可取消），`listSelectableModels()` 只含已启用 provider 的模型并带 `available`（有无凭据），`listModels()` 仍是全部模型供按会话模型查找（投影、图片能力）。经 `options.providers` 注入的非目录 provider（测试 faux）不受启用 / Key 门禁。
- 受理输入、`compact`、子 agent 启动与会话命名统一走 `guardProvider`：先 `PROVIDER_DISABLED`，再 `PROVIDER_KEY_REQUIRED`（`CODE: 文案` 前缀，网关原样透传）。`--model` / `defaultModel` 指向未启用 provider 不阻止启动，只在提交时拦截。自动压缩 `triggerPercent` 按每个模型自己的窗口计算（见「Pi 1.4 使用要点」），与启用了哪些 provider 无关。
- 网关 `neko.credentials` v2：`statuses` 是按 provider id 的映射（模型 provider 带 `enabled`），`setEnabled` 修改启用；`neko.models.list` 返回可选模型。应用协议 9。Web 在凭据状态变化后重拉模型列表；设置页：`/settings` = 模型服务，`/settings/search` = 联网搜索（Tavily Key 与搜索服务选择）。
- 新会话模型的解析链：会话级显式指定 > CLI `--model`（core 的 `options.modelOverride`）> UI 保存的默认模型（`app.neko.default-model` 文档，`{ model: NekoModelRef | null }`）> 配置文件 `defaultModel`（`options.model`）> 内置 `deepseek/deepseek-flash`。网关 `neko.default-model` 契约发布 `{ effective, source: cli|saved|config|default }` 并提供 `set`/`clear`（校验目录内已知模型且 provider 已启用，不查 Key）；Web 模型选择器与 TUI `/model`（`d` 键）对可选模型「设为默认」，无 Key 条目不可设。保存值的 provider 后被取消启用时不回退，新会话照取、提交时 `PROVIDER_DISABLED`。

## 提示词与技能

- 系统提示词由 core 的 `neko-prompt` 扩展按五节组装：`preamble` / `rules` / `project_context` / `skills` / `cwd`（`packages/core/src/prompt/`）。
- 项目指令注入两级 AGENTS.md：`~/.agents/AGENTS.md` 与 `<workspace>/AGENTS.md`；不向上遍历、不识别其他文件名。
- Skills 目录：`~/.agents/skills/<name>/SKILL.md` 与 `<workspace>/.agents/skills/<name>/SKILL.md`（YAML frontmatter，同名项目级优先）；提示词只注入元数据，正文由模型用 read 工具自取。新用户输入提交时准备资源快照，只有该输入进入 transcript 后才激活；无新输入 placement 的工具轮复用活动快照。排队、被拒绝或撤回的输入不提前影响当前 run；快照按会话隔离，各节共享一次构建。进程重启后按当前磁盘资源重建。
- 显式调用：`/skill:<name> [args]` 在 core 准入层展开为 `<skill>` 用户消息（未知技能透传）；被调用技能的元数据与正文同次读取，不常驻保存全部技能正文。同批多输入的系统资源以最后一个输入快照为准，已展开正文保持原样。前端经 `chat.skills(null)` 实时取列表做补全，查询不改变活动快照，不本地展开。

## 排队与插队

- 忙时输入由 pi-durable 持久排队：`whenBusy: "followUp"`（缺省，回答后放入）或 `"steer"`（当前工具轮后放入）。Web 与移动端发送一律排队，输入区不预选引导，引导/撤回在排队条上；TUI 同样忙时 Enter 只排队，排队区用 Alt+↑ 选中、↑/↓ 移动，Enter=Steer、Esc=只撤回选中项（`queueKeyAction`，选择期间 Esc 不停止运行）。
- 排队真相是 `pi.inbox`：core 的 `projectQueued`（`queued.ts`）只投影用户输入（排除 `write`、`jobReport`、`subagentRoundId`），经 `ChatView.queued`（缺省 = 旧网关，空数组 = 支持且无排队）到各端；预览有界（`QUEUED_PREVIEW_CHARS`），不含图片数据与技能正文。
- 单条撤回走 `NekoSession.withdraw` → gateway `chat.withdraw` / 移动 `chat.withdraw`，返回 `withdrawn | placed | settled | unknown`，`withdrawn` 时带完整原文用于取回草稿（图片不恢复）；`abort` 仍撤回全部排队并中止运行。
- 排队项改引导走 `NekoSession.steer` → `chat.steer`：pi-durable 无改模式接口，core 撤回原项后以相同 content/entry 用 `whenBusy: "steer"` 重新受理（requestId `steer:<原>`，资源快照经 `resourceSnapshots.move` 迁移），返回新的提交 id，前端以视图列表为准；重新受理失败按撤回返回原文。前端用 `queueClient`（`QUEUE_UNSUPPORTED`）探测能力，沿用 jobs 的可选扩展模式，不提升应用协议。

## 后台任务

- core 的 `job` 工具（`packages/core/src/jobs.ts`、`job-engine.ts`）基于 `env.exec` 运行后台命令（不用 pty）；任务状态存 `app.neko.jobs` 文档，运行中输出只在内存。任务结束/崩溃经 `jobReport` 输入回报并触发新一轮，投影为带 `jobId` 的 `system` 项，不进入输入历史。
- 前端入口：Web 顶栏「任务」面板、TUI `/jobs`；经网关 `jobOutput`/`jobStop`（`jobsClient`）和 `ChatView.jobs` 读取，`ChatView.jobs` 缺省表示旧网关。数值上限集中在 `JOB_LIMITS`，改动需同步 spec。

## 待办与提问

- `todo` / `ask_user`（`packages/core/src/todos.ts`、`user-questions.ts`）只给主 agent：`MAIN_ONLY_TOOLS`（`subagents.ts`）在子 agent 新建、启动修复中剔除，执行端再校验角色。限制、校验、答案草稿助手全在纯模块 `interactions.ts`（子路径 `@neko-harness/core/interactions`，前端与 `contract.ts` 共用，改数值需同步 spec 与 Dart 契约）。两工具均 `replay: "safe"`、`executionMode: "sequential"`（整轮串行）、`callers: ["model"]`。
- Todo：`app.neko.todos`（rewindable / `fork: "asOf"`），模型整体 `replace`、用户只读；`replace` 的调用级回执（task 文档）与列表同次 commit，`list` 纯读取无回执。
- 提问：问题记录是 `app.neko.question` 文档 family（key = 工具 task id，`fork: "initial"`），`app.neko.questions` 只存未决 id 索引。回答走 `NekoSession.respondQuestion` → gateway `questionRespond`，不是聊天输入；首次有效结算为准，之后返回原记录；`live()` 检查 task owner 链，停止/归档/重启对账把失效未决问题置 `cancelled`。回答 = `{ kind: "answer", optionIds?, text? } | { kind: "skip" }`（选项可与文字并存；`optionIds` 按选项顺序规范化）。`recommended` 只是提示，不预选。排队的 steer / followUp 都等问题结算后才进入上下文。
- 可选能力：`ChatView.todos` / `ChatView.questions` 缺省 = 旧网关，空 = 支持且无内容；`SessionSummary.awaitingAnswer`（缺省 = 不支持，会话 `status` 仍是 `running`）。前端用 `todosClient` / `questionsClient`（`client-session.ts`）探测，不提升应用协议。问题与选项一律按纯文本显示。

## Plan 模式

- 会话级只读规划模式（`packages/core/src/plan.ts`、`plan-doc.ts`、`plan-bash.ts`）：agent 先调研、用 `submit_plan` 提交结构化计划，用户批准后才获得写权限并自动执行。权威是 `app.neko.plan` 文档（`PlanDoc`，rewindable / `fork: "asOf"`，`{ mode, revision, items }` 保留最近 5 条，每条带 `version`、`taskId`、`status`、`dispatched`）；agent 配置（`tools.remove` edit/write/job、`modelTools.add` submit_plan、`instructions`）只是它的投影，`syncPlanAgent` 在受理输入前与启动时对账（以 `instructions === PLAN_INSTRUCTIONS` 为标记，幂等 `configure`），重启中断可自愈。
- `submit_plan`（`deferred`、`sequential`、`terminate`）只在 plan 模式经 `modelTools.add` 暴露，按工具 task id 幂等；提交后 run 结束，计划待批准，会话空闲。切换模式与决定只在空闲时受理（`PLAN_BUSY:` 前缀错误），经 `admit` 串行。决定是 `NekoSession.respondPlan`（gateway `planRespond`），不是聊天输入：按 `version` 首次有效结算；批准在同一次 commit 里退出模式，再用 requestId `plan-exec:<version>` 提交执行输入（要求修改为 `plan-revise:<version>`，保持 plan 模式），输入带 `InputData.planDecision`，投影为带 `planDecision` 的 `system` 项、不进输入历史与排队预览；`dispatched` 未置位的已结算决定在启动时补发。
- 失效：`NekoSession.abort()`（归档经它）与离开 plan 模式把待批准计划置 `cancelled`，普通输入受理成功后、或 `submit_plan` 时 inbox 已有排队用户输入，计划置 `superseded`（保持 plan 模式）。重启不取消待批准计划。
- 只读三层：`tools.remove`；`neko-plan` 扩展的 `beforeTool`（edit/write/job 与不安全 bash）；`wrapTool(createBashTool())` 执行端复核。bash 判定是纯模块 `plan-bash.ts` 的 `isSafeCommand`（引号外切段、白名单正则 + 危险参数/内容拒绝，白名单外一律拒绝；是护栏不是沙箱）。`submit_plan` / `neko-plan` 属 `MAIN_ONLY_*`；`subagent` 工具在 plan 模式拒绝启动与继续 coder。
- 可选能力：`ChatView.plan`（`{ mode, revision, current }`，缺省 = 旧网关）、`SessionSummary.awaitingPlan`、方法 `planGet` / `planRespond` / `planMode`（不在 `configure` 的 change 里）；前端用 `planClient`（`client-session.ts`，`PLAN_UNSUPPORTED`）探测，不提升应用协议。Web 只用 `/plan` 切换并显示模式标识，TUI 用 `/plan`（有待批准时打开计划面板）与 `Shift+Tab`；新计划到达时与问题面板同规则自动打开（`PlanDock.autoOpen`，复用 `canAutoOpen`，每个版本只一次）；移动端只能查看与决定，不能进入 plan 模式。「取消并退出计划模式」不是新决定，只是对 `planMode("normal")`（`setPlanMode` → `PlanService.setMode` 把待批准计划置 `cancelled`）的快捷入口：Web 计划卡片、TUI 计划面板（`X` 键）、移动 `plan.exit`（只能退出，幂等）都复用它。计划的 `steps` / `note` 是 Markdown（Web `Markdown` 经 DOMPurify、Dart `NekoMarkdown`、TUI pi-tui `Markdown`，控制字符先剥离），`title` / `feedback` 仍按纯文本。限制集中在 `PLAN_LIMITS`（`interactions.ts`），改数值需同步 spec 与 Dart 契约。

## Codemode

- 模型写 JavaScript 脚本批量调用工具（基于 `@earendil-works/pi-codemode` 与 pi-durable 的 `codemode` 扩展，`packages/core/src/codemode.ts`、`codemode-mode.ts`）。三种模式：`off`（缺省）、`on`（普通工具之外再提供 `codemode`）、`only`（模型只见 `codemode` 加 todo / ask_user / subagent；edit/bash 规则照常）。扩展在注册表常驻安装；`off` 时会话的 agent 配置移除该扩展（工具与提示词节随之消失），`only` 再用 `modelTools` 收窄模型可见工具。
- 数据位置：全局设置是 `app.neko.codemode-settings` 文档（`{ mode | null }`，根会话，`null` = 回落配置文件 `codemode.mode`）；解析优先级 UI 保存值 > 配置文件 > `off`（`resolveCodemodeSettings`）。会话创建时的模式固化进 `app.neko.codemode` 文档（rewindable / `fork: "asOf"`），**只对新会话生效**，改设置不影响已有会话；子 agent 继承父会话模式。运行时 `codemodeSettings()` / `setCodemodeMode()` / `resetCodemodeMode()`。
- Agent 配置是 plan 模式与 codemode 的联合投影：纯函数 `agentChangeFor({ plan, codemode, role })`（`agent-change.ts`）产出唯一的 `tools` / `modelTools` / `callable` 配置，`agentSyncChange` 判断是否需要对账；运行时 `syncAgent` 在受理输入前与启动时幂等应用，plan 与 codemode 不得各自写配置。脚本内可调用的工具由 `callers` 决定（`subagent` 仅 `["model"]`，`job` 可从脚本调用）。
- 嵌套改动记录：脚本里的 `edit` / `write` 不产生独立的 toolCall 条目，经 `nestedChangeWraps`（`nested-changes.ts`）把成功的嵌套调用记入 `app.neko.nested-changes` 文档，`ChangeTracker` 叠加到「本次改动」（`change-limits.ts` 集中上限）。
- 沙箱限额集中在 `CODEMODE_LIMITS`：worker 同时最多 2 个、每个 256 MiB，`WorkerLimiter` 排队等待上限 60 秒（超时 `SANDBOX_BUSY`）。改数值需同步 spec。
- 投影：`projection.ts` 的 `CodemodeView`（`calls` 最多 100 条、参数 / 错误各 200 字符、`omitted`、`fullOutputPath`）经 `ChatItem.codemode` / 流式 `call.codemode` 到各端；缺省 = 普通工具项或旧网关。Markdown / HTML / JSON 导出带脚本与调用列表。网关 `neko.codemode-settings` 契约（`{ effective: { mode }, source }`，`set` / `reset`）；应用协议 10。移动端只显示卡片，无设置入口，不提升移动 API 版本。
- 前端：Web `/settings/codemode` 与 `CodemodeCard`，TUI `/codemode` 面板与工具卡调用列表，Dart `CodemodeInfo`。`codemode` / `/codemode` 在 `protected-terms.json` 中受保护，三端文案必须保留。

## 工作区登记与移除

- 工作区目录是 `app.neko.workspaces` 文档；移除用独立墓碑文档 `app.neko.workspaces-removed`（`{ paths }`），两者同一次提交修改。`registerWorkspace(path, explicit)`：隐式（启动扫描会话 cwd、`forkConversation`）遇到墓碑路径直接跳过，显式（`addWorkspace`、带 cwd 的 `createConversation`、启动时的 `defaultCwd`）会清除墓碑再登记。新增登记入口必须经它并选对 `explicit`。
- `NekoRuntime.removeWorkspace(path)` 只改登记，不删文件、不归档会话；校验顺序 `WORKSPACE_UNKNOWN:` → `WORKSPACE_LAST:`（至少保留一个）→ `WORKSPACE_BUSY:`（该目录非归档会话 `running` / `awaiting` / `awaitingPlan`）。`listConversations()` 跳过墓碑工作区下的会话（经已知 id 的 `getConversation` 仍可取），重新显式添加即恢复。错误文案常量在 `workspace.ts`，英文由 `core-ui-strings.json` 的 `webErrors` 钉住，只有 Web 映射（TUI / 移动端不提供移除入口）。
- 网关 `neko.workspaces` 契约 v2 新增 `remove`（经 `serialize` 与 `add` 串行），应用协议 9；不提供旧网关降级。Web：工作区切换器每行有移除按钮（hover / 聚焦显示，触屏常驻），确认框后调用 `GatewayConnection.removeWorkspace`；Web 启动目录（`webInfo.launchRoot`）和仅剩的一个工作区置灰不可移除。移除当前工作区成功后切到目录里的下一个，失败不切换；别的客户端移除了当前工作区时（`#workspaceGone`）自动切到第一个。移动端沿用 `workspaces.changed` 回退逻辑，无需改动。

## 工作区浏览与改动

- 只读、会话级：`NekoChat.workspaceDir` / `workspaceFile` / `changesList` / `changeGet`（经 `NekoSession` 同名方法），工作区根取自会话 cwd，客户端只传相对路径。目录子项复用 `WorkspaceFiles` 的平铺枚举缓存（gitignore、不列 `.git`、符号链接不跟随、50k 条上限，截断即 `incomplete`），读取经 `relativeQuery` + `workspaceTarget`（realpath 越界检查），上限 `BROWSE_LIMITS`；`isProtectedPath` 命中的凭据文件（`.env*`、`*.pem`/`*.key`、私钥）只见不读，改动模式需同步 spec。
- 「本次改动」是 `ChangeTracker`（`file-changes.ts`）从会话条目（`edit`/`write` 的 toolCall 参数 + 成功的 toolResult）按 callId 配对派生的，含子 agent，增量扫描、不持久化；revision = 成功调用累计数。只反映 agent 的 edit/write，不含 bash 造成的改动；`write` 无旧内容，diff 是整文件新增。上限在 `CHANGE_LIMITS`，超限置 `truncated`。
- 可选能力：`ChatView.changes` 缺省 = 旧网关；Web 用 `workspaceClient`（`client-session.ts`，`WORKSPACE_UNSUPPORTED`）探测，不提升应用协议。

## Web 打开工作区

- 只在 Web 服务端实现（`packages/web/src/open-api.ts`、`open-target.ts`），不经 gateway、不提升应用协议：`GET /api/local/session` 发放 CSRF 并下发 `targets`（VS Code / 文件管理器及可用性），`POST /api/open` 在本机 `spawn`（不经 shell，路径只作参数）拉起；路径必须是已存在的绝对目录。
- 守卫与 `/api/mobile/*` 共用 `local-guard.ts`（回环 peer → Host → Origin/Sec-Fetch-Site → CSRF/JSON/体上限）；非本机访问得到 403，前端 `fetchOpenSession` 返回 `null` 即隐藏入口。改守卫需同时跑 `mobile-admin.test.ts`。
- 平台命令集中在 `resolveLaunch`：WSL（linux + `WSL_DISTRO_NAME` 或 `/proc/version` 含 microsoft）按 Windows 处理，文件管理器为 `explorer.exe .`（cwd = 工作区），标签「资源管理器」；Windows 的 VS Code 由 `code.cmd` 位置推出 `Code.exe` 直接启动。每次打开前重新探测。
- 前端 `OpenWorkspaceMenu`（顶栏分体按钮）用 localStorage `neko.openTarget` 记住上次目标；工作区栏入口是 `panel-right` 图标加改动数角标（保留 `data-workspace-entry`）。无快捷键。

## Web 外观

- 主题（樱花 sakura 默认 / 纸白 light / 夜墨 dark）与聊天排版（字体、字号、字重、行高）只存浏览器 localStorage `neko.appearance`，不经 gateway、不提升应用协议、不影响 TUI/移动端。设置页 `/settings/appearance`，偏好权威是 `lib/appearance.ts`（取值列表、逐项回落、`storage` 事件跨标签页同步）。
- 生效方式是 `<html>` 上的 `data-theme` / `data-chat-font|size|weight|leading`（默认值省略属性）；`index.html` 首屏内联脚本只搬运匹配 `/^[a-z0-9-]{1,16}$/` 的字符串，样式表不认识的值等于默认。
- 三套主题共用 `styles.css` 的同一批 token 名，只换值：`[data-theme]` 块覆盖色阶（深色主题色阶反相）、派生 token（渐变、`--on-accent`、`--focus-ring`、diff 色、阴影等）。组件里不要写 `text-white`、`bg-white` 等字面量色（二维码除外），用 token。阴影 token 在每个主题块写字面量（`var()` 会在 `:root` 上提前解析）。sakura 色阶在 `@theme` 与 `[data-theme="sakura"]` 各有一份，由 `theme-contrast.test.ts` 对拍；该测试同时按主题守护关键色对 WCAG 对比度，改色值时以它为准。
- 聊天排版只作用于 `.bubble-user` / `.bubble-assistant` / `.md` 正文 / `.composer-input`，经 `--chat-*` 变量；代码块、工具卡、侧栏不变。字体只用系统字体栈，不打包字体文件。

## Web 右侧面板宽度

- 工作区栏、后台任务（jobs）、子 agent 三个右侧面板互斥、占同一位置，**共用一个宽度**：`SIDE_PANEL_WIDTH`（`lib/layout.ts`，320–960、默认 560、步进 24），任何情况下 CSS 另有 `lg:max-w-[60vw]` 兜底。偏好只存浏览器 localStorage `neko.panelWidth`，不经 gateway、不提升应用协议、不影响 TUI/移动端。
- 权威是 `lib/panel-width.ts`（`parsePanelWidth` 逐项回落与夹取、`createPanelWidthStore`、`usePanelWidth`）：拖拽中 `set` 只改内存，结束才 `commit` 写盘（默认值删除存储项），`storage` 事件跨标签页同步，存储不可用时只在内存生效。
- 调整柄是共用的 `components/resize-handle.tsx`（ARIA separator，指针拖拽 / ←→ / Home·End / 双击恢复默认，拖拽期间给 `<body>` 加 `is-resizing-panel`）；面板根元素必须是 `lg:relative` 且贴右缘，柄只在 `lg` 以上显示，窄屏抽屉不使用该宽度。新增右侧面板时复用它，不要另写拖拽逻辑。

## 界面语言

- Web / TUI / 移动端各自支持 `zh`（默认）与 `en`，偏好互相独立，不经 gateway、不提升应用协议、core 不感知语言。Web：localStorage `neko.language`（`lib/language.ts`），设置页 `/settings/language`；TUI：`~/.neko/tui.json`（`language-settings.ts`），优先级 `--lang` > `NEKO_LANG` > 已保存 > `zh`，`/language` 即时切换，`neko tui --help` 随语言输出；移动端：`PrefsStore` 持久化 + Flutter gen-l10n（`apps/mobile/lib/l10n/app_zh.arb` / `app_en.arb`，生成物提交入库），选择器与主题选择器同处。
- 文案是类型化字典（Web `lib/i18n/{zh,en}.ts`、TUI `src/i18n/{zh,en}.ts`、移动端 ARB），统一 `t(key, params)`；新增文案必须两种语言同时补，缺键由类型或测试拦截。英文风格：简短、首字母大写、句末不加句号，子 agent 统一写 `sub-agent`。日期 `zh-CN` / `en-GB` 格式化集中在各端 `format`。
- 受保护术语（`/plan`、`/skill:` 等命令、`pi.inbox`、provider 与工具名等不应翻译的词）列在 `packages/core/src/i18n/protected-terms.json`（`protected-terms.ts` 读取），三端字典测试对拍：中英文案都必须保留这些词。
- core / gateway 推送的英文文案（工具标题、状态、错误前缀等）在前端映射成当前语言（`core-text`），映射表由 `packages/core/test/fixtures/core-ui-strings.json` 与 `core-ui-strings.test.ts` 对账；core 改了推送文案，该测试失败即需同步各端映射。映射不到的原样显示。已知遗留：gateway 自己拼的中文错误在 `en` 下仍是中文。
- 防回退：Web、TUI 各有扫描 CJK 字面量的测试（Web `test/support/cjk-scan.ts`），只允许白名单内的条目（语言名本身、协议数据等），白名单要有理由；移动端同理扫描 `lib/` 下的 Dart 字面量。不要在组件里直接写中文或英文用户可见文案。

## Pi 1.4 使用要点（以已安装发布包的类型与行为为准）

- durable 异步调用使用 `Context`（core 默认 `BACKGROUND_CONTEXT`）；远程 Chord 引用（`Ref`）方法使用可选 `Ctx`，普通调用自动 root，需要取消/组合时使用 host.root；ctx 只能给创建它的 host 的引用用（否则 `invalid/foreign_ctx`）。
- Chord（1.3 起沿用，1.4 未变）：契约 `remote(..., { host: hostNamed(...) })` 声明放置，调用方不再传 `{ at }`；工厂返回 `variant`（非 `kind`）；`self.state(name, schema, initial)`、`self.resource(name, { version, ... })`、`self.on(name, source, handler)` 按名声明；`lifetime: "host"` 取代 `eager`。`host.get` 异步并等首个状态快照，`host.hold` 同步可能仍 loading（状态在水合前读取会抛 `not_ready`，已结束的引用读取会抛其结束错误）；状态类型是 `T` 不含 `undefined`。对状态的监听器会在重订阅时再收到当前值，必须幂等对账。Chord 未导出 `MethodSpec`，`gateway/contract.ts` 用 `contract()`/`rpc()` 元组封装以保持声明可移植。
- 网关：host 名固定为 `GATEWAY_HOST`（`neko`），`serverId` 由应用信息校验（`GatewayIdentityError` / `assertGatewayIdentity`），客户端 host 一律用 `createClientHost(link)`；主体类型是 `GatewayPrincipal`。链路协议版本由 Chord 的 `PROTOCOL_VERSION` 决定（1.3.0 与 1.4.0 均为 4）：协议版本不同或握手无法解析（如 Pi 1.2 网关）会被客户端报告为 `ApplicationProtocolError`（不可重试）。服务端 WebSocket 不接受压缩帧；`ws` 在 Bun 下经 `addEventListener` 把文本帧交成 Buffer，因此有界链路用 `on("message", (data, isBinary))`。
- 存储：`openNodeSqliteStorage(path)`（自动建父目录）或 `MemoryStorage`；一个存储同时只被一个 Harness 打开。1.4 打开 SQLite 时自动迁到 schema v2，之后 1.3 及更早版本不能再打开，不可回退。
- 文档定义：`defineDoc` / `defineDocFamily` 必须显式 `checkpointWhen`，本项目一律 `() => false`（改动只存增量，等价 1.3 缺省）；新增文档定义不能省略。
- 任务等待：`TaskRuntime.sleep()` 已删除。跨阶段的等待用 `runtime.sleepUntil(until, checkpoint, ctx)`（任务进入 `sleeping`，不占 invocation，重启后按 Harness 时钟继续，如会话命名的 `wait` 阶段）；阶段内短等待用 `runtime.setTimer` 加 `runtime.signal`（不落盘，如子 agent 准入轮询 `subagents.ts` 的 `pause`）。穷举任务状态的代码要处理 `sleeping`。
- 崩溃停放：同一任务被崩溃连续截断 `settings.restartLimit`（默认 5）次且未提交新状态即被停放，经 `onReport`（`task_parked`）报告一次，`Harness.retryTask` 才能再运行；正常 `close()` 不计数。本项目保持默认且不提供恢复入口。测试里模拟崩溃：关闭后用裸存储把任务记录写成 `running` 加 `restarts`（见 `crash-loop.test.ts`）。
- 上下文设置：`context.compaction`/`context.pruning`（配置文件）与 UI 保存值（`app.neko.context-settings` 文档）按保存值 > 配置 > 默认解析（`packages/core/src/context-settings.ts`）；压缩通过 `Harness.open` 的 `settings.compaction` getter 即时生效，未设置的字段不传，保持原生策略。`triggerPercent` 变成覆盖整个模型目录的 `modelOverrides["provider/modelId"].reserveTokens`（`createCompactionPolicy` 按设置状态引用缓存），每个模型在自身窗口的该百分比处阻塞压缩；后台压缩仍在阻塞阈值前 32768 tokens 开始，所以小窗口模型几乎总是后台压缩。`enabled`、`keepRecentTokens` 仍是全局值。
- 请求身份：`Harness.open` 显式传 `identity: { userAgent: "detailed", attribution: PI_ATTRIBUTION }`，即与 Pi 完全一致的 UA（`pi/<版本> (...)`）和 provider 归属，因为部分模型厂商只认 Pi 的客户端。这与 Pi 当前默认相同；`request-identity.test.ts` 记录 provider 实际收到的 `options.identity`，升级 Pi 后该测试失败就要显式决定是否跟随新默认。
- 工具结果裁剪（`packages/core/src/context-pruning.ts`，默认关闭）：`ContextPruner` 监听提交，成功回答的占用 ≥ 阈值时写入 `app.neko.context-prune` 条目（`requestId = prune:<助手条目 id>`），其 `edits` 把旧大工具结果替换为占位；只改模型上下文，原条目、投影与统计不变（投影对该种类无分支）。
- 会话：`harness.root(context, { agent })` → `conversation.submit({ type: "input", content }, context)` → `submission.wait(context)`；同 `requestId` 重复提交幂等（含重开后）。
- 前端渲染数据源：`conversation.viewState(context)` / `conversation.watch(context)` / `watchEvents(harness, id, context)`。
- 用量：`harness.snapshot(UsageDoc, conversationId, context)` 或 `harness.usage(context)`（Session 总量）。
- 会话目录：宿主侧无 `scanConversations`，用 `harness.commit(tx => tx.scanConversations({}, n, undefined), context)`；无删除 API（core 用 `app.neko.conversation` 文档做软删除）。
- 会话级配置：`conversation.configure({ model, thinkingLevel }, context)` 单次提交生效，从下一次请求起使用；`conversation.agent(context)` 返回解析后的生效值（thinkingLevel 一定有值）。
- 扩展热替换：`registry.install(同名扩展)` 原地替换；已开始执行的工具调用沿原实现跑完，下一个 task phase/请求/调用才解析新代码（会话只存扩展名，重启后装回同名扩展即恢复）。
- 工具结果使用 `output`（模型）、`structuredOutput`（程序）与 `details`（UI，随工具消息持久化）；消息自身仍用 `content`。输入的 `entry: { kind, data }` 与内容原子持久化，排队期间位于 InboxDoc。
- 存储致命错误终止 Harness，`closed`/watch `session_failed` 通知结束；独立无效读取 StorageRequestError 只失败该请求，在 commit 中仍终止运行时。不重试 StorageRejected。
- 原生 read 统一文字/图片，上游 Photon 处理器负责工具读图；附件仍严格校验。listFiles 来自 pi-env LocalExecutionEnv，共享按需 Connection，关闭时释放；@ 补全不依赖 fd，缓存与刷新边界见升级 design D11。
- 以已安装的 1.4.0 类型为准，reference main 可含未发布修复（例如 main 上 `Storage.commit` 的签名与发布包不同）；升级设计见 `openspec/changes/archive/2026-10-17-upgrade-pi-sdk-1-3/design.md` 与 `openspec/changes/archive/2026-10-24-upgrade-pi-sdk-1-4/design.md`。ConversationId 是数字 brand（ROOT = 1），未知 id 的 harness.conversation() 返回 undefined。
