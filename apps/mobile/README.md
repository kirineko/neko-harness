# NekoAI（neko_mobile）

neko 的 Android 手机端（Flutter），通过局域网 HTTPS/WSS 控制电脑上的 Agent。协议见
`docs/mobile-api-v1.md`，设计见 `openspec/changes/add-flutter-mobile-control/design.md`。

## 开发

固定 Flutter 3.47.7 / Dart 3.13.5（`pubspec.yaml` 的 `environment`），依赖精确锁版本。

```bash
cd apps/mobile
flutter pub get --enforce-lockfile
dart format --set-exit-if-changed . && flutter analyze && flutter test
flutter build apk --release --split-per-abi   # 产物：build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
```

`pubspec.lock` 固定使用官方源 `https://pub.dev`（CI 与之一致）；国内镜像环境请先 `unset PUB_HOSTED_URL FLUTTER_STORAGE_BASE_URL`
再执行 `flutter pub get`，不要把镜像地址写入锁文件。

`flutter test` 包含读取 `packages/gateway/test/fixtures/mobile-api-v1/` 的协议对拍测试；协议变更须同时更新 fixtures、
`docs/mobile-api-v1.md` 与 `lib/core/api/models.dart`。

依赖取舍：不使用 `permission_handler`（14.x 要求 compileSdk 37），相机设置跳转由 `MainActivity` 的 MethodChannel 实现；
`mobile_scanner` 使用 bundled 模型，无 Google Play 服务也能扫码；Markdown 用 `flutter_markdown_plus`（`flutter_markdown` 已停止维护），
HTML 按原文显示；LaTeX 公式用 `flutter_math_fork`（纯 Dart 绘制，无 WebView/JS/网络）+ 自写 Markdown 语法（`lib/ui/widgets/math_markdown.dart`）：
支持 `$..$`、`$$..$$`、`\(..\)`、`\[..\]`，块级公式居中并可横向滚动，非法/未闭合公式保持原文，规则与 Web 的 `math.ts` 对齐。
`markdown` 包因直接导入而声明为直接依赖（版本与既有锁定一致）。引入公式后 release split-abi 体积：arm64-v8a 26.4MB → 27.9MB（+1.4MB，约 5%），
armeabi-v7a 22.4MB → 23.9MB，x86_64 28.9MB → 30.3MB。

代码结构：`lib/core`（网络指纹绑定、配对、RPC、存储、API 模型）、`lib/features`（连接、会话、聊天、审批、子 agent、电脑设置）、
`lib/ui`（主题 tokens、自有图标集与共用组件）。

## 界面、导航与图标

- 紧凑设计 tokens 集中在 `lib/ui/theme.dart`：字阶（正文 14 / 次要 12.5 / 元信息 11 / 代码 12）、间距阶梯 `NekoSpace`、
  收窄的圆角与 `VisualDensity.compact`；页面只引用 tokens，不直接写字号。视觉紧凑但点击热区保持 >=44dp。
- 导航：点击顶栏标题打开会话切换器（工作区芯片 + 搜索 + 会话列表，`lib/features/sessions/session_picker.dart`）；
  顶栏 `+` 是唯一新建入口；左侧抽屉只放电脑与设置、扫码配对。会话列表顺序完全来自服务端（最近消息时间，仅打开不改变顺序）。
- 图标：`lib/ui/neko_icons.dart` 的 `NekoIcon`/`NekoIcons` 是与 Web 一致的 24 栅格线性图标（路径数据经 `path_drawing` 绘制），
  `lib` 内不得使用 Material 的 `Icons.*`（`test/ui/no_material_icons_test.dart` 守护）。新增图标按同一栅格与 1.6 线宽补绘。
- 启动图标：源图在 `assets/brand/*.svg`（不随 APK 打包），Android 自适应前景矢量在
  `android/app/src/main/res/drawable/ic_launcher_foreground.xml`（需与 SVG 路径保持一致）。改图标后运行
  `tool/generate_brand_icons.sh`（依赖 `rsvg-convert` 与 macOS 自带 `sips`）重新生成 Android 旧版位图与 iOS AppIcon。

## 测试版 APK 与 CI 发版

应用名 NekoAI（applicationId 仍为 `dev.neko.harness.mobile`，改名不影响已配对数据）。推送 tag `vX.Y.Z`（须与根
`package.json` 版本一致）时，`.github/workflows/release.yml` 的 `android-check` 做格式、分析与测试，`android-build` 按 ABI 并行构建
`--release --split-per-abi`；全部验证通过后，`github-release` 把 `NekoAI-vX.Y.Z-<abi>.apk`（arm64-v8a / armeabi-v7a / x86_64）附到该
Release。`versionName` 取自根版本，`versionCode` 为 `major*10000 + minor*100 + patch`（split APK 再按 ABI 加偏移）。

当前是**测试版**：没有签名资料时用 debug 签名构建，每次 CI 构建的签名不同，不能覆盖升级，新版本需卸载重装并重新扫码配对；也没有应用内升级机制。
后续在 `android-build` 任务中用 CI secret 生成 `android/key.properties`（见下文「发布签名」）并接入升级机制。仓库没有 push / PR 的
CI，本机改动 `apps/mobile` 后自行运行 `dart format`、`flutter analyze`、`flutter test`。

## TLS 信任与发版

App 不内置任何 CA 或服务器证书（无打包 assets、无 `network_security_config`）：电脑端的自签名证书由 gateway 在本机生成，
手机经二维码/配对文本取得其 SHA-256 指纹，之后的 HTTPS/WSS 连接只信任该指纹（`lib/core/net/pinned_client.dart`，
`SecurityContext(withTrustedRoots: false)`）。因此发版不需要携带任何证书材料；电脑重新生成证书后需要重新配对。
`test/fixtures/tls/` 里的证书仅供单元测试使用，不会进入 APK。

## 发布签名（APK 签名，与 TLS 无关）

release 签名读取 `android/key.properties`（已 gitignore）；缺失时退回 debug 签名，只用于编译验证。本机生成并备份 keystore：

```bash
cd apps/mobile/android
keytool -genkeypair -v -keystore neko-release.jks -alias neko -keyalg RSA -keysize 4096 -validity 10000
cat > key.properties <<'PROPS'
storeFile=neko-release.jks
storePassword=<密码>
keyAlias=neko
keyPassword=<密码>
PROPS
```

keystore 与密码请离线备份：丢失后无法以同一签名覆盖安装，用户只能卸载重装并重新扫码（已配对凭据在 Keystore 中，不随备份迁移）。
同签名覆盖安装会保留配对与草稿。

## 待办与用户提问（add-todos-and-user-questions）

- 能力来自 `server.hello.capabilities` 的 `todos` / `questions`（`ChatController.bind(..., capabilities:)`）：缺少时隐藏全部入口且从不调用
  `todos.get` / `questions.*`（旧电脑只会省略它们）。`chat.attach` 快照与 `chat.patch` 状态里的 `todos` / `questions` 摘要（缺省 = 不支持，
  存在且为 0 = 支持但为空）与 `*.changed` 通知一样只是失效提示。
- 状态在 `lib/features/chat/interactions_controller.dart`：attach 后无条件首查，之后按 revision 重读（只接受不低于已持有的结果；读取期间收到更高
  revision 再读，重读有界）；订阅代次（`_epoch`）隔离切换会话/重连后的迟到结果；离线保留已加载内容但标记为非最新。
- 待办只读：顶栏 `TodoEntry`（如 1/3，列表为空不显示）+ 底部 sheet（`lib/features/todos/todo_sheet.dart`，三态图标+文字、可滚动、全文可见）。
- 问题：输入区上方“等待回答 · N”条 + bottom sheet（`lib/features/questions/question_sheet.dart`）。题目/选项为纯文本，推荐项只标记不预选，
  文字输入始终可见，显式“提交回答”与独立“跳过”；关闭/下拉只关闭（草稿按 server/session/question/version 留在内存，不落盘）；提交中禁用控件，
  失败保留草稿并提示，无回执不做乐观终态、断线后绝不自动重发；他端已结算/停止时显示真实终态。校验与服务端同一规则
  （`question_draft.dart`，长度按 UTF-16 码元，空白判断沿用 JS `trim`，回答 JSON ≤ 16384 字节）。
- 自动展开：进入会话页或问题首次出现，且聊天输入未聚焦、草稿为空、没有其他面板时展开一次；关闭过的版本不再自动展开。有未决问题时输入区提示
  消息会排队到回答之后，并提供打开问题的入口；转录里的 `ask_user` / `todo` 卡片由 `tool.interaction` 渲染（只读）。会话列表在 `awaitingAnswer`
  为真时显示“等待回答”。
- 测试：`test/core/api/interaction_models_test.dart`（fixtures 对拍）、`test/features/chat/interactions_controller_test.dart`、
  `test/features/questions/`、`test/features/todos/`、`test/ui/interaction_layout_test.dart`（窄屏/大字体/软键盘/安全区/共存）等。

## 计划批准（add-plan-approve-mode）

- 能力来自 `server.hello.capabilities` 的 `plan`：缺少时隐藏计划条与会话列表提示，且从不调用 `plan.*`（旧电脑只会省略它）。手机可以查看并决定计划，也可以用 `plan.exit` 取消待批准计划并退出 plan 模式；
  没有进入 plan 模式的入口（协议里也没有对应方法）。
- 状态在 `InteractionsController`：`chat.attach` 快照与 `chat.patch` 状态里的 `plan: { revision, pending, version? }` 与 `plan.changed` 通知都只是失效提示，
  按摘要里的版本调用 `plan.get`；`plan.respond` 只有收到回执才更新（无回执不做乐观结果、断线后绝不自动重发），他端先决定时显示服务端保存的真实状态并附说明。
- 界面（`lib/features/plan/plan_sheet.dart`）：输入区上方“等待批准”条 + bottom sheet，标题按纯文本、有序步骤与说明按 Markdown 渲染（`NekoMarkdown`：不渲染 HTML、不开链接、不加载远程图片）；“批准并执行”、带反馈的
  “要求修改”与“取消并退出计划模式”（1..2000 个 UTF-16 码元，草稿按版本留在内存）；提交中所有按钮都禁用。没有待批准计划时隐藏，会话列表在 `awaitingPlan` 为真时显示“等待批准”。
- 测试：`test/core/api/plan_models_test.dart`（fixtures 对拍）、`test/features/chat/plan_controller_test.dart`、`test/features/plan/`、
  `test/features/sessions/session_awaiting_test.dart`。

## 真机回归

`scripts/mobile-e2e-gateway.ts` 启动隔离数据目录与脚本化 faux 模型的 gateway（不访问外部模型）：

```bash
bun --conditions=neko-source scripts/mobile-e2e-gateway.ts --address <电脑局域网 IPv4> --port 8324 --serve-pairing 8325
adb reverse tcp:8325 tcp:8325
cd apps/mobile && flutter test integration_test/mobile_e2e_test.dart -d <设备>
```

集成测试经回环取新鲜配对文本，随后走真实局域网 TLS 指纹绑定、配对、WSS 与 JSON-RPC，覆盖新建会话、流式回答、
子 agent 审批、子详情、忙碌排队与停止、长内容展开；另有一条待办/提问用例（消息含「待办」「提问」「多选」触发脚本化 faux 模型的 `todo` /
`ask_user` 调用）：手机可见待办进度与只读列表、单选/多选回答、关闭不结算、经 `connectPaired` 真实重连后重新 attach/查询并显式提交、
回答后再次重连同步最终状态。注意：该用例**尚未在真机/模拟器上执行**，执行后再把结果记在此处。手工验证 release 包时可直接扫码，或粘贴 `<数据目录>/pairing.txt`。

## M0 真机验证记录

- 日期：2026-10-15
- 设备：V2419A，Android 16（API 36，arm64）
- 电脑侧：macOS 26.6.2，Bun 1.4.2，临时隔离数据目录与 faux provider
- App 侧：Flutter 3.47.7，Dart 3.13.5，release arm64 APK

已通过：

- 首次扫码配对；首次拒绝相机权限后进入系统设置授权，返回并重试成功。
- 错误自签名证书、已过期证书、伪造签发者攻击链均在 TLS/证书校验阶段拒绝；攻击链测试服务端未收到任何配对 HTTP 请求。
- App 进程结束后重启，无需扫码即恢复连接并完成 `server.hello`。
- gateway 重启后，同一证书与授权保持不变，App 自动恢复连接。
- App 退到后台 5 分钟后返回前台，连接恢复为 ready。
- 本机 admin 服务撤销设备后服务端删除授权；App 显示“设备授权已被电脑撤销”，停止重试并仅提供重新扫码入口。

同时通过：`flutter analyze`、`flutter test`（87 个）、`flutter build apk --release --split-per-abi`；仓库侧 `bun run check`、`bun run build` 与全量 Bun 测试（656 个）。
