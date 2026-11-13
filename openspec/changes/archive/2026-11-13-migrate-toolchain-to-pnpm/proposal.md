# Proposal

## Why

`migrate-runtime-to-node` 之后，发布产物只在 Node 上运行，但开发工具链仍是 Bun：依赖安装、测试、打包与脚本执行都由 Bun 承担，246 个测试文件跑在与用户不同的运行时上，只能靠安装冒烟兜底。把工具链迁到 pnpm 与 Node，让开发、测试与发布使用同一个运行时，并彻底移除对 Bun 的依赖。

## What Changes

- **BREAKING（开发）** 包管理由 Bun 改为 pnpm：新增 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml`，删除 `bun.lock`、`bunfig.toml`、`.bun-version` 与 `@types/bun`；根包 `packageManager` 改为 pnpm。采用 pnpm 默认的严格 `node_modules` 布局，补齐目前靠 hoisted 布局才解析得到的未声明依赖（已知：tui 测试的 `ws` 类型、两个字面量扫描脚本的 `rolldown/utils`、根脚本引用的 `@neko-harness/core`）。
- **BREAKING（开发）** 测试运行器由 `bun:test` 改为 vitest，测试在 Node 上执行：248 个导入 `bun:test` 的文件改为 vitest 接口，保留 `neko-source` 条件解析、并行执行与一个串行入口；逐处迁移 `mock.module`（13 处，全部在 web 测试）、`spyOn` / `mock` 及 Bun 专有断言（`toEndWith`、`toBeOneOf`）。43 个测试文件里的 119 处 `Bun.*` 调用（`Bun.sleep` 101、`Bun.file` 8、`Bun.spawn` 7、`Bun.write` 2、`Bun.spawnSync` 1）与 `import.meta.dir` 改用 Node 标准接口。
- 发布打包由 `Bun.build` 改为 rolldown（vite 8 已带入），产物形态与 `migrate-runtime-to-node` 确定的一致（Node 目标、外置运行时依赖、注入版本常量）。
- 源码与脚本直接由 Node 执行（依赖 Node 自带的类型擦除，仓库已启用 `erasableSyntaxOnly` 与 `.ts` 导入后缀）：`pnpm neko` 以 `node --conditions=neko-source` 运行源码；`scripts/*.ts` 去掉 `Bun.spawn` / `Bun.write` / `Bun.sleep` 等调用，JSON 导入改用 import attributes。
- 各包与根的 `build` / `check` / `test` 等脚本由 `bun run`、`bun --bun run` 改为 pnpm 与 node；命令名保持不变（`pnpm build`、`pnpm test`、`pnpm test:serial`、`pnpm check`、`pnpm check:write`、`pnpm neko`、`pnpm build:release`、`pnpm test:package`）。
- 发布流水线（`release.yml`）改用 pnpm + Node 完成安装、构建、检查、测试与打包；npm Trusted Publishing 的发布步骤、workflow 文件名与 `npm` environment 不变。
- 更新 AGENTS.md（常用命令、约定、测试说明）、README 的开发章节与 `docs/dev/releasing.md`。
- 不在本变更内：运行时行为、入口、`neko update` 与安装方式（已由 `migrate-runtime-to-node` 完成）；Flutter 移动端工具链；biome 与 TypeScript 版本。不发版、不提交 git commit。

## Capabilities

### New Capabilities

无；沿用现有能力边界。

### Modified Capabilities

- `builtin-skills`：「两种运行形态一致」场景中的源码运行形态由 Bun 源码模式改为 Node 源码模式，要求不变。

## Impact

- 依赖与配置：根与各包 `package.json`（脚本、`packageManager`、新增 vitest，rolldown 显式声明）、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、vitest 配置；删除 `bun.lock`、`bunfig.toml`、`.bun-version`。
- 测试：`packages/*/test` 与源码旁的全部测试文件及测试支撑代码；其中用 `process.execPath` 拉起子进程的测试需逐个确认在 Node 下的参数。
- 脚本：`scripts/build-release.ts`、`scripts/test-package.ts`、`scripts/release-preflight.ts`、`scripts/benchmark-workspace-files.ts`、`scripts/mobile-dev-pair.ts`、`scripts/mobile-e2e-gateway.ts`，以及引用这些命令的 `apps/mobile/README.md`、`docs/mobile/api-v1.md`。
- 发布：`.github/workflows/release.yml`、`docs/dev/releasing.md`。
- 文档：AGENTS.md、README。
- 顺序依赖：在 `migrate-runtime-to-node` 之后实施。
- 风险与待验证：vitest 下的通过率与耗时（当前 Bun 并行约 12 秒）；`vi.mock` 的提升语义与 `mock.module` 不同；rolldown 产物尚未实测；pnpm 默认不执行依赖的构建脚本（安装实验中被忽略的是 `@google/genai`、`protobufjs`），需确认无需放行。
