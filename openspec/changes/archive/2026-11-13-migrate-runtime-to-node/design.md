# Design

## Context

动机见 proposal.md。与方案相关的现状（调研时在 macOS arm64、Node 24.15、npm 11.12、Bun 1.4.4 上实测或读源码确认）：

- `packages/*/src` 没有任何 `Bun.*` / `bun:` 调用；gateway 子进程由 `gatewayCommand` 用 `process.execPath` 拉起，运行时自动跟随父进程。上游 7 个 Pi 包都声明 `engines.node >=22.19.0`。
- 发布产物由 `scripts/build-release.ts` 用 `Bun.build({ target: "bun" })` 生成 `dist/neko.js` 与 `dist/gateway.js`。该产物含 `import.meta.require`，Node 下 `--help` 可用，但 `serve` / `web` 崩溃（`__require is not a function`）。
- 入口文件带 `#!/usr/bin/env bun` 时，`Bun.build` 即使 `target: "node"` 也会写入 `// @bun` 标记；去掉 Bun shebang 后，`target: "node"` 的产物在 Node 下跑通了 gateway、Web（含 SIGTERM 正常退出）、TUI 真实对话与 `scripts/package-sdk-smoke.mjs`（pi-env daemon、Photon、sharp、codemode 沙箱）。
- 打包后外部依赖的静态 `import` 位于产物顶部，旧版 Node 会在执行任何业务代码之前就因模块加载失败而退出。
- `neko update`（`packages/cli/src/update.ts`）用 `process.execPath` 执行 `pm bin -g` 与 `add --global`，并读取 Bun 全局目录下的 `package.json` 判断安装来源；这些都是 Bun 专有的。npm 全局安装没有对应的全局 `package.json`。
- npm 全局安装 0.5.4 成功，但打印 `ws@8.22.0` 与 chord 可选 peer `ws@8.21.0` 的 ERESOLVE 警告。
- 本变更期间开发工具链仍是 Bun（`bun run test` 等），由 `migrate-toolchain-to-pnpm` 另行迁移。

## Goals / Non-Goals

**Goals:**

- `npm install -g neko-harness` 之后，`neko` 的全部命令在 Node 22.19 及以上可用，Linux / macOS / Windows 都经流水线验证。
- 不满足版本要求时给出可读的报错，而不是模块加载错误。
- `neko update` 在 npm 全局安装上保持现有语义（识别、占用、验证、失败处理）。

**Non-Goals:**

- 不主动检测并拒绝在 Bun 上运行发布产物：这是不受支持的用法，不为它增加分支。
- 不迁移开发工具链、测试运行器与打包器。
- 不改变 Windows「只给手动升级指引」的策略。
- 不提供 Bun 安装到 npm 安装的自动迁移。

## Decisions

### D1 发布入口拆成启动器与 CLI 产物

`dist/neko.js` 改为一个很小的启动器：只检查 Node 版本，通过后再动态加载 `dist/cli.js`（原 CLI 入口的打包产物）。启动器不依赖任何第三方包，只使用旧版 Node 也能解析的语法。

- 源码放在 `packages/cli/src/bin.ts`，版本比较是独立的纯函数（可单测）。动态加载的目标沿用 `gatewayCommand` 的做法：按 `NEKO_RELEASE_BUILD` 在 `./cli.js` 与 `./main.ts` 之间选择，打包器不会把它内联。
- 最低版本只有一个来源：根 `package.json` 的 `engines.node`，构建时注入启动器。
- `dist/gateway.js` 不检查版本：它只由已通过检查的进程用同一个 `process.execPath` 拉起。但它同样是一个启动器（`packages/gateway/src/bin.ts`，加载 `dist/gateway-main.js`），原因见 D8。
- 备选：把检查写在 `main.ts` 顶部。否决，因为打包后外部依赖的静态导入先于它执行，旧版 Node 根本走不到检查。
- 备选：只靠 `engines`。否决，npm 对 `engines` 不匹配默认只警告。

### D2 本变更仍用 `Bun.build`，目标改为 Node

`scripts/build-release.ts` 的 `target` 改为 `"node"`，入口文件的 shebang 改为 `#!/usr/bin/env node`（`cli` 的 shebang 移到启动器，`gateway` 保留 node shebang）。构建脚本在产物生成后断言：`dist/*.js` 不含 `// @bun`、`import.meta.require` 与 `Bun.`。

- 这个组合已实测可用；换打包器属于工具链变更，留给 `migrate-toolchain-to-pnpm`，避免一次改两件事。
- `dist/` 内的相对布局不变（`gateway.js`、`client/`、`skills/`、`../package.json`），新增的 `cli.js` 与它们同级，现有的相对路径解析不需要改。

### D3 `neko update` 以 npm 全局目录识别安装

受支持的安装 = 当前包目录（由运行中的模块位置推出）与 `npm root -g` 下的 `neko-harness` 是同一个真实目录，且该目录本身不是符号链接、能读到稳定版本号。

- `npm` 从 `PATH` 解析并用 `execFile` 调用，不经 shell。`PATH` 上的 npm 属于另一个 Node 或另一个前缀时，目录比对自然失败，按不受支持处理，不会改到别的安装。
- 安装命令为 `npm install -g neko-harness@<目标版本>`；验证沿用现有做法：重新读取安装清单，并用当前 `process.execPath` 运行新入口的 `--version`，两者一致且不低于目标。
- 升级占用目录放在 npm 全局 `node_modules` 下，与安装本身同权限：能安装就能加锁。创建占用目录遇到 `EACCES` / `EPERM` 时，按 spec 的「全局安装目录不可写」返回失败并给出手动命令。
- 删除 Bun 专有逻辑：`pm bin -g`、读取 Bun 全局 `package.json` 的 `file:` / `link:` / `workspace:` 判断。链接安装由「目录是符号链接」覆盖（`npm link` 产生的就是符号链接）。
- 备选：同时识别 Bun 全局安装并调用 `bun add --global`。否决，Bun 安装已不受支持，保留会让两套识别逻辑长期并存。
- 备选：用 `dirname(process.execPath)/npm`。否决，nvm、fnm、系统包管理器的布局不一致，而目录比对已经保证了安全。

### D4 Windows 维持手动指引

`upgradeCommand("win32")` 改为 `npm install -g neko-harness@latest`，其余行为不变。TUI 版本提示与 `neko update --help` 经同一个函数或同一条文案取值。

### D5 `ws` 对齐到 chord 的 peer 版本

把 `ws` 从 `8.22.0` 改为 `8.21.0`（根包与各 workspace 包保持一致，仍精确锁定），使 npm 安装不再打印 ERESOLVE 警告。验收以安装冒烟的 npm 输出不含 `ERESOLVE` 为准。如果降级导致现有测试失败，则保留 `8.22.0`，在 README 说明该警告可忽略，并从冒烟断言中去掉这一条。

### D6 安装冒烟改为 npm 安装加 Node 运行

`scripts/test-package.ts`（本变更内仍由 Bun 执行）改为：

- 用 `npm install -g --prefix <临时目录>` 安装打好的 tarball，从该前缀的 bin 目录启动 `neko`（Windows 是 `neko.cmd`，需经 `cmd` 启动）。
- 子进程的 `PATH` 只含 Node 所在目录与系统目录，不含 Bun，确保不会借到 Bun。
- 保留现有断言（版本、四个子命令的帮助、Web 与 gateway 就绪及版本一致、静态资源、SIGTERM 正常退出），sharp 与 Pi SDK 冒烟改用 `node` 执行。
- `neko update` 断言：临时前缀不是 npm 的全局目录，macOS / Linux 应以「不支持自升级」拒绝，Windows 输出 npm 手动命令。
- 新增断言：`dist/neko.js` 首行是 node shebang；在 stderr 上不出现运行时警告。

流水线 `verify` 在三个平台加装 Node 24.x 跑上述冒烟，Linux 另加一次 Node 22.19.0（声明的下限）。低版本报错路径不在流水线里装旧 Node 验证，由启动器的单元测试覆盖（传入伪造的版本号）。

### D7 文档与清单

- 根 `package.json`：`engines` 改为 `{ "node": ">=22.19.0" }`，`description` 与 `keywords` 去掉 Bun。`packageManager` 与 `.bun-version` 保留，因为开发仍用 Bun。
- README（英文与 `docs/README.zh-CN.md`）：安装要求与命令改为 Node / npm，新增「从 Bun 安装迁移」小节（安装 Node 22.19+，`bun remove --global neko-harness`，`npm install -g neko-harness`，`~/.neko` 原地沿用）。
- `docs/dev/releasing.md`、AGENTS.md：说明发布产物运行在 Node 上、冒烟用 npm 安装，开发命令暂时仍是 Bun。

### D8 过滤 Node 22 的 `node:sqlite` 实验性警告（实施中确认）

在 Node 22.19.0 上实测，`node:sqlite` 一被加载就打印 `ExperimentalWarning: SQLite is an experimental feature`，连 `neko --version` 也会出现（Node 24 不再打印）。处理：core 的纯模块 `runtime-warnings.ts`（子路径 `@neko-harness/core/runtime-warnings`，自身没有任何导入）包装 `process.emitWarning`，只丢弃这一条，其余警告原样转发。它必须在存储模块加载之前生效，而打包后依赖的静态导入先于入口代码执行，所以由两个启动器调用：`dist/neko.js` 在版本检查通过后调用，`dist/gateway.js` 在加载 `dist/gateway-main.js` 之前调用。构建脚本断言两个启动器没有静态 `import`。

- 备选：给 gateway 子进程加 `--disable-warning=ExperimentalWarning`。否决，它会关掉全部实验性警告，而且 `neko serve` 的进程内 gateway 仍需另一套处理。
- 源码运行与 `tsc` 产物（`node packages/cli/dist/main.js`）不经过启动器，在 Node 22 上仍会看到该警告；这两种是开发形态，不处理。

### D9 超长 Unix socket 路径：明确报错（实施中发现）

Node 不能监听超过 `sockaddr_un` 上限的路径，报 `EINVAL`；Bun 可以（实测 176 字节的路径在 Bun 下可监听并连接）。gateway 的 socket 默认是 `<数据目录>/<serverId>.sock`，文件名固定 41 字节，数据目录路径超过约 60 字节（macOS）就会触发。默认的 `~/.neko` 不受影响。

处理：在 gateway 的启动错误翻译里识别「`EINVAL` 且路径字节数超过平台上限」，改报路径、字节数、上限与改用 `--storage` / `--socket-path` 的指引。只在监听真的失败后才判断，所以不需要区分运行时，开发期在 Bun 上的行为不变。

- 备选：短暂 `chdir` 后用相对路径监听，保持与 Bun 相同的行为。否决，`chdir` 是进程级的，gateway 进程里有 worker 线程，客户端连接侧也要做同样处理。
- 备选：自动改用临时目录下的短路径。否决，前端按 `<数据目录>/<serverId>.sock` 约定发现网关，悄悄换路径会破坏发现。
- 安装冒烟的临时目录在 POSIX 上改用 `/tmp`（macOS 的系统临时目录本身约 50 字节）。

## Risks / Trade-offs

- [Windows、Linux、Node 22 均未实测] → 三平台安装冒烟加 Linux 上的 Node 22.19.0；在这些全部通过之前不发版。
- [Node 22 上 `node:sqlite` 打印 ExperimentalWarning，污染 TUI 或日志] → 已确认并按 D8 处理；冒烟断言 stderr 无运行时警告，macOS 上 Node 22.19.0 与 24.15.0 均通过。
- [Unix socket 路径长度：Node 不能监听超过系统上限的路径（macOS 104 字节，Linux 108 字节），报 `EINVAL`；Bun 可以（实测 176 字节的路径在 Bun 下可监听并连接）。gateway 的 socket 默认在数据目录下，文件名固定 41 字节，所以数据目录路径超过约 60 字节（macOS）时 gateway 在 Node 上无法启动，而此前在 Bun 上可以] → 按 D9 给出明确报错。这是相对 Bun 的行为退化：此前可用的超长数据目录现在必须换成更短的路径；由 TUI / Web 拉起 gateway 时，它们追加的「地址可能被其他实例占用」提示仍在，但上方已有网关的准确说明。
- [测试仍跑在 Bun 上，Node 侧只有冒烟覆盖] → 接受，直到 `migrate-toolchain-to-pnpm` 完成；冒烟覆盖启动、存储、原生依赖与退出这些最容易因运行时不同而出错的路径。
- [系统级 Node（全局目录归 root）下 `neko update` 无法写入] → 返回失败并给出手动命令，不尝试提权。
- [现有 Bun 用户升级后 `neko` 无法启动或无法自升级] → 发布说明与 README 的迁移小节；旧版本的 `neko update` 仍会把 Bun 安装升到新版本，新版本在只有 Bun 的机器上启动失败，这一点必须写进发布说明。
- [`ws` 降一个补丁之外的小版本] → 由现有 gateway 链路测试守护；失败则按 D5 的回退处理。

## Migration Plan

1. 合入本变更后，按 `docs/dev/releasing.md` 发布下一个版本；发布说明标明运行时变更与迁移步骤。
2. 用户迁移：安装 Node 22.19 及以上，卸载 Bun 全局安装，`npm install -g neko-harness`。数据与凭据在 `~/.neko`，不需要处理。
3. 回退：npm 上已发布的版本不能覆盖。如果发现 Node 运行时的严重问题，回退代码并发布新的补丁版本；用户可用 `bun add --global neko-harness@<上一个 Bun 版本>` 暂时退回。存储格式未变，回退不涉及数据。
