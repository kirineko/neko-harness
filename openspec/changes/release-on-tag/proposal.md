# Proposal

## Why

GitHub Actions 现在有三个 workflow，职责重叠、发版流程靠人工衔接：

- `ci.yml`（push / PR，ubuntu + macOS）、`mobile.yml`（push / PR，Android）和 `release.yml`（GitHub Release 发布后触发）各自安装、构建、测试；每发一版，同样的验证在 push 与 Release 上各跑一遍（最近一版：CI 约 3.5 分钟 + Mobile 约 8 分钟 + Release 约 8 分钟），Android 的 format / analyze / test 在 `mobile.yml` 与 `release.yml` 里完全重复。
- 发版要先 push 版本提交，再到 GitHub 页面手动建 Release 才触发 `release.yml`；npm 先发布、APK 后上传，Android 构建失败会留下一个只有 npm 包的半成品版本。
- Windows 是受支持平台（Git Bash 命令执行、WS-only 网关、`neko update` 的 Windows 分支），但 CI 从未在 Windows 上跑过；上一次 Windows 验证是 10-20 的本机手测，之后新增的功能都没有验证过。
- 每个 job 都带 Node 20 弃用警告：`actions/checkout@v4`、`setup-java@v4`（另被标为 deprecated）、`upload-artifact@v4`、`download-artifact@v4`、`setup-node@v4` 仍以 Node 20 为运行时，目前由 GitHub 强制升到 Node 24 才能运行。另外 `ubuntu-latest` 将在 2026-11-19 前滚动迁移到 Ubuntu 26.04，迁移期间同一 workflow 可能时而在 24.04、时而在 26.04 上运行。
- CI 上 `bun run test` 约 137–144 秒（旧的串行 `--isolate`；并行化已在 `7836238` 落地但尚未 push）；整条发布流水线约 8 分钟，关键路径是 Android 的 `Build release APKs`（约 345 秒）与 `flutter test`（约 78 秒）。

## What Changes

- **只保留 `release.yml`**：删除 `ci.yml` 与 `mobile.yml`。文件名 `release.yml`、`npm` environment、`concurrency: npm-release` 保持不变（npm Trusted Publisher 绑定它们，不需要重新配置）。
- **由 tag push 触发**：`push: tags: v*.*.*`，不再依赖手动创建 GitHub Release；移除 `release: published` 触发。保留 `workflow_dispatch`，语义改为「演练」：跑完整验证与 Android 构建，但不发布 npm、不创建 Release。验证逻辑只有一份，演练与正式发版走同一套 job。
- **流水线结构**：`preflight`（tag 与 `package.json` 版本一致且为稳定版 `X.Y.Z`、tag 提交在 `main` 上、`docs/releases/vX.Y.Z.md` 存在）→ 并行的 `verify`（ubuntu / macOS / Windows 矩阵：`build:release`、`test`、`test:package`；`check` 只在 ubuntu 跑一次；ubuntu 上传 npm tarball）与 Android（`android-check`：format、analyze、test；`android-build`：按 ABI 三个并行 job 构建 release APK，APK 作为 artifact）→ 全部成功后 `publish`（npm，不可逆，放在验证之后）→ `github-release`（创建 Release 并上传 APK，幂等、可单独重跑）。
- **发布说明进仓库**：每个版本提交 `docs/releases/vX.Y.Z.md`（沿用历史 Release 的结构化中文写法），`preflight` 缺文件即失败，`github-release` 用 `--notes-file` 使用它。
- **新增 Windows 验证**：`windows-latest` 加入 `verify` 矩阵，直接作为发布门禁。先用 `workflow_dispatch` 演练到全绿，再打第一个 tag；演练中在 Windows 上暴露的测试或代码问题，在本变更内修复。演练只是本次接入的一次性动作，之后每次发版直接推 tag，Windows 验证随 tag 自动运行。
- **消除 Node 20 警告**：`checkout` → v7、`setup-java` → v6、`upload-artifact` → v7、`download-artifact` → v8、`setup-node` → v7（均为 node24 运行时）；`setup-bun@v2` 与 `flutter-action@v2` 无警告，不动。
- **Linux 镜像升级**：Linux job 显式使用 `ubuntu-26.04`，不用 `ubuntu-latest`；演练在 26.04 上出现工具链问题时回退 `ubuntu-24.04`。
- **提速**：CI 使用 `bun run test` 的并行模式；Android 拆成「format + analyze + test」与按 ABI 并行的 APK 构建（关键路径从约 345 秒的串行三 ABI 构建缩短为单 ABI 构建）；Gradle 缓存按 ref 隔离，tag 运行命中率有限，不作为提速依据。效果用演练实测，不预设数字。
- **配套**：新增 `.gitattributes`（`* text=auto eol=lf`），避免 Windows checkout 的 CRLF 使 `biome check` 失败；更新 `.github/RELEASING.md`（新发版流程、验证失败后删 tag 重打或升补丁号、演练用法、不再靠手动建 Release）与 `AGENTS.md` 中涉及 CI 的描述。

不做：不改生产代码与应用协议；不加 push / PR 触发的检查（本地以 `bun run check`、`bun run test` 为准）；不发布 Windows 专用产物（npm 包与 APK 之外没有新产物）；不做 iOS 构建；不改 npm 发布方式（仍是 Trusted Publisher + provenance）；不改 Android 签名（仍用 debug 签名的测试版）；不固定 action 到 commit SHA。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本变更只涉及 CI/CD 配置与发版文档，不改变任何用户可见行为或系统能力的需求；`.openspec.yaml` 设置 `skip_specs: true`。

## Impact

- **CI 配置**：`.github/workflows/release.yml`（重写）、`.github/workflows/ci.yml` 与 `.github/workflows/mobile.yml`（删除）、新增 `.gitattributes`。
- **文档**：`.github/RELEASING.md`、`apps/mobile/README.md`（APK 发版说明）、`AGENTS.md`；新增 `docs/releases/` 目录与每个版本的发布说明（沿用已发布 Release 的格式；已发布版本不回填）。
- **代码**：预期无生产代码改动；Windows 演练中发现的测试或平台兼容问题会落到对应测试与源码，范围在设计与任务中随演练结果收敛；若修复量过大，中途停下并拆成单独变更。
- **发版流程变化**：由「push 版本提交 → 手动建 Release」变为「提交版本号与发布说明 → `git tag vX.Y.Z` → `git push origin main vX.Y.Z`」；验证失败时 tag 已存在，需删除 tag 重打或升补丁号。
- **外部配置**：npm Trusted Publisher 不用改（workflow 文件名与 environment 不变）；GitHub 仓库没有分支保护或 ruleset，无需调整。
- **风险**：Windows 与 Ubuntu 26.04 的首次运行结果未知，靠演练收敛；Bun 并行测试在 CI 低核机上的耗时与稳定性未实测，同样靠演练确认；主版本跨度较大的 artifact action（upload v4→v7、download v4→v8）需演练确认上传下载行为。
