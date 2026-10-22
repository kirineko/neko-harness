# Proposal

## Why

文档与实际状态已经脱节：Web 早已支持 English 界面，但英文 `README.md` 仍把中文界面标签当作“Web 显示的文案”直接引用，也没有介绍语言与外观设置；`.github/RELEASING.md` 还保留 0.1.0 首次发布流程和 Pi 1.2 的 Windows 验证清单（项目已在 Pi 1.3 且三平台流水线通过）；`apps/mobile/README.md` 带着已过时的验证计数；文档散落在根目录、`docs/`、`.github/`、`apps/mobile/` 之间，没有索引。

同时开发者本机与 CI 的 Bun 已是 1.4.4（0.5.0 发版即在 1.4.4 上验证），但 `.bun-version`、`packageManager`、`@types/bun` 与各处文档仍写 1.4.2，且 `engines` 下限 `>=1.4.2` 与“任意 1.4.x 可用”的承诺不一致。

## What Changes

- **英文 README**：引用 Web 界面处改用 `en.ts` 里的英文标签（Settings → Model services / Web search / Context / Appearance / Language / Mobile pairing，About and updates，Skill market，Plan mode (read-only)，Approve and run / Request changes / Cancel and leave plan mode，Steer / Withdraw，Set as default 等），去掉“Web 界面是中文、按原样引用”的说明，补充 `/settings/language`、`/settings/appearance` 的说明；英文 README 中除语言名本身外不再出现中文。中文 `docs/README.zh-CN.md` 同步核对（它仍是主版本）。
- **文档目录规整**：
  - `docs/README.md`：新增文档索引（中英链接，注明各文档语言）。
  - `.github/RELEASING.md` → `docs/dev/releasing.md`，删除“首次发布（0.1.0）”整节与“Pi 1.2 升级发版后的 Windows 验证”整节。
  - `docs/mobile-api-v1.md` → `docs/mobile/api-v1.md`。
  - `docs/releases/` 不动（`release.yml` 与 `scripts/release-preflight.ts` 依赖）；`docs/README.zh-CN.md` 保持原位（根 README 与 npm 页面链接稳定）。
  - 同步所有引用：两份 README、`AGENTS.md`、`docs/releases/README.md`、`apps/mobile/README.md`、`apps/mobile/lib/core/api/models.dart`、`apps/mobile/lib/core/rpc/rpc_client.dart`、`packages/gateway/src/mobile/protocol.ts` 的注释。
  - 英文 README 的文档列表里，只有中文的文档标注 “(Chinese only)”。
- **删除/精简过时内容**：`apps/mobile/README.md` 中带旧计数与旧版本的“M0 真机验证记录”改为不含易过时数字的概述（或删除）；iOS `LaunchImage.imageset/README.md`（Xcode 模板自带，无项目信息）删除；README 中 provider 数量等易过时的具体数字改为不写死或与 `credential-providers.ts` 核对；`AGENTS.md`、`apps/mobile/README.md` 逐条核对，不再成立的描述删除或改正。
- **Bun 升到 1.4.4（开发基线）**：`.bun-version`、`packageManager` 改为 1.4.4；`@types/bun` 改为 1.4.3（npm 上 `@types/bun` 最新就是 1.4.3，没有 1.4.4）；`engines.bun` 改为 `>=1.4.0 <1.5.0`；README、`docs/README.zh-CN.md`、`AGENTS.md` 的说法统一为“推荐 Bun 1.4.4，任意 1.4.x 可用”。CI `setup-bun` 保持浮动 `1.4.x`。
- 不改生产代码行为，不升应用协议，**不发版**。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本变更只涉及文档位置与内容、工具链版本声明，不改变任何 spec 级行为（`.openspec.yaml` 设置 `skip_specs: true`）。

## Impact

- 文档：`README.md`、`docs/README.zh-CN.md`、新增 `docs/README.md`、`docs/dev/releasing.md`、`docs/mobile/api-v1.md`、`AGENTS.md`、`docs/releases/README.md`、`apps/mobile/README.md`；删除 `.github/RELEASING.md`、`docs/mobile-api-v1.md`、iOS `LaunchImage.imageset/README.md`。
- 代码注释（仅路径文字）：`models.dart`、`rpc_client.dart`、`protocol.ts`。
- 配置：`.bun-version`、根 `package.json`（`engines`、`packageManager`、`@types/bun`）、`bun.lock` 中 `@types/bun`/`bun-types` 条目的处理（见 design）。
- 风险：`engines` 下限放宽到 1.4.0，但 1.4.0 / 1.4.1 未实测，文档只写“推荐 1.4.4、1.4.x 可用”，不作保证；`release.yml` 里指向 `RELEASING.md` 的注释（若有）与 AGENTS.md 引用需同步，`release.yml` 文件名与 `npm` environment 不变。
