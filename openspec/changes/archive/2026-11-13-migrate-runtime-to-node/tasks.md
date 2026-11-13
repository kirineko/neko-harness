# Tasks

## 1. 入口、启动器与打包

- [x] 1.1 新增 `packages/cli/src/bin.ts` 启动器与独立的版本比较纯函数（不引入任何第三方依赖）：版本不足时向 stderr 输出一条含最低版本与当前版本的中文说明并以非零退出，满足时动态加载 CLI 入口（发布构建加载 `./cli.js`，源码加载 `./main.ts`）。验证：新增 `packages/cli/test/node-version.test.ts`，覆盖低于、等于、高于下限以及带预发布后缀的版本号，`bun test --conditions=neko-source packages/cli/test/node-version.test.ts` 通过。
- [x] 1.2 把 `packages/cli/src/main.ts` 的 shebang 移到启动器并改为 `#!/usr/bin/env node`，`packages/gateway/src/main.ts` 的 shebang 改为 node，`process.argv[0] ?? "bun"` 的兜底改为 `"node"`。验证：`git grep -n "env bun" -- packages` 无结果，`bun run check` 通过。
- [x] 1.3 修改 `scripts/build-release.ts`：`target` 改为 `"node"`，产出 `dist/neko.js`（启动器，可执行）、`dist/cli.js`、`dist/gateway.js`，把根 `package.json` 的 `engines.node` 下限注入启动器，并在构建结束时断言 `dist/*.js` 不含 `// @bun`、`import.meta.require` 与 `Bun.`。验证：`bun run build:release` 成功，`head -1 dist/neko.js` 为 node shebang，`node dist/neko.js --version` 输出当前版本，`node dist/neko.js serve --help` 正常输出中文帮助。
- [x] 1.4 根 `package.json`：`engines` 改为 `{ "node": ">=22.19.0" }`，`description` 与 `keywords` 去掉 Bun 的表述（`packageManager` 保留）。验证：`bun run build:release` 后启动器里的下限与 `engines.node` 一致（1.3 的断言或一条 `grep`）。
- [x] 1.5 把 `ws` 在根包与 `packages/gateway` 中改为 `8.21.0` 并更新 `bun.lock`。验证：`bun install --frozen-lockfile` 通过，`bun test --conditions=neko-source packages/gateway` 通过；若失败则按 design D5 回退到 `8.22.0` 并在 3.x 的 README 任务中补充说明。

## 2. `neko update` 改为 npm 全局安装

- [x] 2.1 重写 `packages/cli/src/update.ts` 的安装识别与命令执行：从 `PATH` 调用 `npm`（`execFile`，不经 shell），用 `npm root -g` 与当前包目录的真实路径比对，拒绝符号链接目录与读不到稳定版本号的安装；安装命令为 `npm install -g neko-harness@<版本>`，验证用当前 `process.execPath` 运行新入口的 `--version`；删除 `pm bin -g` 与 Bun 全局 `package.json` 相关逻辑；升级占用目录放在 npm 全局 `node_modules` 下。验证：改写 `packages/cli/test/update.test.ts` 覆盖正常升级、已最新、安装失败、验证不一致、并发占用，全部通过。
- [x] 2.2 处理不受支持的安装与不可写目录：源码、项目局部安装、链接安装、目录比对失败（含 Bun 全局安装）返回「不支持自升级」并提示可改用 `npm install -g neko-harness`；创建占用目录遇到 `EACCES` / `EPERM` 时返回失败并给出 `npm install -g neko-harness@latest`。验证：`update.test.ts` 新增这两类用例并通过；`packages/cli/test/update-integration.test.ts` 改为 npm 目录布局后通过。
- [x] 2.3 `packages/core/src/application-version.ts` 的 `upgradeCommand("win32")` 改为 `npm install -g neko-harness@latest`；`packages/cli/src/main.ts` 的根帮助与 `neko update --help` 文案改为「npm 全局安装」与 npm 命令。验证：更新 `packages/cli/test/update.test.ts`、`packages/cli/test/help.test.ts`、`packages/tui/test/version-ui.test.ts` 中的期望文本并通过；`git grep -n "bun add" -- packages` 无结果。

## 3. 文档

- [x] 3.1 更新 `README.md` 与 `docs/README.zh-CN.md`：安装要求改为 Node 22.19 及以上，安装与升级命令改为 npm，新增「从 Bun 安装迁移」小节（安装 Node、`bun remove --global neko-harness`、`npm install -g neko-harness`、`~/.neko` 原地沿用），开发章节注明开发工具链暂时仍是 Bun。验证：两份文档的安装命令逐条在本机执行可用；除迁移小节外，两份文档不再出现 `bun add --global`。
- [x] 3.2 更新 `AGENTS.md`（项目简介、常用命令里构建产物的运行方式）与 `docs/dev/releasing.md`（发布产物运行在 Node 上，冒烟用 npm 安装，Node 不再只是上传工具）。验证：文档中的命令与 `package.json` 脚本、`release.yml` 的实际步骤一致。

## 4. 安装冒烟与发布流水线

- [x] 4.1 修改 `scripts/test-package.ts`：用 `npm install -g --prefix <临时目录>` 安装 tarball，从该前缀启动 `neko`（Windows 经 `cmd` 启动 `neko.cmd`），子进程 `PATH` 只含 Node 与系统目录；sharp 与 `scripts/package-sdk-smoke.mjs` 改用 `node` 执行；必需文件清单加入 `dist/cli.js`；断言 npm 安装输出不含 `ERESOLVE`、`dist/neko.js` 首行为 node shebang、stderr 无运行时警告。验证：本机 `bun run build:release && bun run test:package` 通过，且在 `PATH` 中移除 Bun 的子进程里 `neko web` 能启动并正常退出。
- [x] 4.2 更新 `test-package.ts` 中 `neko update` 的断言：macOS / Linux 以「不支持自升级」拒绝，Windows 输出 `npm install -g neko-harness@latest`。验证：`bun run test:package` 通过。
- [ ] 4.3 修改 `.github/workflows/release.yml` 的 `verify`：三个平台在 Bun 之外安装 Node 24.x 供冒烟使用，Linux 增加一次 Node 22.19.0 的 `test:package`；更新 `publish` 里「Node 只是上传工具」的注释；不改 workflow 文件名与 `npm` environment。验证：`gh workflow run release.yml --ref <分支>` 演练，三个平台与 Node 22.19.0 的冒烟全部通过。
- [x] 4.4 若 4.3 的任一冒烟在 stderr 出现 `node:sqlite` 的 ExperimentalWarning：在启动器与 gateway 入口只过滤该条警告，并补一条单元测试。验证：重新演练后 stderr 断言通过；未出现警告则在本任务下记录「无需处理」并勾选。

## 5. 超长 Unix socket 路径

- [x] 5.1 在 `packages/gateway/src/gateway.ts` 的启动错误翻译中识别「`EINVAL` 且 socket 路径超过平台上限」，报出路径、字节数、上限与 `--storage` / `--socket-path` 指引（design D9，session-gateway 的新增要求）。验证：`packages/gateway/test/startup-error.test.ts` 通过；用 Node 运行发布产物并把 `--storage` 指到超长目录，输出该说明而不是裸 `EINVAL`。

## 6. 集成验证

- [x] 6.1 运行 `bun run check`、`bun run test`、`bun run build`、`bun run build:release`、`bun run test:package`，全部通过。
- [ ] 6.2 手动验收：在一个 `PATH` 不含 Bun 的 shell 里用 `npm install -g ./artifacts/neko-harness-<版本>.tgz` 安装，依次运行 `neko --version`、`neko web`、`neko tui` 并完成一轮带工具调用的真实对话（需要 `DEEPSEEK_API_KEY`），确认沿用已有的 `~/.neko/neko.sqlite` 能打开原会话。
- [x] 6.3 运行 `openspec validate migrate-runtime-to-node --strict` 通过。

## Workflow follow-up

- 下一版发布说明（`docs/releases/vX.Y.Z.md`）必须标明运行时由 Bun 改为 Node 的破坏性变更，并包含迁移步骤；同时说明旧版本的 `neko update` 会把 Bun 安装升级到无法在纯 Bun 环境启动的版本。
- 归档本变更后再开始 `migrate-toolchain-to-pnpm`。
