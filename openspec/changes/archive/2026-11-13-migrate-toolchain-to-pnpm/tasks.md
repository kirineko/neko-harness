# Tasks

## 1. pnpm 安装与依赖布局

- [x] 1.1 迁移前导出 Bun 的依赖解析结果（`bun pm ls --all`）存为本变更目录下的 `verification.md` 附录，供 1.4 比对。验证：文件中能查到 `@earendil-works/*` 各包及其直接依赖的版本。
- [x] 1.2 新增 `pnpm-workspace.yaml`（`packages/*`，`ignoredBuiltDependencies` 含 `@google/genai`、`protobufjs`）与 `.node-version`（24.x）；根 `package.json` 的 `packageManager` 改为 `pnpm@10.33.2`，删除 `workspaces` 与 `trustedDependencies`。此时保留 `bun.lock`、`bunfig.toml`、`.bun-version` 作对照。验证：`pnpm install` 成功且输出没有被忽略构建脚本的警告，生成 `pnpm-lock.yaml`。
- [x] 1.3 补齐未声明依赖：`packages/tui` 加 `@types/ws`；`packages/tui`、`packages/web` 与根包加精确版本的 `rolldown`（与 vite 带入的版本一致）；`scripts/mobile-dev-pair.ts` 对 `@neko-harness/core` 的导入改为相对源码路径；复现并修复 `packages/cli` 的 `tsc -p tsconfig.build.json` 错误。验证：在 pnpm 布局下根目录 `tsc --noEmit` 只剩与 `bun` 类型有关的错误（留给 3.x），各包 `tsc -p tsconfig.build.json` 零错误。
- [x] 1.4 比对 1.1 的结果与 `pnpm list -r --depth Infinity`：`@earendil-works/*` 及其直接依赖有版本差异的用 `pnpm.overrides` 钉回，其余差异列入 `verification.md`。验证：`verification.md` 有差异表且 `@earendil-works/*` 及其直接依赖一栏无差异；`pnpm install --frozen-lockfile` 通过。

## 2. 构建、检查与源码运行

- [x] 2.1 各包 `package.json` 的 `build` / `check:client` / `dev` 脚本去掉 `bun --bun run` 前缀；根脚本 `build` 改为 `pnpm -r run build`，`check` / `check:write` 直接调用 `biome` 与 `tsc` 后执行 web 的 `check:client`，`neko` 改为 `node --conditions=neko-source packages/cli/src/bin.ts`。验证：`pnpm build` 成功且各包 `dist/` 生成；`pnpm neko --version` 输出 `development`，`pnpm neko serve --help` 输出中文帮助。
- [x] 2.2 用 Node 源码模式做一次真实启动：`pnpm neko web --no-open` 能就绪并响应 `/api/info`，Ctrl+C 正常退出；`pnpm neko tui` 能进入界面并完成一轮对话（需要 `DEEPSEEK_API_KEY`）；内置技能列表与 `pnpm build` 后用 `node packages/cli/dist/main.js` 启动时一致（对应 builtin-skills 的「两种运行形态一致」）。验证：上述三项的结果记入 `verification.md`。
- [x] 2.3 更新 AGENTS.md「常用命令」与「约定」中关于安装、构建、检查、运行源码与示例的命令（`bun install` → `pnpm install --frozen-lockfile`，`bun run x` → `pnpm x`，示例改为 `node --conditions=neko-source packages/core/examples/chat.ts`，「TS 运行用 Bun」改为 Node），README 两个语言版本的开发章节同步。验证：文档中的每条命令在本机按原样执行成功。

## 3. vitest 基础设施

- [x] 3.1 根包加入精确版本的 `vitest@5.1.0`，新增根目录 vitest 配置（`include` 为 `packages/*/test/**/*.test.{ts,tsx}`、`node` 环境、解析条件含 `neko-source`、`forks` 进程池）；根 `tsconfig.json` 与 `packages/web/tsconfig.test.json` 的 `types` 去掉 `"bun"`。验证：`pnpm exec vitest run packages/cli/test/help.test.ts` 能收集到该文件（此时允许因未迁移而失败）。
- [x] 3.2 根脚本 `test` 改为 `vitest run`，`test:serial` 改为 `vitest run --no-file-parallelism`。验证：`pnpm test -- packages/cli` 与 `pnpm test:serial -- packages/cli` 都能运行并只收集 cli 的 4 个测试文件。
- [x] 3.3 写一次性迁移脚本（不提交）完成 design D6 表格里的机械替换，并迁移根目录 `test/` 下的共享测试支撑文件（`faux.ts`、`temp-dir.ts`）。验证：`git grep -n "bun:test" -- test packages/cli` 无结果，`pnpm test -- packages/cli` 全部通过（含拉起 `--conditions=neko-source` 子进程的用例）。

## 4. 按包迁移测试

- [x] 4.1 迁移 `packages/core/test`（77 个测试文件，25 个含 `Bun.*`）。验证：`pnpm test -- packages/core` 全部通过；`git grep -nE "bun:test|Bun\." -- packages/core/test` 无结果。
- [x] 4.2 迁移 `packages/gateway/test`（59 个测试文件，8 个含 `Bun.*`，含 2 处 `import.meta.dir` 与拉起 `scripts/mobile-dev-pair.ts` 的用例）。验证：`pnpm test -- packages/gateway` 全部通过；同样的 `git grep` 无结果。
- [x] 4.3 迁移 `packages/tui/test`（49 个测试文件，6 个含 `Bun.*`）。验证：`pnpm test -- packages/tui` 全部通过；同样的 `git grep` 无结果。
- [x] 4.4 迁移 `packages/web/test`（57 个测试文件）：10 个使用 `mock.module` 的文件按 design D6 的规则逐个改为 `vi.doMock` 或 `vi.mock` + `vi.hoisted`，不改断言。验证：这 10 个文件逐个 `pnpm exec vitest run <文件>` 通过，然后 `pnpm test -- packages/web` 全部通过；`git grep -nE "bun:test|Bun\.|mock\.module" -- packages/web/test` 无结果。
- [x] 4.5 处理迁移中暴露的 Bun 行为依赖：源码里的兼容处理保留（`packages/gateway/src/link.ts`、`packages/gateway/src/mobile/listener.ts`、`packages/core/src/codemode.ts`），更新其中只提 Bun 的注释；任何因 Node 行为不同而改动的断言或发现的产品缺陷逐条记入 `verification.md`。验证：`verification.md` 有该清单（可以为空并注明「无」）。
- [x] 4.6 全量运行并记录耗时：`pnpm test` 与 `pnpm test:serial` 各跑一遍。验证：两者全部通过，耗时写入 `verification.md`；超过 60 秒时按 design 的风险条目调整并发并重测。
- [x] 4.7 更新 AGENTS.md 中的测试说明（`pnpm test` 的并行与隔离方式、`pnpm test:serial` 的用途、不要同时跑两套完整测试）、README 开发章节的测试行与 `docs/mobile/api-v1.md` 里的单测命令。验证：文档中的测试命令按原样执行成功。

## 5. 打包与脚本

- [x] 5.1 `scripts/build-release.ts` 改用 rolldown，满足 design D7 的产物约束，由 `node scripts/build-release.ts` 执行；根脚本 `build:release` 同步。验证：`pnpm build:release` 成功，产物断言通过，`node dist/neko.js --version` 与 `node dist/neko.js serve --help` 正常。
- [x] 5.2 `scripts/test-package.ts` 改为 Node 脚本（去掉 `Bun.*` 与 `import.meta.dir`，JSON 导入加 import attributes），打包命令改为 `pnpm pack --pack-destination artifacts`；根脚本 `test:package` 同步。验证：`pnpm test:package` 通过，tarball 文件清单与 `dependencies` 检查结果与迁移前一致。
- [x] 5.3 其余脚本改为 Node 可直接执行：`scripts/release-preflight.ts`、`scripts/benchmark-workspace-files.ts`、`scripts/mobile-e2e-gateway.ts`（`mobile-dev-pair.ts` 已在 1.3 处理），并更新 `apps/mobile/README.md` 里引用它们的命令。验证：`node scripts/release-preflight.ts` 在当前分支给出与迁移前相同的判定；`node --conditions=neko-source scripts/mobile-e2e-gateway.ts --help`（或其最短可运行调用）能启动；`git grep -n "Bun\." -- scripts` 无结果。

## 6. 发布流水线

- [ ] 6.1 修改 `.github/workflows/release.yml`：`preflight` 与 `verify` 改用 `pnpm/action-setup` 与 `actions/setup-node`（24.x，pnpm 缓存），步骤改为 `pnpm install --frozen-lockfile`、`pnpm build:release`、`pnpm check`（仅 Linux）、`pnpm test`、`pnpm test:package`，保留 Linux 上 Node 22.19.0 的冒烟；不改 `publish`、`github-release`、Android job、workflow 文件名与 `npm` environment。验证：`gh workflow run release.yml --ref <分支>` 演练，三个平台的验证全部通过。
- [x] 6.2 更新 `docs/dev/releasing.md`（工具链、验证步骤、本机检查命令）。验证：文档描述与 `release.yml` 的实际步骤一致。

## 7. 移除 Bun

- [x] 7.1 删除 `bun.lock`、`bunfig.toml`、`.bun-version` 与 `@types/bun`，清理 `.gitignore` 等配置里只为 Bun 存在的条目。验证：删除本地 `node_modules` 后 `pnpm install --frozen-lockfile` 通过；`git grep -n -i "bun" -- ':!openspec' ':!docs/releases' ':!reference'` 的剩余结果只有迁移说明与不相关的单词（如 bundle、bunch），逐条确认。

## 8. 集成验证

- [x] 8.1 在一个 `PATH` 不含 Bun 的 shell 里从干净检出开始依次运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm build`、`pnpm test`、`pnpm build:release`、`pnpm test:package`，全部通过。
- [x] 8.2 运行 `openspec validate migrate-toolchain-to-pnpm --strict` 通过。

## Workflow follow-up

- 本变更在 `migrate-runtime-to-node` 归档之后开始实施。
- 归档时 `verification.md` 随变更一起保留。
