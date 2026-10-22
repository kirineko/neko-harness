# Tasks

## 1. 仓库基础与新 workflow

- [x] 1.1 新增 `.gitattributes`（`* text=auto eol=lf`）；验证：`git ls-files --eol | grep -c "w/crlf"` 仍为 0，`git status` 无意外的整文件改动
- [x] 1.2 重写 `.github/workflows/release.yml`：触发（tag `v*.*.*` + 无输入的 `workflow_dispatch`）、`preflight`、`verify` 矩阵（ubuntu-26.04 / macos-latest / windows-latest，bash shell，`check` 仅 ubuntu，ubuntu 上传 tarball）、`android-check`、`android-build`（单 job 三 ABI，带重试，产物 `NekoAI-v$VERSION-<abi>.apk`）、`publish`（幂等，`environment: npm`，job 级 `concurrency: npm-release`）、`github-release`（幂等，`--notes-file`）、各 job `timeout-minutes`、最小权限；action 版本按设计 D9。验证：`actionlint`（或 `bunx @action-validator/cli`）无报错，且 YAML 结构符合 D2 拓扑
- [x] 1.3 删除 `.github/workflows/ci.yml` 与 `.github/workflows/mobile.yml`；验证：`.github/workflows/` 下只剩 `release.yml`
- [x] 1.4 `preflight` 的校验脚本（版本稳定、tag 对应版本、提交在 main、发布说明存在）在本机用假环境变量各跑一次通过与失败路径；验证：四个失败场景（版本含预发布后缀、tag 与版本不符、说明文件缺失、提交不在 main）都以非零退出，正常场景退出 0

## 2. 文档

- [x] 2.1 改写 `.github/RELEASING.md` 的「后续发布」：新流程（改版本号 → `bun install --lockfile-only` → 写 `docs/releases/vX.Y.Z.md` → 提交 → `git tag` + `git push origin main vX.Y.Z`）、失败处理（验证失败无发布，删 tag 重打；Release 失败 Re-run failed jobs；npm 已存在则跳过）、演练用法（仅改 `release.yml` 时需要，`gh workflow run release.yml --ref <分支>`）；保留「首次发布」与 Windows 手测清单。验证：文中命令逐条与 `release.yml` 的实际行为对照无出入
- [x] 2.2 更新 `apps/mobile/README.md`「测试版 APK 与 CI 发版」：触发改为 tag，删除对 `mobile.yml` 的描述。验证：`rg "mobile.yml|发布 GitHub Release" apps/mobile/README.md README.md docs AGENTS.md .github` 无残留
- [x] 2.3 在 `AGENTS.md` 补一行发版说明指针（`.github/RELEASING.md`、`docs/releases/`）；验证：文中路径存在
- [x] 2.4 新增 `docs/releases/README.md`（说明命名 `vX.Y.Z.md`、正文即 Release 正文、不含标题、建议结构、不回填历史），RELEASING.md 链接到它；验证：目录存在且 `preflight` 的路径约定与之一致

## 3. 演练（需要推送分支，开始前向用户确认）

- [ ] 3.1 在新分支（如 `ci/release-on-tag`）提交以上改动，经用户确认后推送，执行 `gh workflow run release.yml --ref ci/release-on-tag`；验证：`gh run list --workflow release.yml` 出现该运行，且使用的是分支上的新 workflow（含 `preflight` job）。若旧文件被采用，改走设计 Risks 中的备选路径
- [ ] 3.2 修复 Linux（ubuntu-26.04）与 macOS 上暴露的问题；若 26.04 上出现 Bun / Flutter / Android 工具链问题，整体回退到 `ubuntu-24.04` 并在 design.md D9 记录原因。验证：这两个平台 `verify`、`android-check`、`android-build` 全绿，APK artifact 三个文件名正确
- [ ] 3.3 修复 Windows 上暴露的问题，按设计 D5 的顺序处置（改测试 → 修源码并加回归测试 → 修复量过大则暂停询问是否拆分）；每次修复在本机跑相关测试及 `bun run check`。验证：`verify` 的 windows-latest 全绿，且在 macOS / ubuntu 上无回归
- [ ] 3.4 记录演练数据：各 job 耗时、`bun run test` 在各 runner 上的耗时、并行测试是否稳定（至少连续两次绿）、artifact 上传下载（v7/v8）正常；写入 `openspec/changes/release-on-tag/baseline.md`，与旧流程（verify 182s/201s、android 482s）对比。验证：文件存在并含上述数字
- [ ] 3.5 `verify` 与 Android job 中确认没有 Node 20 弃用警告；验证：`gh run view <id> --json jobs` 对应的 annotations 中不再出现 "Node.js 20" 与 `ubuntu-latest` 迁移提示

## 4. 合入与收尾

- [ ] 4.1 `bun run check` 通过（仓库内如有代码/测试改动），并在改动涉及测试时跑一次 `bun run test`；验证：命令退出 0
- [ ] 4.2 经用户确认后合入 main（含此前未推送的提交）并推送；验证：推送后不触发任何 workflow（tag 才触发），`gh workflow list` 只有 Release
- [ ] 4.3 自查发版路径：对照 RELEASING.md 走一遍「发布说明 → tag → 推送」的前置条件，确认 `preflight` 的每条校验在文档里都有对应说明；验证：文档与 `release.yml` 逐项对应

## Workflow follow-up

- 第一次真实发版（下一个版本）即 `publish` 与 `github-release` 的首次运行；若失败，按 RELEASING.md 的失败处理操作，并把结论补回本变更文档后再归档。
- 验证通过后归档本变更。
