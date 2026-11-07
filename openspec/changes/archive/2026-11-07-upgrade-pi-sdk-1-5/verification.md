# Verification

## 1.4.0 基线（commit c172e7d）

- `bun run check`：通过（biome 529 个文件无问题；根与 Web 客户端 / 测试类型检查通过）
- `bun run test`：1587 pass / 0 fail，241 个文件

## 1.5.0 升级后（任务 8.2）

- `bun install --frozen-lockfile`：通过；`bun.lock` 中每个 `@earendil-works/*` 只有 1.5.0 一个版本，新增 `pi-schema@1.5.0`，不再含 `typebox`。
- `bun run build`、`bun run build:release`：通过。
- `bun run check`：通过（biome 539 个文件；根、Web 客户端与 Web 测试类型检查）。
- `bun run test`：1612 pass / 0 fail，246 个文件（基线 1587 → 新增 follower、continue、轮次上限、计划原子提交、崩溃到限、投影、移动 runFailure、Web/TUI 失败提示等用例）。
- `bun run test:package`：通过（`Pi 1.5 production SDK smoke passed`；`scripts/package-sdk-smoke.mjs` 的 daemon 版本与 `FileWatcher.stop` 随升级更新）。
- `apps/mobile`：`flutter analyze` 无问题，`flutter test` 441 个全部通过；`flutter gen-l10n` 生成物已更新。

## 1.4 存储原地打开（任务 8.3）

用 1.5 打开本机 `~/.neko/neko.sqlite`（由 1.4 写入）的**副本**，原文件未被打开：

- 两次打开结果一致：9 个会话、1044 条条目，全部会话的完整 transcript 可读并能投影（1033 个 ChatView 项），待办 12 条、后台任务 4 个可读，无运行失败残留。
- 在副本中新建会话并用 faux provider 完成一轮回答，重启后该会话与条目仍在（会话数 10）。
- 副本已删除；回退到 1.4 发布版不受支持（`pi.live` v3 等写入后 1.4 无法读取），需在发布说明中写明。
