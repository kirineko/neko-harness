# Proposal

## Why

neko 的发布包目前只能在 Bun 上运行：入口是 `#!/usr/bin/env bun`，产物按 Bun 目标打包（含 `import.meta.require`），`neko update` 写死 Bun 的全局安装命令。只有 Node / npm 的用户执行 `npm install -g neko-harness` 可以装上，但 `neko` 无法启动。上游 Pi 1.5 的全部包都声明 `engines.node >=22.19.0`，本仓库运行时代码也不调用 `Bun.*`，调研中用 Node 实跑了 gateway、Web、TUI 真实对话与 Pi SDK 冒烟均正常，阻塞点只在打包、入口与升级命令。

同一个 `bin` 文件只能有一个 shebang，无法同时让「只装 Bun」与「只装 Node」的用户都能启动；因此发布包改为只支持 Node 运行，Bun 不再是受支持的运行时或安装方式。

## What Changes

- **BREAKING** 发布包的运行时由 Bun 改为 Node：`neko` 与 gateway 入口改为 `#!/usr/bin/env node`，发布产物按 Node 目标打包（不含 Bun 专有调用与 `// @bun` 标记），根包 `engines` 改为 `node >=22.19.0`。
- **BREAKING** 受支持的安装方式改为 npm 全局安装（`npm install -g neko-harness`）；`bun add --global` 安装不再受支持。
- `neko` 启动时检查 Node 版本：低于下限时输出简短的版本要求并非零退出，不带着不满足的运行时继续启动。
- `neko update`（macOS / Linux）改为识别并升级 npm 全局安装；Bun 全局安装、源码、项目局部安装与链接安装一律按「不受支持的安装」处理，指引用户改用 npm 重新安装；全局目录不可写时给出手动命令，不自行提权。Windows 仍只输出手动升级指引，命令改为 `npm install -g neko-harness@latest`。
- 消除 npm 安装时的 peer 依赖警告：`ws` 对齐到 chord 声明的可选 peer 版本 `8.21.0`（当前 `8.22.0` 在 npm 下触发 ERESOLVE 警告）。
- TUI 的新版本提示与 `neko update --help` 中的手动升级命令同步改为 npm 命令；Web 的「运行 `neko update`」提示不变。
- 发布验证改为在 Linux / macOS / Windows 上用 npm 全局安装打包产物，并以 Node 完成启动冒烟（版本、帮助、Web 与 gateway 就绪、Pi SDK 原生依赖、正常退出）；npm 发布步骤不变。
- 发布说明提供现有 Bun 用户的迁移步骤（安装 Node，卸载 Bun 全局安装，用 npm 重新安装）；`~/.neko` 下的数据与凭据原地沿用，不清理。
- 更新 README、`docs/dev/releasing.md`、AGENTS.md 与 `neko --help` 中关于安装、运行时和升级的说明。
- 不在本变更内：开发工具链（包管理、测试运行器、打包器、脚本执行）仍使用 Bun，迁移到 pnpm 由 `migrate-toolchain-to-pnpm` 单独完成；本变更期间测试仍跑在 Bun 上，Node 运行时由上述安装冒烟守护。不发版、不提交 git commit。

## Capabilities

### New Capabilities

无；沿用现有能力边界。

### Modified Capabilities

- `application-updates`：「用户执行 CLI 升级」由升级 Bun 全局安装改为升级 npm 全局安装；不受支持的安装范围扩大到 Bun 全局安装；Windows 手动升级指引改为 npm 命令。
- `cli-interface`：新增启动时的 Node 版本检查与不满足时的报错退出。帮助文案里的升级命令随之改为 npm，但现有帮助输出的要求不变。
- `session-gateway`：新增 Unix socket 路径过长时的明确启动失败。Node 不能监听超过系统上限的路径（Bun 可以），此前能用的超长数据目录在 Node 上会失败，改为给出可操作的说明。
- `terminal-ui`：「TUI 升级感知与版本查看」中 Windows 的手动升级命令改为 npm 命令。

## Impact

- 网关：`packages/gateway/src/gateway.ts` 的启动错误翻译。
- 入口与打包：`packages/cli/src/main.ts`、`packages/gateway/src/main.ts`、`scripts/build-release.ts`、根 `package.json`（`engines`、`description`、`keywords`）。
- 升级：`packages/cli/src/update.ts`、`packages/core/src/application-version.ts`（`upgradeCommand`）、TUI 版本提示与三端相关文案及其对账测试。
- 发布：`scripts/test-package.ts`、`.github/workflows/release.yml`、`docs/dev/releasing.md`、`docs/releases/` 的下一版说明。
- 文档：README、AGENTS.md。
- 用户影响：现有 Bun 用户必须安装 Node 22.19 及以上并用 npm 重新安装；未迁移的 Bun 安装在升级后无法启动或无法自升级。
- 兼容性：应用协议、网关契约、存储格式与移动端均不变。
- 待验证：Windows、Linux 与 Node 22 尚未实测（调研只覆盖 macOS + Node 24），由三平台安装冒烟覆盖。
