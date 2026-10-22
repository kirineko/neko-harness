# 发布维护

对外只发布 `neko-harness`，内部 workspace 均保持 private。运行时和验证使用 Bun 1.4.x；Node/npm 仅用于向 npm 上传产物及 OIDC 认证。

## 首次发布

1. 安装 Bun 1.4.x，然后 `bun install --frozen-lockfile`；文件发现组件随 pi-env 提供，无需安装 fd。
2. `bun run build:release && bun run check && bun run test && bun run test:package`
3. 确认 `artifacts/neko-harness-0.1.0.tgz` 的内容，提交并推送代码。
4. `npm login --registry=https://registry.npmjs.org`，然后 `npm publish ./artifacts/neko-harness-0.1.0.tgz --access public --tag latest --registry=https://registry.npmjs.org`；在浏览器完成 npm 要求的认证。
5. 发布成功后创建并推送 `v0.1.0` tag。（0.1.0 当时是手动发布；现在推送 tag 会直接触发 `release.yml`，见「后续发布」。）
6. 在 npm 包设置 → Trusted publishing 添加 GitHub Actions：owner `kirineko`，repository `neko-harness`，workflow `release.yml`，environment `npm`。允许 publish。

## 后续发布

`release.yml` 是唯一的 workflow，推送 `vX.Y.Z` tag 即发版；仓库没有 push / PR 检查，日常以本机 `bun run check`、`bun run test` 为准。

1. 更新根 `package.json` 的版本（稳定版 `X.Y.Z`），运行 `bun install --lockfile-only` 更新锁文件。
2. 编写 `docs/releases/vX.Y.Z.md`（Release 正文，写法见 [docs/releases](../docs/releases/README.md)）。
3. 提交到 `main`，然后 `git tag vX.Y.Z && git push origin main vX.Y.Z`。
4. 流水线自动执行：
   - `preflight`：tag 等于 `v<package.json 版本>`、版本是稳定版、tag 提交在 `origin/main` 上、发布说明文件存在且非空。任何一条不满足，后续 job 都不运行。
   - `verify`（Linux / macOS / Windows）：构建、`bun run test`、安装冒烟；`bun run check` 只在 Linux 跑。`android-check`（格式、分析、测试）与 `android-build`（三个 ABI 的 release APK）同时运行。
   - 以上全部通过后 `publish` 才上传 Linux 上验证过的同一份 tarball 到 npm `latest`（附 provenance）；版本已在 npm 上则跳过。
   - `github-release` 用发布说明创建 GitHub Release（标题 `neko-harness X.Y.Z`），附 `NekoAI-vX.Y.Z-<abi>.apk`；Release 已存在则更新说明并覆盖同名 APK。

发布流程使用 GitHub-hosted runner（Linux 为 `ubuntu-26.04`）和 `npm` environment，不保存长期 npm token。需先在 npm 完成 Trusted Publisher 配置（workflow 文件名 `release.yml`、environment `npm`），提交 workflow 本身不会自动建立信任关系；因此不要重命名 `release.yml` 或 `npm` environment。

### 失败处理

- **`preflight` 或验证失败**：此时没有发布任何东西。修复后删除远端和本地 tag（`git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`）重新打 tag，或升补丁号发新版。
- **`publish` 成功但 `github-release` 失败**：在 Actions 页面对该运行点 “Re-run failed jobs”。
- **整条流水线重跑**：`publish` 发现 npm 上已有该版本会跳过，不会因重复发布失败。
- npm 上已发布的版本不能覆盖；发现问题只能发新的补丁版本。

### 演练

只在修改 `release.yml` 时需要：`gh workflow run release.yml --ref <分支>`（或在 Actions 页面手动运行）。演练执行完整的验证与 Android 构建，不要求发布说明，也不会发布 npm、不创建 Release。

`artifacts/`、`dist/` 不提交。实际 npm 包只包含构建产物、README、LICENSE 和 package.json。

## Pi 1.2 升级发版后的 Windows 验证

用户已决定将此次升级的 Windows 验证延后至发版后；归档不表示 Windows 已通过。对应归档的 8.4/9.2 仍未完成，见 [验证记录](../openspec/changes/archive/2026-10-13-upgrade-pi-sdk-1-2/verification.md)。

- [ ] 记录 Windows 版本、架构、Bun 版本和实际发布的 neko-harness 版本；在干净目录安装该版本，确认随包 pi-env helper 可解析、可执行，不依赖开发 reference、Cargo 或运行时下载。
- [ ] 在没有 fd/fdfind 的 PATH 中验证 @ 首次查询、缓存复用、文件创建/删除/重命名后的刷新与故障重试；退出后没有遗留 helper。
- [ ] 验证 TUI/Web 使用 WS-only 网关及 port-file 发现；无 Key 可启动，双端消息/流式输出、模型设置、图片和候选同步，切换会话与单端断连不影响另一端或已受理的回答。
- [ ] 将实际结果补充到上述归档验证记录；对应平台检查通过后再勾选归档任务 8.4/9.2。
