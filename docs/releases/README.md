# 发布说明

每个版本一个文件：`vX.Y.Z.md`，版本号须与根 `package.json` 一致。推送 `vX.Y.Z` tag 时，`.github/workflows/release.yml` 的 `preflight` 要求该文件存在且非空，`github-release` 把它原样作为 GitHub Release 的正文（标题由流水线生成：`neko-harness X.Y.Z`）。

- 正文不含标题，直接从第一节开始；面向用户，中文。
- 按需取用的结构：**新增** / **实现说明** / **已知限制** / **兼容性** / **内部**，没有内容的节不写。
- 已发布的历史版本不回填；它们的说明在各自的 GitHub Release 页面。

发版流程见 [releasing.md](../dev/releasing.md)。
