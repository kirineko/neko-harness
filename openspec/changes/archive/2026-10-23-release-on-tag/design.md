# Design

## Context

动机与范围见 proposal.md。当前状态：

- `release.yml` 由 `release: published` 触发，`verify`（ubuntu）→ `publish`（npm）与独立的 `android`；`ci.yml` / `mobile.yml` 在 push / PR 上重复同样的验证。
- npm Trusted Publisher 绑定 workflow 文件名 `release.yml` 与 environment `npm`。`npm` environment 没有任何保护规则（无审批、无分支/标签限制），因此改为 tag 触发不需要改仓库设置。
- 仓库是公开的，`GITHUB_TOKEN` 默认只读，需要写权限的 job 必须显式声明 `contents: write`。
- 已发布 Release 的标题格式是 `neko-harness X.Y.Z`，正文是手写的中文结构化说明，附 3 个 APK。
- 仓库没有 `.gitattributes`；`biome.json` 的 `lineEnding` 为 `auto`；`git ls-files --eol` 显示工作区没有 CRLF 文件。
- GitHub Actions 的缓存按 ref 隔离：tag 触发的运行只能读到自己 ref 或默认分支上保存的缓存，彼此的 tag 之间不共享。

## Goals / Non-Goals

**Goals:**

- 一份 workflow、一次验证；任何验证失败都不会发布任何东西。
- 发版动作只剩「提交版本与发布说明、打 tag、推送」。
- Linux / macOS / Windows 三平台同为发布门禁。
- 消除 Node 20 警告，Linux 固定在 `ubuntu-26.04`。
- 流水线耗时不比现在长，并在演练中测出实际数字。

**Non-Goals:**

- 不处理 npm 回滚、dist-tag 管理、预发布版本（`X.Y.Z-rc.1`）；非稳定版 tag 一律拒绝。
- 不引入 release-please / changesets 之类的自动版本工具。
- 不改变构建产物内容；Android 签名仍是 debug 签名。

## Decisions

### D1 触发与演练

```yaml
on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
```

- tag 过滤只是粗筛，严格校验在 `preflight`（`^v[0-9]+\.[0-9]+\.[0-9]+$` 且等于 `v<package.json version>`）。
- `workflow_dispatch` 没有输入：对所选 ref 跑完整验证与 Android 构建，`publish` 与 `github-release` 以 `if: github.event_name == 'push'` 跳过。演练可对任意分支运行（`gh workflow run release.yml --ref <branch>`；`release.yml` 已在默认分支上声明了 `workflow_dispatch`，分支上的新文件内容会被采用）。
- 演练时 `preflight` 只校验 `package.json` 版本是稳定版；不校验 tag、不要求发布说明（演练不一定对应一个即将发布的版本）。
- 备选：保留旧的「补传 APK 到已有 tag」输入。放弃：APK 构建失败改用「Re-run failed jobs」即可，逻辑更少。

### D2 Job 拓扑

```
preflight ─┬─ verify (ubuntu-26.04 | macos-latest | windows-latest)
           ├─ android-check
           └─ android-build
                    └──────────── 全部成功 ──► publish (npm) ──► github-release
```

- `preflight` 输出 `version`、`notes`（路径）。其余 job 不再各自重复校验版本，只在需要时读 `needs.preflight.outputs.version`。
- `publish` 与 `github-release` 在 `needs` 里列出所有验证类 job，npm 发布（不可逆）排在所有验证之后。
- `github-release` 依赖 `publish`：npm 包存在后才创建 Release。它只依赖 artifact 与发布说明，可单独重跑；`publish` 失败则不创建 Release。
- 各 job 设置 `timeout-minutes`（verify 30、android 20、其余 10），防止挂起的测试占满 6 小时。
- `permissions` 在 workflow 顶层是 `contents: read`；`publish` 加 `id-token: write`；`github-release` 加 `contents: write`。

### D3 `preflight`

1. `actions/checkout@v7` 以 `fetch-depth: 0` 取全部历史与 tag（`git merge-base --is-ancestor` 需要）。
2. `bun -e` 读 `package.json`：版本必须是 `X.Y.Z`；tag 事件下 `GITHUB_REF_NAME` 必须等于 `v$version`。
3. tag 事件下：`git fetch origin main` 后要求 `git merge-base --is-ancestor "$GITHUB_SHA" origin/main`，防止从未合入 main 的提交发版。
4. tag 事件下：`docs/releases/v$version.md` 必须存在且非空。

preflight 失败时其余 job 全部不执行，几秒内反馈。校验逻辑放在 `scripts/release-preflight.ts`（而不是 workflow 内联），这样可以在本机用环境变量（`GITHUB_EVENT_NAME` / `GITHUB_REF_NAME` / `GITHUB_SHA`，以及用于本地测试的 `RELEASE_MAIN_REF`）直接演练各条规则。

### D4 `verify` 矩阵

- `strategy.fail-fast: false`，矩阵三个 OS，让一次演练能同时看到三个平台的全部问题。
- `defaults.run.shell: bash`：Windows 上也走 Git Bash，一份步骤文本通用。
- 步骤：`checkout` → `setup-bun`（`1.4.x`）→ `bun install --frozen-lockfile` → `bun run build:release` → `bun run check`（仅 `matrix.os == 'ubuntu-26.04'`，格式与类型不随平台变化，并避开 Windows 换行噪声）→ `bun run test` → `bun run test:package` → 仅 ubuntu 上传 `artifacts/*.tgz`。
- 发布的 tarball 来自 ubuntu 构建，保持与现状一致。
- Windows 需要 Git Bash，`windows-latest` 自带 Git for Windows。`bash` 解析到哪一个由演练确认；若解析到 WSL 的 `bash.exe`，用 `C:\Program Files\Git\bin` 前置 PATH 修正。
- 测试命令默认用 `bun run test`（并行）。若 Windows 上并行出现稳定的不稳定用例，矩阵允许对该平台回退 `test:serial`（记录原因），而不是在 Windows 上跳过测试。
- 备选：把 `check` 也放进每个平台。放弃：多花时间，结果与平台无关。

### D5 Windows 问题的处理边界

演练发现的 Windows 失败按下列顺序处置：

1. 测试对平台的假设错误（路径分隔符、`sleep`/`ps` 之类 POSIX 工具、符号链接权限、CRLF）：改测试，使其在 win32 上等价验证或明确跳过并说明原因。仓库里已有这种先例（归档 `2026-10-20-windows-git-bash-and-robustness`）。
2. 源码真实的 Windows 缺陷：修源码并补回归测试。
3. 修复量过大（预估超过一个小改动集合，或需要改应用行为）：暂停，向用户确认是否把 Windows 门禁拆到后续变更，当前变更先以 `windows-latest` 暂不启用的方式合入其余部分。

`.github/RELEASING.md` 里的 Pi 1.2 Windows 手测清单包含「安装已发布版本」「TUI/Web 联调」等人工项，CI 不覆盖，原样保留。

### D6 Android

- `android-check`：`flutter pub get --enforce-lockfile` → `dart format --output=none --set-exit-if-changed .` → `flutter analyze` → `flutter test`。
- `android-build`：单个 job 一次构建三个 ABI（`--split-per-abi`），产物重命名为 `NekoAI-v$VERSION-<abi>.apk` 后作为 artifact `apk` 上传。`--build-name` 取 preflight 版本，`--build-number = MAJOR*10000 + MINOR*100 + PATCH`（与现状一致）。构建步骤最多重试 3 次：演练中 Gradle 首次下载 NDK 时出现过一次 `Error reading Zip content`（下载损坏），重试即可恢复。
- 曾尝试按 ABI 拆成三个并行 job：演练实测每个 job 仍要 260–360 秒，与串行构建三个 ABI 的约 345 秒相当。耗时主要是每个 job 的固定开销（Flutter 引擎产物与 NDK 28.2 下载、Gradle 依赖解析），而不是各 ABI 的编译，所以拆分没有收益，还让下载失败的概率乘以三。已改回单 job。
- 缓存：`setup-java` 开启 `cache: gradle`，`flutter-action` 保持 `cache: true`。缓存按 ref 隔离，tag 运行读不到别的 tag 保存的缓存，只能读到默认分支上保存的；因此缓存收益有限，不能当作提速依据。Android 构建的关键路径（约 5–6 分钟）主要是上述固定开销，不在本变更内进一步优化。
- Java 固定 Temurin 17（`setup-java@v6`），不使用镜像默认的 Java 25。

### D7 `publish`

沿用现有步骤：`download-artifact`（`npm-package`）→ `setup-node@v7`（`24.x`，registry-url）→ `npm publish ./artifacts/*.tgz --access public --tag latest --provenance`，`environment: npm`，`id-token: write`。

新增幂等保护：发布前 `npm view "neko-harness@$VERSION" version` 已存在则跳过发布并打印提示。这样「Re-run all jobs」或 tag 重推不会因 `403 You cannot publish over the previously published versions` 把已成功的发布变成失败。`concurrency` 放在 `publish` job 上，`group: npm-release`、`cancel-in-progress: false`（组名保持不变）；workflow 级别用 `release-${{ github.ref }}` 避免演练与正式发布互相排队。

### D8 `github-release`

- 只做一次 `checkout`（`sparse-checkout: docs/releases`）以读取发布说明，再 `download-artifact`（`pattern: apk-*`，`merge-multiple: true`）。
- 若 `gh release view "$TAG"` 已存在则 `gh release edit --notes-file --title`，否则 `gh release create "$TAG" --verify-tag --title "neko-harness $VERSION" --notes-file "docs/releases/v$VERSION.md"`；随后 `gh release upload "$TAG" dist/*.apk --clobber`。可重复执行。
- 不设 prerelease、不设 draft；使用默认的 latest 判定。

### D9 Action 版本与镜像

- 版本：`actions/checkout@v7`、`setup-java@v6`、`upload-artifact@v7`、`download-artifact@v8`、`setup-node@v7`；`setup-bun@v2`、`flutter-action@v2` 不变。均已确认为当前最新大版本；v4→v7/v8 的 artifact 行为（命名唯一、隐藏文件默认不上传、`merge-multiple`）由演练确认。
- Linux 使用 `ubuntu-26.04` 标签。已知不确定项：Bun 1.4.2、Flutter 3.47.7 / Android toolchain 在新镜像上的表现。出现镜像相关失败时，把文件内的 `ubuntu-26.04` 整体替换为 `ubuntu-24.04`（纯文本替换，不引入条件逻辑）。
- 演练结果：`ubuntu-26.04` 上 Bun、Flutter、Android 工具链均正常，不需要回退。
- `setup-bun` 的 `bun-version: 1.4.x` 会随上游补丁版本浮动（演练当天解析为刚发布的 1.4.4，暴露了 node:http upgrade socket 的行为变化）。保持浮动：发版前能及早发现上游变化，且仓库 `engines` 允许 `>=1.4.2 <1.5.0`；问题出现时在测试侧适配或临时收紧版本。
- 暂不固定 action 的 commit SHA，沿用主版本标签（proposal 的不做项）。

### D10 `.gitattributes` 与发布说明

- `.gitattributes`：`* text=auto eol=lf`。仓库当前无 CRLF 文件，所以不会产生需要重写的大量 diff；Windows runner 上 checkout 后文件是 LF，`biome` 与依赖换行的测试不受 `core.autocrlf` 影响。需要保持二进制的文件（图片、字体、`.jar`）由 `text=auto` 自行识别。
- 发布说明：`docs/releases/vX.Y.Z.md`，内容就是 Release 正文（不含标题）。写法沿用现有风格：「新增 / 实现说明 / 已知限制 / 兼容性 / 内部」按需取舍。不回填历史版本。

### D11 文档

- `.github/RELEASING.md`：改写「后续发布」为新流程；写明失败处理（验证失败时没有任何发布，删除远端和本地 tag、修复后重打；已发布 npm 但 Release 失败时只需 Re-run failed jobs；`publish` 因版本已存在而跳过）；写明演练用法（只在改 `release.yml` 时需要）；保留「首次发布」历史与 Windows 手测清单。
- `apps/mobile/README.md` 的「测试版 APK 与 CI 发版」：触发条件改为 tag；删除对 `mobile.yml` 的描述。
- `AGENTS.md`：「常用命令」之后补一行指向 `.github/RELEASING.md` 的发版说明与 `docs/releases/`；不展开流程。

## Risks / Trade-offs

- [没有 push/PR 检查，问题到 tag 时才暴露] → 本地 `bun run check` 与 `bun run test` 是日常门禁；tag 阶段失败时没有任何东西被发布，代价只是删 tag 重打。
- [tag 已存在但验证失败，tag 指向的提交含问题] → 流程中写明：删 tag 重打（尚未发布过），或升补丁号；已发布到 npm 的版本不可覆盖。
- [Windows 首次运行红] → 演练到全绿再打第一个 tag；D5 给出处置顺序与拆分条件。
- [Ubuntu 26.04 镜像上工具链不兼容] → 单点回退到 `ubuntu-24.04`。
- [缓存按 ref 隔离，tag 运行命中率低] → 不依赖缓存提速；提速主要来自并行测试，以及 Android 与 verify 并行运行。
- [`gh workflow run --ref <分支>` 对新旧文件差异的行为] → 演练的第一步就验证；若分支上的新文件未生效，退而求其次把 workflow 合入默认分支后再演练（合入本身不会触发任何发布，因为 tag 才触发）。
- [演练无法验证 `publish` 与 `github-release`] → 这两个 job 的逻辑短且幂等；首次真实发版即其首次运行，所以 `preflight` 校验与 `publish` 的幂等保护要写得保守，RELEASING.md 说明失败后的恢复方式。不为此搭建一次性仓库或本地模拟环境。

## Migration Plan

1. 在分支上完成改动，推送分支（需用户确认），用 `gh workflow run release.yml --ref <分支>` 演练；循环修复直到 `verify` 三平台与 Android 全绿，记录各 job 耗时。
2. 合入 main 并推送（需用户确认）；删除 `ci.yml`、`mobile.yml` 随同一提交生效。
3. 下一次发版按新流程：提交版本号 + `docs/releases/vX.Y.Z.md` → `git tag vX.Y.Z` → `git push origin main vX.Y.Z`。
4. 回滚：恢复旧版 `release.yml`、`ci.yml`、`mobile.yml` 三个文件即可回到原流程，不涉及仓库设置或外部服务。
