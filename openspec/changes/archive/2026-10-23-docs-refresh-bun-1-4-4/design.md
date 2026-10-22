# Design

## Context

动机与范围见 proposal.md。现状要点：

- 文档位置：根 `README.md`（英文）、`docs/README.zh-CN.md`（中文主版本）、`docs/mobile-api-v1.md`、`docs/releases/`、`.github/RELEASING.md`、`apps/mobile/README.md`、`AGENTS.md`。均为中文，除两份 README。引用这些路径的地方：`release.yml` 与 `scripts/release-preflight.ts` 使用 `docs/releases/`；Dart/TS 源码注释引用 `docs/mobile-api-v1.md`；`AGENTS.md`、README、`apps/mobile/README.md` 引用 `.github/RELEASING.md` 与协议文档。
- Web 有 zh/en 两套文案（`packages/web/src/client/lib/i18n/{zh,en}.ts`），设置页路由为 `/settings`（模型服务）、`/settings/search`、`/settings/context`、`/settings/appearance`、`/settings/language`、`/settings/mobile`，另有 `/about`。英文标签以 `en.ts` 为准；语言项标签 `语言 / Language` 是刻意的双语入口。
- Bun：本机与 CI 实际是 1.4.4；`package.json` 的 `engines.bun` 是 `>=1.4.2 <1.5.0`，`packageManager` 与 `.bun-version` 是 1.4.2，`@types/bun` 精确 1.4.2。npm 官方源 `@types/bun` 最新为 1.4.3，`bun-types` 有 1.4.4。
- `bun.lock` 里 `@types/bun` 与 `bun-types` 为 1.4.2，resolved 地址是 `registry.npmmirror.com`。Bun 1.4.4 重新生成会带来格式漂移（见 release-on-tag 的经验），CI 使用 `--frozen-lockfile`。

## Goals / Non-Goals

**Goals:**

- 英文文档不含中文（语言名本身除外），UI 标签与当前 Web 英文界面一致。
- 文档目录有清晰的归属规则与索引，没有指向已删除路径的引用。
- 过时内容删除而不是留着“历史”。
- Bun 声明一致：推荐 1.4.4，1.4.x 可用，全量验证在 1.4.4 通过。

**Non-Goals:**

- 不翻译 `mobile-api` / `releasing` / `AGENTS.md`（开发者内部文档保持中文）。
- 不改 `openspec/`（含归档）、`reference/`、产品内置 `packages/core/skills/*/SKILL.md`、`.agents/ .claude/ .kimi-code/` 下的工具技能文件。
- 不改生产代码行为、不升应用协议、不发版；`release.yml` 不改文件名、`npm` environment 不变。
- 不把 CI 的 Bun 固定到 1.4.4（保持浮动 `1.4.x`，以便及早发现补丁版本回归）。

## Decisions

### D1 文档目录与归属规则

```
README.md                 英文入口（npm / GitHub 要求在根目录）
AGENTS.md                 面向代理与贡献者的架构与约定（中文）
docs/
  README.md               文档索引（标注各文档语言）
  README.zh-CN.md         中文主版本（根 README 链接稳定，不移动）
  dev/releasing.md        发布维护（原 .github/RELEASING.md）
  mobile/api-v1.md        手机 JSON-RPC 协议（原 docs/mobile-api-v1.md）
  releases/               各版本发布说明（release.yml 依赖，原样保留）
apps/mobile/README.md     Flutter 应用自己的构建与说明（包内文档，留在包内）
```

规则：面向用户的入口文档在根与 `docs/`；按主题建子目录（`dev/`、`mobile/`、`releases/`）；包内文档跟随包。备选：保留 `.github/RELEASING.md`（GitHub 不要求该位置，且发布说明已在 `docs/`，分散反而难找）；把 zh-CN README 移入 `docs/zh-CN/`（会改变现有链接，收益小）。迁移用 `git mv` 保留历史。

### D2 英文 README 的 UI 标签

直接写 `en.ts` 中的英文标签，路由仅在需要时以代码形式给出。示例：`Settings → Model services`、`Settings → Web search`、`Settings → Context`、`Settings → Appearance`、`Settings → Language`、`Settings → Mobile pairing`、`About and updates`、`Skill market`、`Plan mode (read-only)`、`Approve and run` / `Request changes` / `Cancel and leave plan mode`、`Steer` / `Withdraw`、`Set as default`。实施时逐个对 `en.ts` 核对，其中任务、待办入口名以 `en.ts` 实际值为准。TUI 的英文文案本来就是英文，不变。去掉“The web UI ships Chinese labels”整句，新增一句说明 Web / TUI / 移动端各自可切换界面语言（Web：Settings → Language；外观：Settings → Appearance，主题与聊天排版）。

备选：保留中文标签并括注英文。放弃：英文用户在英文界面看不到中文，括注反而造成困惑。验收用脚本：英文 README 中除“简体中文”链接文字和语言名外，`[\u4e00-\u9fff]` 无匹配。

### D3 删除过时内容的判据

一段内容满足任一条即删除或改写：描述已被取代的流程（0.1.0 手动首发、Pi 1.2 Windows 延后验证清单）；包含会随版本漂移的具体数字却没有对账来源（“87 个 flutter 测试”“656 个 Bun 测试”“31 个 provider”）；只是第三方模板样板（iOS `LaunchImage.imageset/README.md`）。provider 数量：若保留，必须与 `credential-providers.ts` 的 `MODEL_PROVIDERS` 数量核对（当前以代码为准）；否则改为不写数字。`apps/mobile/README.md` 的“M0 真机验证记录”是一次性历史记录，改为保留“验证覆盖的场景”清单、去掉日期设备与计数；“尚未在真机上执行”这类状态语句核对后更新或删除。归档（`openspec/changes/archive/`）里的验证记录是历史事实，不动；`releasing.md` 不再链接已删除章节所指的归档验证文件。

### D4 Bun 声明

| 位置 | 目标 |
| --- | --- |
| `.bun-version` | `1.4.4` |
| `package.json` `packageManager` | `bun@1.4.4` |
| `package.json` `engines.bun` | `>=1.4.0 <1.5.0` |
| `package.json` `@types/bun` | `1.4.3`（官方最新；类型包版本不必与运行时一致） |
| README / zh-CN / AGENTS | “推荐 Bun 1.4.4，任意 1.4.x 可用” |
| `release.yml` `bun-version` | 保持 `1.4.x` |

`engines` 放宽到 1.4.0 是产品承诺（“任意 1.4.x”）；已实测 1.4.2、1.4.3（0.4.9 流水线）、1.4.4。1.4.0 / 1.4.1 未实测，文档措辞用“推荐 / 可用”而非“已验证”。备选：保持下限 1.4.2——更保守，但与文档“任意 1.4.x”矛盾；用户已选择放宽。

### D5 锁文件

只修改 `bun.lock` 里与 `@types/bun`/`bun-types` 有关的条目（workspace 依赖声明、`@types/bun`、`bun-types` 两行），不整体重生成。resolved 地址与文件现有风格一致（npmmirror），integrity 取自 `npm view @types/bun@1.4.3 dist.integrity --registry=https://registry.npmjs.org`（`bun-types@1.4.3` 同理）；用 `bun install --frozen-lockfile` 验证接受。若 Bun 1.4.4 拒绝手工条目，退而用 `bun install` 重生成后只保留这几处差异，其余格式噪音还原。备选：整体重新生成——噪音大、难审阅。

### D6 引用同步

迁移后用 `rg` 检索 `RELEASING.md`、`mobile-api-v1`（排除 `openspec/changes/archive/`，归档是历史快照）确认没有残留。`docs/README.zh-CN.md` 与 `docs/dev/releasing.md` 内的相对链接按新位置重算。源码注释只改路径文字，不触及逻辑。

## Risks / Trade-offs

- [`engines` 放宽到 1.4.0 后在 1.4.0/1.4.1 上出问题] → 文档不作保证；CI 浮动 `1.4.x` 跟随最新补丁；用户报告后再收紧。
- [手工编辑 `bun.lock` 出错导致 `--frozen-lockfile` 失败] → D5 的验证与回退；改完立即在干净目录验证安装。
- [迁移文件后漏改引用，造成死链] → D6 的检索，必要时对 Markdown 相对链接做一次脚本检查。
- [英文 UI 标签与 `en.ts` 不一致或将来改名] → 本次逐项对账；不为此新增测试（文档不属于类型/测试守护范围）。
- [删除历史验证记录造成信息损失] → 内容仍在 git 历史与 `openspec/changes/archive/` 中。

## Migration Plan

1. 先做 Bun 声明与锁文件，跑 `bun install --frozen-lockfile`、`bun run check` 验证。
2. 文档迁移（`git mv`）与引用同步。
3. 英文 README / 中文 README / AGENTS / mobile README / releasing 内容更新与删除。
4. 全量验证：`bun run check`、`bun run test`、`bun run build:release`、`bun run test:package`，以及英文 README 无中文与死链检查。
5. 回滚：纯文档与版本声明，`git revert` 即可；无需发版。

## 执行记录

- AGENTS.md 核对：「链路协议版本 7」与 Chord 1.3.0 的 `PROTOCOL_VERSION`（4）不符，改为引用 `PROTOCOL_VERSION`；`upgrade-pi-sdk-1-3` 设计路径改指向归档目录；应用协议号（9）、文件路径与符号经 `rg` 抽查均存在。
- `docs/mobile/api-v1.md`：`limits`、`capabilities` 与 `protocol.ts` 常量一致；`docs/releases/README.md` 与 `scripts/release-preflight.ts` 的路径约定一致。
- `apps/mobile/README.md`：「真机回归」里“待办/提问用例尚未在真机上执行”仍成立（归档任务 9.2 未完成），保留。
- 扫描结果（只列出，不在本变更处理）：`scripts/benchmark-workspace-files.ts` 无任何引用；`scripts/mobile-dev-pair.ts` 仅被 `admin.test.ts` 引用。根 `test/`（`faux.ts`、`temp-dir.ts`）被 94 个测试文件使用，保留。Markdown 中没有 TODO / FIXME / 待补。
