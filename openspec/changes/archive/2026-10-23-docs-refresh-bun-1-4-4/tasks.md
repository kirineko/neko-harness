# Tasks

## 1. Bun 1.4.4 基线

- [x] 1.1 `.bun-version` → `1.4.4`；根 `package.json`：`packageManager` → `bun@1.4.4`、`engines.bun` → `>=1.4.0 <1.5.0`、`@types/bun` → `1.4.3`。验证：`bun --version` 为 1.4.4，`rg '1\.4\.2' package.json .bun-version` 无匹配
- [x] 1.2 按设计 D5 只改 `bun.lock` 的 workspace 声明与 `@types/bun`、`bun-types` 两条（integrity 取自 `npm view … dist.integrity --registry=https://registry.npmjs.org`，地址风格与现有条目一致）。验证：`bun install --frozen-lockfile` 成功，`git diff --stat bun.lock` 只有这几处改动
- [x] 1.3 更新各处 Bun 版本表述为“推荐 Bun 1.4.4，任意 1.4.x 可用”：`README.md`（Requirements 与 Development 两处）、`docs/README.zh-CN.md`（对应两处）、`AGENTS.md` 第 5 行；`release.yml` 的 `1.4.x` 保持不变。验证：`rg "Bun 1\.4\.2" --glob '!openspec/changes/archive/**' --glob '!bun.lock'` 无匹配（`apps/mobile/README.md` 的历史记录在 4.2 处理）
- [x] 1.4 验证工具链：`bun run check`、`bun run test` 在 Bun 1.4.4 + `@types/bun@1.4.3` 下通过。验证：两条命令退出 0

## 2. 文档目录规整

- [x] 2.1 `git mv .github/RELEASING.md docs/dev/releasing.md`，删除“首次发布”整节与“Pi 1.2 升级发版后的 Windows 验证”整节，开头改写为不依赖 0.1.0 历史的发布维护说明；重算文内相对链接（如 `docs/releases/README.md` 变为 `../releases/README.md`）。验证：文中无对已删除章节或归档 Pi 1.2 验证文件的引用，相对链接目标均存在
- [x] 2.2 `git mv docs/mobile-api-v1.md docs/mobile/api-v1.md`。验证：文件存在于新路径，旧路径不存在
- [x] 2.3 新增 `docs/README.md` 索引：列出 `README.zh-CN.md`、`dev/releasing.md`、`mobile/api-v1.md`、`releases/`，注明语言（中文 / 仅中文），并链接 `../README.md`、`../AGENTS.md`、`../apps/mobile/README.md`、`../openspec/`。验证：索引内每个链接目标存在
- [x] 2.4 同步引用：`README.md`、`docs/README.zh-CN.md`、`AGENTS.md`、`docs/releases/README.md`、`apps/mobile/README.md`、`apps/mobile/lib/core/api/models.dart`、`apps/mobile/lib/core/rpc/rpc_client.dart`、`packages/gateway/src/mobile/protocol.ts`（注释路径）。验证：`rg "RELEASING\.md|mobile-api-v1" --glob '!openspec/changes/archive/**'` 只剩新路径 `docs/dev/releasing.md` 与 `docs/mobile/api-v1.md`（不含旧名），并用脚本检查所有 Markdown 相对链接目标存在
- [x] 2.5 删除 iOS `apps/mobile/ios/Runner/Assets.xcassets/LaunchImage.imageset/README.md`。验证：文件不存在，`flutter` 相关构建不依赖它（`rg LaunchImage apps/mobile --glob '!*.md'` 引用的是 `Contents.json` 与图片，不是该 README）

## 3. 英文 README

- [x] 3.1 对照 `packages/web/src/client/lib/i18n/en.ts` 与 `packages/web/src/client/routes`（含 `/about`），把 `README.md` 中全部 Web 界面标签改为英文标签（Model services、Web search、Context、Appearance、Language、Mobile pairing、About and updates、Skill market、Plan mode (read-only)、Approve and run / Request changes / Cancel and leave plan mode、Steer / Withdraw、Set as default，以及任务、待办入口等以 `en.ts` 实际值为准），删除“web UI ships Chinese labels”整句与随之而来的括注，保持 Clients / Plan mode / First run / Context / Agent capabilities 各节语义不变。验证：逐个标签在 `en.ts` 中能 grep 到
- [x] 3.2 新增 Web 设置页 `/settings/appearance`（主题与聊天排版，仅存浏览器）与 `/settings/language` 的说明，并把 TUI 语言段落与之合并为一处“Interface language / Appearance”说明。验证：README 提到全部六个 `/settings/*` 路由与 `/about`
- [x] 3.3 Documentation 列表：中文独有的文档标注 “(Chinese only)”；provider 数量与 `MODEL_PROVIDERS` 的数量核对（`credential-providers.ts` 的目录长度），不一致则改正或去掉具体数字，同步到 `docs/README.zh-CN.md`。验证：`rg -c "[一-鿿]" README.md` 仅剩“简体中文”链接文字；数字与代码一致
- [x] 3.4 `docs/README.zh-CN.md` 同步核对：新增的外观 / 语言说明、文档列表（新路径）与 Bun 表述与英文版一致，Web 标签使用中文界面的实际文案（对照 `zh.ts`）。验证：两份 README 的章节与链接一一对应，zh 中的标签均在 `zh.ts` 中能 grep 到

## 4. 其他文档核对与精简

- [x] 4.1 `AGENTS.md` 逐节核对：与当前代码一致（版本、命令、路径、协议号、已拆分的模块），失实或已无对应代码的条目删除或改正；文档位置段补一条“文档目录规则”（引用 `docs/README.md`）。验证：文中出现的文件路径与符号用 `rg`/`ls` 抽查均存在
- [x] 4.2 `apps/mobile/README.md`：“M0 真机验证记录”去掉日期、设备、计数（87 个 / 656 个 / Bun 1.4.2）等易过时数字，保留已验证场景清单；核对“真机回归”里“尚未在真机上执行”类状态语句，不再成立就改正或删除；文内协议文档路径指向 `docs/mobile/api-v1.md`。验证：`rg "656|87 个|Bun 1\.4\.2" apps/mobile/README.md` 无匹配
- [x] 4.3 `docs/mobile/api-v1.md` 与 `docs/releases/README.md` 核对：能力列表、版本号、路径与代码（`protocol.ts`、`release-preflight.ts`）一致。验证：抽查的字段与常量在源码中存在且值相同
- [x] 4.4 扫描其他过时文档：`rg -l "TODO|待补|FIXME" **/*.md`（排除归档、工具技能目录）与根 `test/`、`scripts/` 下是否有无人引用的文件；仅对文档类过时内容动手，源码类可疑文件只在 PR 说明中列出，不在本变更删除。验证：列出检查结果并写入 design.md 末尾“执行记录”

## 5. 收尾验证

- [x] 5.1 全量验证：`bun run check`、`bun run test`、`bun run build:release`、`bun run test:package` 均通过；Dart 注释改动后在 `apps/mobile` 运行 `dart format --set-exit-if-changed .`（若本机有 Flutter）。验证：命令退出码均为 0
- [x] 5.2 最终检查：英文 README 无中文（见 3.3）；`rg "\.github/RELEASING|docs/mobile-api-v1"` 在非归档文件中无匹配；`git status` 只有预期文件；`bun.lock` 差异只含 `@types/bun`/`bun-types`。验证：逐条命令输出符合预期

## Workflow follow-up

- 经用户确认后提交（Conventional 风格，中文描述）；是否推送由用户决定，本变更不发版。
- 归档本变更（`/openspec-archive-change`），`skip_specs` 无需同步 spec。
