# 发布维护

对外只发布 `neko-harness`，内部 workspace 均保持 private。运行时和验证使用 Bun 1.4.x；Node/npm 仅用于向 npm 上传产物及 OIDC 认证。

## 一次性配置

在 npm 包设置 → Trusted publishing 添加 GitHub Actions：owner `kirineko`，repository `neko-harness`，workflow `release.yml`，environment `npm`，允许 publish。配置完成后流水线不需要长期 npm token。

## 发布步骤

`release.yml` 是唯一的 workflow，推送 `vX.Y.Z` tag 即发版；仓库没有 push / PR 检查，日常以本机 `bun run check`、`bun run test` 为准。

1. 更新根 `package.json` 的版本（稳定版 `X.Y.Z`），并同步 `packages/gateway/test/fixtures/mobile-api-v1/hello-result.json` 的 `gatewayVersion`。
2. 编写 `docs/releases/vX.Y.Z.md`（Release 正文，写法见 [docs/releases](../releases/README.md)）。
3. 提交到 `main`，然后 `git tag vX.Y.Z && git push origin main vX.Y.Z`。
4. 流水线自动执行：
   - `preflight`：tag 等于 `v<package.json 版本>`、版本是稳定版、tag 提交在 `origin/main` 上、发布说明文件存在且非空。任何一条不满足，后续 job 都不运行。
   - `verify`（Linux / macOS / Windows）：构建、`bun run test`、安装冒烟；`bun run check` 只在 Linux 跑。`android-check`（格式、分析、测试）与 `android-build`（三个 ABI 的 release APK）同时运行。
   - 以上全部通过后 `publish` 才上传 Linux 上验证过的同一份 tarball 到 npm `latest`（附 provenance）；版本已在 npm 上则跳过。
   - `github-release` 用发布说明创建 GitHub Release（标题 `neko-harness X.Y.Z`），附 `NekoAI-vX.Y.Z-<abi>.apk`；Release 已存在则更新说明并覆盖同名 APK。

发布流程使用 GitHub-hosted runner（Linux 为 `ubuntu-26.04`）和 `npm` environment，不保存长期 npm token。需先完成上面的 Trusted Publisher 配置（workflow 文件名 `release.yml`、environment `npm`），提交 workflow 本身不会自动建立信任关系；因此不要重命名 `release.yml` 或 `npm` environment。

### 失败处理

- **`preflight` 或验证失败**：此时没有发布任何东西。修复后删除远端和本地 tag（`git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`）重新打 tag，或升补丁号发新版。
- **`publish` 成功但 `github-release` 失败**：在 Actions 页面对该运行点 “Re-run failed jobs”。
- **整条流水线重跑**：`publish` 发现 npm 上已有该版本会跳过，不会因重复发布失败。
- npm 上已发布的版本不能覆盖；发现问题只能发新的补丁版本。

### 演练

只在修改 `release.yml` 时需要：`gh workflow run release.yml --ref <分支>`（或在 Actions 页面手动运行）。演练执行完整的验证与 Android 构建，不要求发布说明，也不会发布 npm、不创建 Release。

`artifacts/`、`dist/` 不提交。实际 npm 包只包含构建产物、README、LICENSE 和 package.json。
