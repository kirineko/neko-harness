# Design

## Context

动机见 proposal.md。本变更在 `migrate-runtime-to-node` 之后实施，届时发布产物已运行在 Node 上，安装冒烟已用 npm 安装并由 Node 启动；剩下的 Bun 依赖全部在开发侧。调研时确认的现状：

- **包管理**：`bun.lock`、`bunfig.toml`（`linker = "hoisted"`，`[test] root = "./packages"`）、`.bun-version`、根 `package.json` 的 `workspaces` / `packageManager` / `trustedDependencies`。根包同时是 workspace 根与对外发布的包，`dependencies` 就是发布清单。
- **pnpm 实验**（pnpm 10.33.2，仓库副本）：`pnpm install` 成功，只提示忽略了 `@google/genai`、`protobufjs` 的构建脚本；core、gateway、tui、web 的 `tsc` 零错误，`vite build` 通过；cli 的 `tsc` 报 1 处错误，未查看内容。严格布局暴露了未声明依赖：`packages/tui/test/gateway-startup.test.ts` 的 `ws` 类型、`packages/tui/test/support/literal-scan.ts` 与 `packages/web/test/support/cjk-scan.ts` 的 `rolldown/utils`、`scripts/mobile-dev-pair.ts` 的 `@neko-harness/core`。
- **测试**：248 个文件从 `bun:test` 导入，用到 `expect`、`it`、`describe`、`beforeEach` / `afterEach` / `beforeAll` / `afterAll`、`spyOn`（12 个文件）、`mock`（11 个文件）、`it.skipIf`（8 处）。`mock.module` 13 处，全部在 `packages/web/test` 的 10 个文件里。Bun 专有断言 6 处（`toEndWith` 5、`toBeOneOf` 1）。43 个测试文件直接调用 `Bun.*` 共 119 处（`Bun.sleep` 101、`Bun.file` 8、`Bun.spawn` 7、`Bun.write` 2、`Bun.spawnSync` 1），另有 2 处 `import.meta.dir`。web 的 22 个 `.tsx` 测试自己创建 jsdom，不依赖运行器的 DOM 环境。多个测试用 `process.execPath --conditions=neko-source <入口>.ts` 拉起子进程。
- **脚本**：`scripts/*.ts` 用到 `Bun.build`、`Bun.spawn`、`Bun.spawnSync`、`Bun.sleep`、`Bun.write`、`Bun.resolveSync`、`import.meta.dir`，以及不带 import attributes 的 JSON 导入。
- **Node 直接运行源码**：`node --conditions=neko-source packages/cli/src/main.ts`（Node 24.15）的 `--version` 与 `serve --help` 可用；仓库已启用 `erasableSyntaxOnly` 与 `.ts` 导入后缀，`.tsx` 只存在于 web 客户端与 web 测试。
- vite 8.3.4 已带入 rolldown 1.2.19。vitest 当前稳定版 5.1.0 要求 Node `^22.12 || ^24` 与 vite 6–8。

## Goals / Non-Goals

**Goals:**

- 仓库不再需要安装 Bun：安装、构建、检查、测试、打包、发布流水线全部由 pnpm 与 Node 完成。
- 测试与发布产物运行在同一个运行时上。
- 开发命令名保持不变，只换前缀（`bun run x` → `pnpm x`）。

**Non-Goals:**

- 不改任何运行时行为、协议、存储格式与用户可见文案。
- 不借机重写测试逻辑或调整测试覆盖范围；只做运行器与 API 的等价替换。
- 不升级 biome、TypeScript、Pi 依赖；不改 Flutter 工具链。
- 不追求测试耗时与 Bun 持平，只要求可接受并记录实际数字。

## Decisions

### D1 pnpm 版本与布局

- `packageManager` 固定为 `pnpm@10.33.2`（实验所用版本），流水线用 `pnpm/action-setup` 读取该字段。开发 Node 版本用 `.node-version`（24.x）声明，替代 `.bun-version`；`engines.node` 维持 `>=22.19.0`。
- 新增 `pnpm-workspace.yaml`（`packages/*`），删除根 `package.json` 的 `workspaces` 与 `trustedDependencies`、`bunfig.toml`、`bun.lock`、`.bun-version`、`@types/bun`。
- 使用 pnpm 默认的严格 `node_modules` 布局，不设 `node-linker=hoisted`。理由：未声明依赖能在开发期暴露，而不是等到发布包里才出错。
- 依赖构建脚本保持不执行：把 `@google/genai`、`protobufjs` 写入 `ignoredBuiltDependencies`，使安装输出无警告。安装实验与此前的 Bun 安装都没有运行它们，现有测试与 SDK 冒烟不依赖其产物。
- 备选 npm workspaces：否决，用户明确要求 pnpm。备选 `node-linker=hoisted`：否决，只是把问题继续藏起来。

### D2 锁文件迁移与版本漂移

pnpm 不能导入 `bun.lock`，首次 `pnpm install` 会重新解析传递依赖。直接依赖全部是精确版本，不会变；传递依赖可能漂移。做法：迁移前导出 Bun 解析结果，迁移后导出 pnpm 解析结果，逐包比对版本；`@earendil-works/*` 及其直接依赖出现差异时，用 `pnpm.overrides` 钉回原版本，其余差异记录在本变更的验证记录里。

### D3 补齐未声明依赖

- `packages/tui`：`@types/ws` 加入 devDependencies。
- `packages/tui`、`packages/web`：`rolldown` 加入 devDependencies（两个字面量扫描脚本使用 `rolldown/utils`），根包同样声明 `rolldown` 供打包使用；三处版本一致并精确锁定。
- `scripts/mobile-dev-pair.ts`：对 `@neko-harness/core` 的导入改为相对源码路径，与该脚本里其他导入的写法一致。不在根包声明 `workspace:*` 依赖，避免它进入发布清单。
- cli 的 `tsc` 错误在实施时先复现并归类；如属同类未声明依赖，按本节处理。

### D4 脚本命令

- 各包 `build` 脚本里的 `bun --bun run tsc` / `vite` 改为直接调用 `tsc` / `vite`。
- 根脚本：`build` 用 `pnpm -r run build`（pnpm 按依赖拓扑排序，结果与现在手写的 core → gateway → tui → web → cli 顺序等价）；`check` / `check:write` 直接调用 `biome` 与 `tsc`，再执行 web 的 `check:client`；`neko` 为 `node --conditions=neko-source packages/cli/src/bin.ts`；`build:release`、`test:package` 用 `node scripts/<名字>.ts`。
- 命令名全部保留，AGENTS.md 与 README 只替换前缀。

### D5 测试运行器：vitest

- 精确锁定 `vitest@5.1.0`，根目录一份配置：`include` 为 `packages/*/test/**/*.test.{ts,tsx}`，环境为 `node`（web 测试自建 jsdom，保持不变），解析条件加入 `neko-source`（含 SSR 解析），进程池用 `forks`。选择 `forks` 是因为不少测试依赖进程级状态（信号、`process.chdir`、子进程、`ps` 探测），线程池下这些行为不同。
- `test` = `vitest run`（文件间并行、文件内串行，每个文件独立进程，对应现在的 `--parallel` 与隐含的文件隔离）；`test:serial` = `vitest run --no-file-parallelism`（对应现在的 `--isolate` 顺序执行）。
- 备选 `node:test`：否决，`.tsx` 测试需要额外的转译加载器，`mock.module` 没有成熟对应物，断言 API 也要全部重写。备选 jest：否决，ESM 与 `.ts` 后缀导入的配置成本高，且仓库已有 vite。

### D6 测试 API 迁移规则

机械替换（写一次性脚本完成，不提交脚本）：

| 现在 | 迁移后 |
|---|---|
| `from "bun:test"` | `from "vitest"` |
| `spyOn(...)` | `vi.spyOn(...)` |
| `mock(fn)` | `vi.fn(fn)` |
| `Bun.sleep(ms)` | `node:timers/promises` 的 `setTimeout(ms)` |
| `Bun.file(p).text()` / `.json()` / `.exists()` | `node:fs/promises` 的 `readFile` / `JSON.parse` / `access` |
| `Bun.write(p, data)` | `writeFile(p, data)` |
| `Bun.spawn` / `Bun.spawnSync` | `node:child_process` 的 `spawn` / `spawnSync`，输出按流读取 |
| `import.meta.dir` | `import.meta.dirname` |
| `toEndWith(x)` / `toBeOneOf(xs)` | 标准断言（`endsWith` 判断、`toContain`） |

`it.skipIf`、`expect.stringContaining` 等、数字形式的超时参数在 vitest 中同名可用，不需要改。

需要逐个处理的：

- `mock.module`（web 的 10 个文件）：Bun 在调用处生效，`vi.mock` 会被提升到文件顶部，工厂里引用的顶层变量此时尚未初始化。规则：被测模块在 mock 之后才动态导入的，用不提升的 `vi.doMock`，语义与现在一致；被测模块是静态导入的，用 `vi.mock` 并把工厂依赖的状态放进 `vi.hoisted`。不改测试断言。
- 拉起子进程的测试：`process.execPath` 变成 node，`--conditions=neko-source <入口>.ts` 依赖 Node 自带的类型擦除，写法不变；逐个运行确认。
- 依赖 Bun 特有行为的断言（如 `ws` 文本帧形态、Windows 上 IPv4 监听地址的表示、worker 退出时序）：源码里的兼容处理保留，只在测试断言确实绑定 Bun 行为时调整断言，并更新相关注释。

### D7 打包器：rolldown

`scripts/build-release.ts` 改用 rolldown 的 JS API，产物约束与 `migrate-runtime-to-node` 一致：三个入口各产出单文件（`dist/neko.js` 启动器、`dist/cli.js`、`dist/gateway.js`），ESM、Node 平台、解析条件含 `neko-source`、根包 `dependencies` 全部外置、动态导入内联到同一文件、注入 `NEKO_RELEASE_BUILD` / `NEKO_RELEASE_VERSION` / `NEKO_BUILD_VERSION` 与 Node 版本下限，启动器保留 node shebang 与可执行权限。产物断言（无 `Bun.`、无 `import.meta.require`）保留。验收标准是现有安装冒烟原样通过。

- 备选 esbuild：可行，但需要新增一个依赖；rolldown 已随 vite 进入依赖树，且扫描脚本已在使用。
- 备选 `tsc` 产物直接发布、不打包：否决，内部 workspace 包不对外发布，发布包必须自包含。

### D8 脚本由 Node 直接执行

`scripts/*.ts` 用 `node` 运行（Node 22.19 起类型擦除默认开启）：`Bun.spawn` / `Bun.spawnSync` 改 `node:child_process`，`Bun.write` 改 `writeFile`，`Bun.sleep` 改 `node:timers/promises`，`Bun.resolveSync` 改 `createRequire().resolve` 或 `import.meta.resolve`，`import.meta.dir` 改 `import.meta.dirname`。根 `package.json` 改为经 `scripts/manifest.ts` 从磁盘读取：Node 要求 JSON 模块带 import attributes，而仓库的 `module: Node16` 不接受这种写法（实施时确认，`tsc` 报 TS2823），不为此改动全仓库的编译设置。打包命令由 `bun pm pack` 改为 `pnpm pack --pack-destination artifacts`，产物清单检查（只含 `dist/`、`package.json`、README、LICENSE，`dependencies` 里没有 `@neko-harness/*`）保持不变。

### D9 类型检查配置

根 `tsconfig.json` 的 `types` 去掉 `"bun"`；web 的测试 tsconfig 同步检查。`@types/node` 版本不变。

### D10 发布流水线

`release.yml` 的 `preflight` 与 `verify` 用 `pnpm/action-setup` 加 `actions/setup-node`（24.x，启用 pnpm 缓存），步骤改为 `pnpm install --frozen-lockfile`、`pnpm build:release`、`pnpm check`（仅 Linux）、`pnpm test`、`pnpm test:package`；`preflight` 用 `node scripts/release-preflight.ts`。Linux 上 Node 22.19.0 的冒烟保留。`publish`、`github-release`、Android 两个 job、workflow 文件名与 `npm` environment 都不动。

### D11 迁移顺序

先让 pnpm 安装、构建与类型检查通过，再建立 vitest 并按包迁移测试（core → gateway → tui → web → cli），最后换打包器与流水线并删除 Bun 相关文件。迁移期间 Bun 的锁文件与脚本保留到最后一步才删，任何一步失败都还能用 Bun 跑原来的测试做对照。

## Risks / Trade-offs

- [vitest 下耗时明显长于 Bun 的约 12 秒] → 记录实际耗时；超过 60 秒时先调整 `forks` 的并发数，仍不够再评估把无进程级副作用的包改用线程池。不作为阻塞项。
- [测试在 Node 上暴露出原先被 Bun 行为掩盖的真实问题] → 这是迁移的收益；属于产品缺陷的单独修复并在验证记录里列出，不通过放宽断言来绕过。
- [`vi.mock` 提升导致的初始化顺序错误] → 按 D6 的规则逐文件处理，web 的 10 个文件每个单独跑通。
- [传递依赖版本漂移] → D2 的比对与 `pnpm.overrides`。
- [rolldown 产物与 `Bun.build` 产物行为不同（动态导入、`import.meta.url` 相对路径、条件解析）] → 安装冒烟覆盖启动、gateway 拉起、静态资源、内置技能目录与原生依赖；冒烟不过就不删除 Bun 的构建脚本。
- [Node 直接运行源码时遇到类型擦除不支持的语法] → `erasableSyntaxOnly` 已在编译期禁止这类语法；用 `pnpm neko tui` 与 `pnpm neko web` 各完成一次真实启动来确认。
- [Windows 上 pnpm 的符号链接布局与测试里的路径断言冲突] → 流水线三平台跑完整测试；按失败用例修正路径比较（统一用真实路径）。
- [Node 不能监听超过系统上限的 Unix socket 路径（macOS 104 字节，Linux 108 字节），Bun 可以；macOS 的系统临时目录本身约 50 字节，在其下建临时数据目录并启动 gateway 的测试迁到 Node 后会报 `listen EINVAL`（`migrate-runtime-to-node` 实施时在安装冒烟里已遇到）] → 取决于 `migrate-runtime-to-node` 对该问题的处理结论；该变更的结论是只给出明确报错（其 design D9），所以这些测试的临时目录在 POSIX 上统一改用 `/tmp`。
- [同一台机器同时跑两套完整测试会互相干扰（部分用例用 `ps` 按固定标记判断进程）] → 约束不变，写进 AGENTS.md 的测试说明。

## Migration Plan

1. 按 D11 的顺序在一个分支上完成，最后一步才删除 Bun 相关文件。
2. 合入后，开发者需要安装 Node 24 与 pnpm（`corepack enable` 或单独安装），删除本地 `node_modules` 后执行 `pnpm install --frozen-lockfile`。
3. 回退：整体回退该分支的合并提交即可恢复 Bun 工具链；本变更不触及运行时与数据。
