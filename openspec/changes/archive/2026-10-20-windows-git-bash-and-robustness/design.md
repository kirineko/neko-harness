# Design

## Context

动机见 proposal.md（Why）。与方案直接相关的现状：

- **命令执行的唯一入口**：bash 工具（`packages/core/src/runtime.ts:613`）、`job`（`job-engine.ts:256`）与子 agent（`subagents.ts:331`）都经 `WorkspaceFiles.env(cwd)`（`workspace-files.ts:117`）取得 pi-env 的 `LocalExecutionEnv`。它继承 pi-durable 的 `NodeExecutionEnv`，构造参数原样透传，支持 `shellPath`。字符串命令由 `getShellConfig(shellPath)` 决定 shell：有 `shellPath` 时只检查文件是否存在，否则在 win32 上按 `Program Files` 下的 Git Bash、`where bash.exe` 第一条的顺序查找，只把 `System32\bash.exe` 当作 WSL。neko 目前不传 `shellPath`。
- **应用信息**：`neko.application-info` 是稳定的引导契约（`contract.ts:874-890`），状态 `info` 由 `server-services.ts:76` 提供，`check()` 会重新计算。TypeBox 对象默认允许额外字段，加可选字段对旧客户端无害。
- **网关停止**：TUI/Web 以 `stdio: ["ignore", "pipe", "pipe"]` 拉起网关（`tui/src/gateway.ts:121`、`web/src/gateway-spawn.ts:177`），`stopGatewayProcess`（`gateway/src/process.ts:29`）先发 SIGTERM，3 秒后 SIGKILL。Windows 上 SIGTERM 即 TerminateProcess，网关 `installShutdown`（`shutdown.ts`）的清理不会执行。
- **测试**：Windows 上测试网关以 WS-only 启动（`gateway/test/helpers.ts`），测试客户端经 `connectNekoGateway(testAddress(...))` 连接。`NekoGateway` 原无公开接入方法，本变更新增 `accept(link: Link): void`（与监听器共用同一接入逻辑），测试用 chord `memoryLinkPair` 接入。Bun 同进程 WebSocket 丢帧的证据见 proposal。

## Goals / Non-Goals

**Goals:**

- Windows 上命令只会进入 Git Bash 或明确失败，绝不进入 WSL。
- 所有 Windows 行为收在 `process.platform === "win32"` 分支内；macOS、Linux 与 WSL 内运行的执行路径字面不变。
- Windows 本机 `bun run test` 可完整跑完并通过。

**Non-Goals:**

- 不提供 PowerShell 或 cmd 作为命令 shell，不改 bash 工具与 `job` 的语义。
- 不修 Bun 本身，不改上游 Pi 代码与版本；不加 Windows CI。
- 不改变网关传输选择（Windows 仍仅 WS），不做命名管道。
- 不改 POSIX 的网关停止方式与孤儿网关语义。

## Decisions

### D1: Git Bash 探测放在 core 纯模块，由 neko 始终显式传 `shellPath`

新增 core 纯模块（如 `packages/core/src/windows-shell.ts`），导出 `resolveWindowsShell(deps)`，依赖（环境变量、文件存在检查、执行 `where`）全部注入，便于在任何平台单测。探测顺序见 `specs/agent-runtime`。要点：

- WSL 判定：路径规范化为小写反斜杠后，匹配 `\windows\system32\bash.exe`、`\windows\sysnative\bash.exe`，以及 `\microsoft\windowsapps\` 下的 `bash.exe`。
- 由 `git.exe` 推导：`where git.exe` 的每条结果若位于 `<root>\cmd\` 或 `<root>\bin\`，或位于 `<root>\mingw64\bin\`，取 `<root>\bin\bash.exe`。
- `where bash.exe` 取全部结果，过滤 WSL 后取第一条存在的文件，而不是上游的「第一条」。
- 结果类型：`{ kind: "found", path, source: "config" | "auto" } | { kind: "missing", reason: "not_found" | "invalid_config", detail, searched: string[] }`。

`WorkspaceFiles.env()` 在 win32 上：`found` 时把 `path` 作为 `shellPath` 传给 `LocalExecutionEnv`；`missing` 时仍需阻止上游自行回退到 `where bash.exe`，因此不能省略 `shellPath`（见 D2）。

替代方案：给上游提 PR 修 WSL 判定。上游修复后 neko 仍需支持用户级安装与 `shell.path`，且按 AGENTS.md 不裹上游代码，自行探测更可控。

### D2: 缺失时用 core 的薄子类返回 neko 自己的错误

`missing` 时创建 `LocalExecutionEnv` 的子类实例（如 `NekoLocalEnv`），只覆盖 `exec`：命令是字符串时直接返回 `err(new ExecutionError("shell_unavailable", message))`（`ExecutionError`、`err` 来自 `@earendil-works/pi-durable/env`）；argv 数组形式不经 shell，仍交给父类执行。`message` 为英文，包含：需要 Git for Windows 及下载地址、可在 `neko.config.json` 设置 `shell.path`、已检查的位置；`invalid_config` 时说明配置的路径与原因（不存在、不是文件、是 WSL bash）。

这样 bash 工具、`job start`、子 agent 自然得到同一个错误；job 在启动阶段失败，按既有规则记为 failed 而不是 running（与 `background-jobs` 现有「启动失败」语义一致）。

替代方案：传一个不存在的 `shellPath` 让上游报「Custom shell path not found」。信息误导且无指引，放弃。

### D3: 探测结果缓存与刷新

`env()` 调用频繁，不能每次都 spawn `where`。在 `WorkspaceFiles`（或 runtime 持有的单例）中缓存：

- `found`：缓存路径；每次使用前只做一次廉价的存在检查，文件消失则重新探测。
- `missing`：缓存结果，但距上次探测超过 30 秒后的下一次 `env()` 重新探测，使用户装好 Git 后无需重启网关即可恢复。
- runtime 暴露 `shellStatus({ refresh })`，供网关应用信息使用；`check()` 以 `refresh: true` 强制重新探测。

### D4: `shell.path` 配置

`NekoConfig` 新增 `shell?: { path?: string }`，`parseNekoConfig` 校验 `shell` 为对象、`shell.path` 为字符串，否则报 `neko config: <source>: "shell.path" must be a string.`；与其他嵌套配置一样参与 `mergeNekoConfig`。配置经 runtime 选项传入探测（`options.shellPath` 由 gateway 从配置填入）。非 win32 不读取该值。

### D5: 应用信息的可选 `shell` 字段

`ApplicationInfoSchema` 增加 `shell: Type.Optional(...)`：`{ status: "ready", path, source } | { status: "missing", reason }`。只在 win32 网关填充。`server-services.ts` 在构造 `info` 时读取 `runtime.shellStatus()`，`check()` 中先刷新再返回；状态变化时与更新状态一样 `replace` 发布。路径属于本机信息，应用信息只发给本地已认证主体（与现有服务相同），移动端 API 不暴露该字段。客户端：`client-session.ts` 的应用信息类型带上可选字段，TUI/Web 依据它显示提示（`specs/terminal-ui`、`specs/web-ui`）。不提升应用协议版本，延续现有可选扩展的做法。

### D6: 提示词中的 Windows 说明

`packages/core/src/prompt/prompt.ts` 的工具规则表中，bash（及 job）规则在 win32 时追加一条固定英文规则，例如：`On Windows, commands run in Git Bash (not PowerShell, cmd or WSL); write paths with forward slashes, e.g. D:/code or /d/code.` 平台通过参数注入（默认 `process.platform`），以便测试两种平台并保持渲染确定性。全局去重规则照旧。

### D7: Windows 网关的 stdin 关停

- `cli-args.ts` 新增 `--stop-on-stdin`（布尔）。`main.ts` 在该参数存在时监听 `process.stdin` 的 `end`/`close`，触发与终止信号相同的清理。为此 `installShutdown` 返回的控制器增加 `trigger(reason)`，内部复用 `onSignal` 的流程（首个触发清理，超时强退，重复触发强退）。
- TUI/Web 在 win32 拉起时：`stdio: ["pipe", "pipe", "pipe"]` 并追加 `--stop-on-stdin`；POSIX 参数与 stdio 不变。
- `stopGatewayProcess` 增加选项 `{ viaStdin: true }`：先 `child.stdin.end()`，等待退出（沿用 3 秒），超时 `child.kill()`（Windows 上即强制结束），再等待短暂时限；win32 调用方传入该选项。调用方在停止后照旧补删端口文件（已有逻辑）。

替代方案：在 chord 协议上加「关停」RPC——任何本地客户端都能停掉共享网关，需要额外的鉴权语义；IPC 通道（`stdio: "ipc"`）在 Bun 与 Node 间行为不一致。stdin 只有拉起方持有，最简单。

### D8: 原子替换与重试

- 新增 core 工具函数 `renameWithRetry(from, to)`：仅在 `EPERM`、`EBUSY`、`EACCES` 时重试，间隔递增（如 10ms 起，总时长约 1 秒），其他错误立即抛出。所有平台都使用它（POSIX 上这些错误本就不出现于正常 rename，行为不变）。用于 `credentials.ts`、`application-updates.ts`、`skill-market.ts`，以及 `gateway/src/mobile/store.ts` 中未经重试的 rename（核实后替换）。
- **凭据锁回收**：获取锁遇 `EEXIST` 时读取锁文件 `mtime`，超过 30 秒视为残留，删除后重试一次获取；正常持锁期间不刷新 mtime（一次写入远小于 30 秒）。等待上限维持现状（约 2.5 秒）。
- **技能备份式覆盖**：放入新版本前，把已存在的目标目录 rename 到同级 `.bak-<uuid>`；新版本 `renameWithRetry(temp, target)` 成功后删除备份；失败时把备份 rename 回 target 并抛错。`sweepTempDirs` 同时清理遗留的 `.bak-*`（仅在目标存在时，避免误删唯一副本：目标缺失而有 `.bak-*` 时先恢复）。

### D9: `~\` 与 BOM

- `image-input.ts`、`export-command.ts` 的主目录展开改为：win32 上同时识别 `~\` 与 `~/`，用 `join(homedir(), rest)` 拼接；POSIX 仅 `~/`，行为不变。
- `prompt/frontmatter.ts` 与 AGENTS.md 读取在解析前去掉开头的 `\uFEFF`。`agent-file-search.ts` 的行切分同样去除 BOM。

### D10: Windows 测试经内存链路接入

- `gateway/src/client.ts` 抽出 `connectNekoGatewayLink(link, serverId, signal)`（`connectNekoGateway` 改为调用它），从 `index.ts` 导出。
- `gateway/test/helpers.ts` 新增 `connectTestClient(target)`：POSIX 仍走 `connectNekoGateway(testAddress(...))`；win32 创建 `memoryLinkPair()`，`gateway.accept(serverEnd)`，再 `connectNekoGatewayLink(clientEnd, serverId)`。使用 `connectNekoGateway(testAddress(...))` 的测试改用该助手；直接调用 `startGateway` 的测试改用 helpers 中的统一构造函数，以便登记。
- 显式验证 WS 的用例（如 credentials 的「Unix 与 WebSocket 共享」）在 win32 上把 WS 那一侧也改为内存链路，WS 本身由跨进程测试覆盖：`tui/test/gateway-startup.test.ts`、`web/test/gateway-startup.test.ts`、`web/test/web-shutdown.test.ts`、`scripts/test-package.ts`。
- **防挂死**：helpers 登记每个测试创建的网关与客户端，模块级 `afterEach` 有界关闭仍未关闭的对象（每个关闭操作限时 2 秒）。Bun 的测试超时不取消测试体，但会运行 `afterEach`，从而释放 WS 服务，保证进程能退出。

## Risks / Trade-offs

- [Windows 上 gateway 测试不再经过真实 WS] → 跨进程启动测试与 `test:package` 冒烟仍覆盖 WS；产品中网关总在独立进程，正好落在已验证的路径上。若日后发现跨进程也丢帧，需单独处理。
- [`where git.exe` 推导出错误的 bash（如第三方工具自带的 git）] → 推导只接受 `<root>\bin\bash.exe` 存在的情况；用户可用 `shell.path` 覆盖。
- [Git Bash 中模型写出 Windows 反斜杠路径] → 提示词规则说明；Git Bash 本身也接受 `D:/...`。
- [stdin 关停使拉起方崩溃时网关随之退出] → 仅 Windows 且由拉起方显式启用；与「拉起方正常退出时关停自己拉起的网关」一致，Web 已接入该网关时由 Web 的重连与重新拉起流程处理。
- [锁回收误删仍在使用的锁] → 30 秒远大于一次写入（毫秒级）；极端卡顿时最坏结果是两次写入交错，单次写入仍为整文件原子替换，不会产生半写文件。
- [备份目录在进程崩溃时遗留] → 下次安装或清理时恢复/清除，见 D8。
- [Windows 探测在每次缺失后 30 秒才重试] → 用户可在 Web「关于与更新」页手动检查立即刷新。

## Migration Plan

无数据迁移。新配置项可选；旧网关/旧客户端互通（可选字段）。回滚只需还原代码，凭据、技能目录与存储格式均不变。

## Open Questions

- Git Bash 缺失提示在 Web 上的具体位置（聊天页横幅或输入卡片上方提示条）在实现时按现有提示组件就近选择，不影响规格。
