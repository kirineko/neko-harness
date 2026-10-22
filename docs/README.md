# 文档索引 / Documentation index

| 文档 | 内容 | 语言 |
| --- | --- | --- |
| [../README.md](../README.md) | 项目介绍、安装、使用与配置 | English |
| [README.zh-CN.md](README.zh-CN.md) | 同上，中文主版本（两版不一致时以中文为准） | 中文 |
| [mobile/api-v1.md](mobile/api-v1.md) | 手机端 JSON-RPC 协议 | 中文 |
| [dev/releasing.md](dev/releasing.md) | 发布流程与失败处理 | 中文 |
| [releases/](releases/README.md) | 各版本发布说明（`vX.Y.Z.md`，同时是 GitHub Release 正文） | 中文 |
| [../apps/mobile/README.md](../apps/mobile/README.md) | Flutter 手机端的构建、测试与发版 | 中文 |
| [../AGENTS.md](../AGENTS.md) | 架构、模块与开发约定 | 中文 |
| [../openspec/](../openspec/) | 变更提案与能力规格 | 中文 |

## 位置约定

- 面向用户的入口文档放在仓库根目录与 `docs/`；按主题建子目录（`dev/` 开发与发布、`mobile/` 手机协议、`releases/` 发布说明）。
- 只属于某个包的文档跟随该包（如 `apps/mobile/README.md`）。
- `docs/releases/` 的路径被 `.github/workflows/release.yml` 与 `scripts/release-preflight.ts` 使用，改动需同步。
- 英文文档不含中文（语言名除外）；开发者内部文档只有中文。
