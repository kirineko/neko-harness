# Verification

## 1. 依赖解析比对（任务 1.4）

pnpm 不能导入 `bun.lock`，首次 `pnpm install` 重新解析了传递依赖。比对对象是附录 A 与 `pnpm-lock.yaml` 的 `packages` 段。

- `@earendil-works/*` 七个包、`@earendil-works/pi-telemetry` 以及它们的直接依赖（`@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`@smithy/node-http-handler`、`http-proxy-agent`、`https-proxy-agent`、`openai`、`partial-json`、`@silvia-odwyer/photon`、`diff`、`quickjs-wasi`、`get-east-asian-width`、`marked`、`marked-cjk-friendly`）：**版本无差异**，不需要 `pnpm.overrides`。`@smithy/node-http-handler` 在 pnpm 下多出一个 4.14.2，供 AWS SDK 的传递依赖使用；pi-ai 直接依赖的仍是 4.12.1。
- Bun 解析到而 pnpm 没有的包：无。
- 只在 pnpm 锁文件里出现的 91 个包名都是其他平台的可选二进制（biome、sharp、rolldown、tailwind oxide、lightningcss、typescript 的各平台包）及其 wasm 运行时辅助包，本机不安装。
- 其余 50 个包的版本发生漂移（均为传递依赖，发布包不带锁文件，用户侧本来就由 npm 重新解析）：

| 包 | Bun | pnpm |
|---|---|---|
| `@asamuzakjp/css-color` | 7.1.5 | 7.2.0 |
| `@asamuzakjp/dom-selector` | 10.0.3 | 10.0.5 |
| `@aws-sdk/core` | 3.978.2 | 3.981.0 |
| `@aws-sdk/credential-provider-env` | 3.972.73 | 3.972.84 |
| `@aws-sdk/credential-provider-http` | 3.972.75 | 3.972.86 |
| `@aws-sdk/credential-provider-ini` | 3.973.18 | 3.973.30 |
| `@aws-sdk/credential-provider-login` | 3.972.80 | 3.972.92 |
| `@aws-sdk/credential-provider-node` | 3.972.85 | 3.972.97 |
| `@aws-sdk/credential-provider-process` | 3.972.73 | 3.972.84 |
| `@aws-sdk/credential-provider-sso` | 3.973.17 | 3.973.28 |
| `@aws-sdk/credential-provider-web-identity` | 3.972.79 | 3.972.90 |
| `@aws-sdk/eventstream-handler-node` | 3.972.36 | 3.972.42 |
| `@aws-sdk/middleware-eventstream` | 3.972.31 | 3.972.38 |
| `@aws-sdk/middleware-websocket` | 3.972.55 | 3.972.66 |
| `@aws-sdk/nested-clients` | 3.997.47 | 3.998.3 |
| `@aws-sdk/signature-v4-multi-region` | 3.996.48 | 3.996.52 |
| `@aws-sdk/token-providers` | 3.1127.0, 3.1149.0 | 3.1127.0, 3.1166.0 |
| `@aws-sdk/types` | 3.974.6 | 3.975.1 |
| `@aws-sdk/xml-builder` | 3.972.41 | 3.972.43 |
| `@babel/runtime` | 7.29.10 | 7.29.14 |
| `@csstools/css-color-parser` | 4.2.6 | 4.2.7 |
| `@csstools/css-syntax-patches-for-csstree` | 1.1.15 | 1.1.16 |
| `@jridgewell/resolve-uri` | 3.1.2 | 3.1.3 |
| `@oxc-project/types` | 0.153.0 | 0.156.0 |
| `@rolldown/binding-darwin-arm64` | 1.2.13 | 1.2.19 |
| `@rolldown/pluginutils` | 1.0.1 | 1.1.0 |
| `@smithy/core` | 3.35.2 | 3.40.0 |
| `@smithy/fetch-http-handler` | 5.8.0 | 5.8.1 |
| `@smithy/node-http-handler` | 4.12.1 | 4.12.1, 4.14.2 |
| `@smithy/signature-v4` | 5.7.4 | 5.7.5 |
| `@smithy/types` | 4.19.0 | 4.20.0 |
| `bowser` | 2.14.1 | 2.15.0 |
| `commander` | 15.0.0 | 15.1.0 |
| `enhanced-resolve` | 5.26.0 | 5.27.0 |
| `entities` | 8.1.0 | 9.0.0 |
| `graceful-fs` | 4.2.11 | 4.2.12 |
| `isbot` | 5.2.2 | 5.2.3 |
| `parse5` | 8.0.1 | 8.1.1 |
| `postcss` | 8.5.29 | 8.5.32 |
| `rolldown` | 1.2.13 | 1.2.19 |
| `semver` | 7.8.5 | 7.8.6 |
| `seroval` | 1.6.9 | 1.8.1 |
| `seroval-plugins` | 1.6.9 | 1.8.0 |
| `tabbable` | 6.5.0 | 6.5.1 |
| `tldts` | 7.4.18 | 7.5.1 |
| `tldts-core` | 7.4.18 | 7.5.1 |
| `tough-cookie` | 6.0.2 | 6.1.0 |
| `tslib` | 2.8.1 | 2.9.1 |
| `undici` | 8.12.2 | 8.12.4 |
| `undici-types` | 6.21.0, 8.12.2 | 6.21.0, 8.12.4 |

## 2. Node 源码模式的真实启动（任务 2.2）

macOS arm64，Node 24.15.0，pnpm 布局，入口 `node --conditions=neko-source packages/cli/src/bin.ts`（即 `pnpm neko`），数据目录在 `/tmp` 下。

- `web --no-open`：gateway 子进程同样以 `node --conditions=neko-source …/gateway/src/main.ts` 拉起；`/api/info` 返回 `webVersion: "development"`，首页 200；SIGINT 后 web 与 gateway 都退出，退出码 0，无残留进程。
- `tui`：连接源码模式的 gateway，完成一轮带 bash 工具调用的真实对话（DeepSeek），输出符合预期，无运行时警告。
- 内置技能：源码（`packages/core/src/prompt/resources.ts`）与 `pnpm build` 产物（`packages/core/dist/prompt/resources.js`）解析到同一目录 `packages/core/skills/`，集合同为 `skill-creator`、`skill-finder`。

## 3. 测试迁移（任务 3.x、4.x）

249 个测试文件、1619 个用例，迁移前后数量一致（迁移前 Bun 下同为 1619 通过）。macOS arm64，Node 24.15.0，vitest 5.1.0，`forks` 进程池。

| 命令 | 结果 | 耗时 |
|---|---|---|
| `pnpm test`（三次） | 249 文件 / 1619 用例全部通过 | 13.1 – 13.4 秒 |
| `pnpm test:serial` | 全部通过 | 117 秒 |
| 迁移前 `bun run test` | 全部通过 | 约 9 秒 |

并行耗时在 60 秒以内，没有调整并发。未在 Node 22.19.0 上跑完整测试，也未在 Windows、Linux 上运行（由流水线覆盖）。

### 3.1 机械替换之外的改动（任务 4.5）

因 Node / vitest 与 Bun 行为不同而改的地方，都只动了测试或测试基础设施，没有改产品代码：

- **Unix socket 路径长度**：`vitest.config.ts` 在 POSIX 上把 `TMPDIR` 设为 `/tmp`。macOS 的系统临时目录约 50 字节，在其下起 gateway 会超过 Node 的 103 字节上限（首次运行 cli 测试时即触发 `Unix socket 路径过长`）。
- **浏览器全局**：Node 的 `navigator` 是只有 getter 的访问器，jsdom 测试的 `Object.assign(globalThis, { navigator })` 会抛错；Bun 有 `self` 而 Node 没有，TanStack Router 的浏览器构建会访问它。`test/setup.ts` 把这几个访问器改成可写属性，并提供只在装了 jsdom window 时才有值的 `self`。
- **ES 模块命名导出不能原地 spy**：`vi.spyOn(childProcess, "spawn")`（tui 与 web 的 `gateway-startup.test.ts`）和 `vi.spyOn(React, "useState")`（`tool-card.test.tsx`）在 Node 上报 `Cannot redefine property`。改为 `vi.mock` 把该导出换成默认走原实现的 `vi.fn`。
- **`mock.module`**：web 的 10 个文件、13 处全部是「先替换、再动态 `import()` 被测模块」，改为不提升的 `vi.doMock`，语义不变，断言未改。
- **`Bun.write` 会自动建父目录**：`open-api.test.ts` 补了一次 `mkdir`。
- **子进程里的求值代码**：`credentials.test.ts`、`workspace-files.test.ts` 传给 `node -e` 的代码原先用 `Bun.sleep` / `Bun.write`，并按包名导入 `@neko-harness/core/workspace-files`（严格布局下根目录解析不到），改为 Node 接口与文件 URL 导入。
- **`Bun.gc`**：`test/temp-dir.ts` 在 Windows 上靠回收垃圾释放 SQLite 句柄；vitest 以 `--expose-gc` 启动 worker，改调 `globalThis.gc`。
- **`it(name, fn, { retry })`**：`images.test.ts` 的选项对象在 vitest 里是第二个参数。重试原为规避 Bun 进程内 WS 客户端的偶发问题，予以保留。
- **Bun 专有断言**：`toEndWith`（5 处）、`toBeOneOf`（1 处）改为标准断言；`fetch.preconnect`（Bun 专有属性，2 处测试桩）删除。

改了断言的只有一处：

- `packages/gateway/test/mobile/plan-mode.test.ts`：手机端收到 `plan.changed` 通知后，立刻断言桌面客户端复制视图里的 `plan.mode === "normal"`。两者走不同连接，没有顺序保证；Bun 下恰好总是先到，Node 下稳定地后到（三次运行三次失败）。改为 `eventually` 等待同一个值。产品行为未变。

迁移暴露的真实问题（已修）：

- `packages/core/test/user-questions.test.ts` 有一条 `expect(...).resolves` 没有 `await`，断言可能在测试结束后才完成。Bun 不报，vitest 直接判失败。补上了 `await`。

未发现产品缺陷。源码里针对 Bun 行为的兼容处理（`gateway/src/link.ts` 的文本帧、`gateway/src/mobile/listener.ts` 的 IPv4 映射地址、`core/src/codemode.ts` 的 worker 计数）都保留，只改了注释措辞。

## 4. 打包与脚本（任务 5.x）

- `pnpm build:release`（rolldown 1.2.19）：产物断言通过；`dist/cli.js` 3.2 MB、`dist/gateway-main.js` 1.2 MB（`Bun.build` 时为 1.8 MB / 1.1 MB；体积变大的原因没有查）。外部导入只有根 `dependencies` 里的包与 Node 内置模块。
- `pnpm test:package`：`pnpm pack` 的 tarball 为 73 个文件，与迁移前一致，`dependencies` 里没有 `@neko-harness/*`；npm 安装无 `ERESOLVE`；Node 24.15.0 与 22.19.0 上均通过（22.19.0 时脚本本身也由该版本直接运行）。
- `node scripts/release-preflight.ts`：演练、匹配的 tag、不匹配的 tag 三种输入的判定与迁移前相同。
- 根 `package.json` 没有按设计用 import attributes 导入，而是经 `scripts/manifest.ts` 从磁盘读取，原因见 design D8。

## 5. 集成验证（任务 8.1）

把已跟踪与未跟踪的文件复制到 `/private/tmp` 下的新目录（无 `node_modules`、无任何 `dist`），在 `PATH` 最前面放了一个被调用就记录并失败的假 `bun`：

`pnpm install --frozen-lockfile` → `pnpm build` → `pnpm check` → `pnpm test`（249 / 1619 通过，14.1 秒）→ `pnpm build:release` → `pnpm test:package`，全部通过，假 `bun` 从未被调用。

与任务描述的顺序有一处不同：`pnpm check` 必须在 `pnpm build` 之后。Web 客户端的类型检查（`tsconfig.client.json`）读取各包构建出的类型，干净检出直接 `pnpm check` 会报找不到 `@neko-harness/core`。这是迁移前就有的顺序依赖（流水线一直是先构建再检查），已写进 AGENTS.md。

另外，在 `/tmp/...`（符号链接路径）下运行 `tsc` 会把同一个类经两条路径解析成两个类型而报错；在真实路径 `/private/tmp/...` 下没有这个问题，与工具链无关。

未完成：任务 6.1 的流水线演练需要推送分支，Windows 与 Linux 上的结果待演练确认。

## 附录 A：迁移前 Bun 解析的依赖（`bun pm ls --all`，218 项）

```text
@anthropic-ai/sdk@0.129.0
@asamuzakjp/css-color@7.1.5
@asamuzakjp/dom-selector@10.0.3
@aws-sdk/client-bedrock-runtime@3.1127.0
@aws-sdk/core@3.978.2
@aws-sdk/credential-provider-env@3.972.73
@aws-sdk/credential-provider-http@3.972.75
@aws-sdk/credential-provider-ini@3.973.18
@aws-sdk/credential-provider-login@3.972.80
@aws-sdk/credential-provider-node@3.972.85
@aws-sdk/credential-provider-process@3.972.73
@aws-sdk/credential-provider-sso@3.973.17
@aws-sdk/credential-provider-web-identity@3.972.79
@aws-sdk/eventstream-handler-node@3.972.36
@aws-sdk/middleware-eventstream@3.972.31
@aws-sdk/middleware-websocket@3.972.55
@aws-sdk/nested-clients@3.997.47
@aws-sdk/signature-v4-multi-region@3.996.48
@aws-sdk/token-providers@3.1127.0
@aws-sdk/token-providers@3.1149.0
@aws-sdk/types@3.974.6
@aws-sdk/xml-builder@3.972.41
@aws/lambda-invoke-store@0.3.0
@babel/runtime@7.29.10
@biomejs/biome@2.3.5
@biomejs/cli-darwin-arm64@2.3.5
@bramus/specificity@2.4.3
@csstools/color-helpers@6.1.2
@csstools/css-calc@3.4.3
@csstools/css-color-parser@4.2.6
@csstools/css-parser-algorithms@4.0.2
@csstools/css-syntax-patches-for-csstree@1.1.15
@csstools/css-tokenizer@4.0.2
@earendil-works/chord@1.5.0
@earendil-works/pi-ai@1.5.0
@earendil-works/pi-codemode@1.5.0
@earendil-works/pi-durable@1.5.0
@earendil-works/pi-env@1.5.0
@earendil-works/pi-schema@1.5.0
@earendil-works/pi-telemetry@1.5.0
@earendil-works/pi-tui@1.5.0
@exodus/bytes@1.16.0
@floating-ui/core@1.8.0
@floating-ui/dom@1.8.0
@floating-ui/react-dom@2.1.9
@floating-ui/react@0.27.20
@floating-ui/utils@0.2.12
@google/genai@2.21.0
@img/colour@1.1.0
@img/sharp-darwin-arm64@0.35.5
@img/sharp-libvips-darwin-arm64@1.3.4
@jridgewell/gen-mapping@0.3.13
@jridgewell/remapping@2.3.5
@jridgewell/resolve-uri@3.1.2
@jridgewell/sourcemap-codec@1.6.0
@jridgewell/trace-mapping@0.3.31
@neko-harness/cli@workspace:packages/cli
@neko-harness/core@workspace:packages/core
@neko-harness/gateway@workspace:packages/gateway
@neko-harness/tui@workspace:packages/tui
@neko-harness/web@workspace:packages/web
@oxc-project/types@0.153.0
@protobufjs/aspromise@1.1.2
@protobufjs/base64@1.1.2
@protobufjs/codegen@2.0.5
@protobufjs/eventemitter@1.1.1
@protobufjs/fetch@1.1.1
@protobufjs/float@1.0.2
@protobufjs/path@1.1.2
@protobufjs/pool@1.1.0
@protobufjs/utf8@1.1.2
@rolldown/binding-darwin-arm64@1.2.13
@rolldown/pluginutils@1.0.1
@silvia-odwyer/photon@0.3.3
@smithy/core@3.35.2
@smithy/credential-provider-imds@4.5.2
@smithy/fetch-http-handler@5.8.0
@smithy/node-http-handler@4.12.1
@smithy/signature-v4@5.7.4
@smithy/types@4.19.0
@stablelib/base64@1.0.1
@tailwindcss/node@4.3.3
@tailwindcss/oxide-darwin-arm64@4.3.3
@tailwindcss/oxide@4.3.3
@tailwindcss/vite@4.3.3
@tanstack/history@1.162.5
@tanstack/react-router@1.170.42
@tanstack/react-store@0.11.2
@tanstack/router-core@1.171.35
@tanstack/store@0.11.2
@types/bun@1.4.3
@types/jsdom@30.0.0
@types/node-forge@1.3.14
@types/node@22.20.5
@types/react-dom@19.3.0
@types/react@19.3.0
@types/retry@0.12.0
@types/tough-cookie@4.0.5
@types/trusted-types@2.0.7
@types/ws@8.18.2
@typescript/typescript-darwin-arm64@7.0.2
@vitejs/plugin-react@6.1.2
agent-base@7.1.4
agent-base@9.0.0
base64-js@1.5.1
bidi-js@1.1.0
bignumber.js@9.3.1
bowser@2.14.1
buffer-equal-constant-time@1.0.1
bun-types@1.4.3
commander@15.0.0
cookie-es@3.1.1
css-tree@3.2.1
csstype@3.2.3
data-uri-to-buffer@4.0.1
data-urls@8.0.0
debug@4.4.3
decimal.js@10.6.0
detect-libc@2.1.2
diff@8.0.4
dompurify@3.4.16
ecdsa-sig-formatter@1.0.11
enhanced-resolve@5.26.0
entities@8.1.0
extend@3.0.2
fast-sha256@1.3.0
fdir@6.5.0
fetch-blob@3.2.0
fflate@0.8.3
formdata-polyfill@4.0.10
fsevents@2.3.3
gaxios@7.3.1
gcp-metadata@8.1.2
get-east-asian-width@1.6.0
google-auth-library@10.9.1
google-logging-utils@1.1.3
graceful-fs@4.2.11
highlight.js@11.12.0
html-encoding-sniffer@7.0.0
http-proxy-agent@9.1.0
https-proxy-agent@7.0.6
https-proxy-agent@9.1.0
is-potential-custom-element-name@1.0.1
isbot@5.2.2
jiti@2.7.0
jsdom@30.1.3
json-bigint@1.0.0
json-schema-to-ts@3.1.1
jwa@2.0.1
jws@4.0.1
katex@0.19.0
lightningcss-darwin-arm64@1.32.0
lightningcss-darwin-arm64@1.33.0
lightningcss@1.32.0
lightningcss@1.33.0
long@5.3.2
lru-cache@11.5.3
magic-string@0.30.21
marked-cjk-friendly@0.1.2
marked@18.0.11
marked@18.1.0
mdn-data@2.27.1
ms@2.1.3
nanoid@3.3.20
node-domexception@1.0.0
node-fetch@3.3.2
node-forge@1.4.0
openai@7.19.0
p-retry@4.6.2
parse5@8.0.1
partial-json@0.1.7
picocolors@1.1.1
picomatch@4.0.7
postcss@8.5.29
protobufjs@7.6.6
proxy-agent-negotiate@1.1.0
punycode@2.3.1
qrcode-generator@2.0.4
quickjs-wasi@3.6.2
react-dom@19.3.0
react@19.3.0
require-from-string@2.0.2
retry@0.13.1
rolldown@1.2.13
safe-buffer@5.2.1
saxes@6.0.0
scheduler@0.28.0
semver@7.8.5
seroval-plugins@1.6.9
seroval@1.6.9
sharp@0.35.5
source-map-js@1.2.2
standardwebhooks@1.1.1
tabbable@6.5.0
tailwindcss@4.3.3
tapable@2.3.3
tinyglobby@0.2.17
tldts-core@7.4.18
tldts@7.4.18
tough-cookie@6.0.2
tr46@7.0.0
ts-algebra@2.0.0
tslib@2.8.1
typescript@7.0.2
undici-types@6.21.0
undici-types@8.12.2
undici@8.12.2
use-sync-external-store@1.7.0
vite@8.3.4
w3c-xmlserializer@6.0.0
web-streams-polyfill@3.3.3
webidl-conversions@8.0.1
whatwg-mimetype@5.0.0
whatwg-url@17.3.0
ws@8.21.0
xml-name-validator@5.0.0
xmlchars@2.2.0
yaml@2.9.1
```
