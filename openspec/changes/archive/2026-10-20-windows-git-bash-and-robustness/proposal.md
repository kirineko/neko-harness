# Proposal

## Why

Windows 支持落地后（仅 WebSocket 网关、端口文件发现、盘符路径修复），在 Windows 本机实测仍有三类问题：

1. **命令执行可能落进 WSL**：bash 工具、`job` 与子 agent 的命令都经 pi-durable `NodeExecutionEnv` 执行，Windows 上它依次找 `Program Files` 下的 Git Bash，再取 `where bash.exe` 的第一条。上游只把 `System32\bash.exe` 识别为 WSL，常见的 `WindowsApps\bash.exe`（WSL 启动器）会被当成普通 bash，用 `-c` 送进 Linux 执行，路径语义全错。用户级 Git 安装（`%LOCALAPPDATA%\Programs\Git`）与自定义位置又找不到。模型也不知道自己在 Windows 的 Git Bash 里。
2. **测试在 Windows 上失败或挂死**：6 个 gateway 测试稳定失败，`bun run test` 整体卡住。调研确认根因是 Bun 在 Windows 上同一进程内同时充当 WebSocket 服务端与客户端时丢帧或乱序（服务端按序交给 socket 的帧，客户端收到时顺序颠倒或缺失），chord 的序号检查据此正确地断开链路；neko 与 chord 代码无误。测试超时又不取消测试体，`finally` 中的关闭永远不执行，进程无法退出。
3. **若干健壮性问题在 Windows 上更易触发**：rename 覆盖目标遇占用（杀毒、索引器）返回 EPERM/EBUSY 且无重试；技能覆盖安装先删旧目录再 rename，rename 失败则新旧版本都丢失；拉起方停网关用 SIGTERM，在 Windows 上等于 TerminateProcess，网关清理不执行；凭据锁文件在进程崩溃后残留，之后写入永久失败；`~\` 不展开；带 UTF-8 BOM 的 SKILL.md / AGENTS.md 可能解析失败。

## What Changes

- **Windows 命令 shell 固定为 Git Bash**：neko 在 win32 自行探测 Git Bash（配置项 → 标准安装目录 → 由 `git.exe` 推导 → 过滤后的 PATH），始终把结果作为 `shellPath` 显式交给执行环境，覆盖 bash 工具、`job` 与子 agent。WSL 的 `bash.exe`（`System32`、`Sysnative`、`WindowsApps`）一律排除。找不到时网关照常启动、工具集不变，命令调用返回带安装与配置指引的明确错误。neko 在 WSL 内运行（`linux` 平台）及 macOS/Linux 行为不变。
- **新增配置项 `shell.path`**（`neko.config.json`）：显式指定 Windows 上使用的 bash；指向不存在的文件或 WSL bash 时报明确错误，不回退到自动探测。
- **提示词告知 Windows shell 环境**：win32 上 `rules` 节说明命令运行于 Git Bash，路径使用正斜杠或 `/d/...` 形式。
- **网关发布运行环境状态**：`neko.application-info` 状态新增可选 `shell` 字段（仅 Windows），TUI 与 Web 在 Git Bash 缺失时给出提示。可选字段，不提升应用协议版本。
- **Windows 拉起方优雅关停网关**：TUI/Web 在 Windows 上以 stdin 管道拉起网关并传入显式开关，停止时先关闭 stdin（EOF）触发网关的既有清理流程，超时再强制结束。POSIX 停止流程不变。
- **健壮性修复**：rename 遇 EPERM/EBUSY/EACCES 有界重试；技能覆盖安装改为先将旧目录移到备份、再放入新版本，失败时恢复旧版本；凭据锁文件增加过期回收；`/export` 与图片路径支持 `~\`；SKILL.md / AGENTS.md 解析容忍 UTF-8 BOM。
- **测试（Windows）**：gateway 测试的客户端在 Windows 上经 chord `memoryLinkPair` 直接接入进程内网关，绕开 Bun 的同进程 WebSocket 问题；WebSocket 传输由已有的跨进程启动测试覆盖。测试里的网关调用加超时，失败不再挂死整套测试。
- 不变：CI 矩阵（ubuntu/macos，不加 Windows runner）；POSIX 与 WSL 执行路径；Bun 版本（不区分 1.4.2/1.4.3）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runtime`: 新增「Windows 命令执行 shell」需求——Git Bash 探测顺序、WSL 排除、显式配置与缺失时的错误语义，覆盖 bash 工具、`job` 与子 agent。
- `prompt-context`: 新增 Windows 上的 shell 环境说明；新增资源文件（AGENTS.md / SKILL.md）UTF-8 BOM 容错。
- `session-gateway`: 新增「运行环境状态」（`neko.application-info` 可选 `shell` 字段）；新增「Windows 拉起方优雅关停」。
- `skill-market`: 修改「覆盖保护」——覆盖安装失败时 MUST 保留旧版本，不再规定先清除旧目录。
- `model-providers`: 新增「凭据写入健壮性」——锁文件残留可回收、短暂占用不致保存失败。
- `terminal-ui`: 修改 `/export` 路径规则以支持 `~\`；新增 Git Bash 缺失提示。
- `web-ui`: 新增 Git Bash 缺失提示。

## Impact

- **代码**：`packages/core/src/workspace-files.ts`（`env()` 传入 `shellPath`）、新增 core 纯模块（Git Bash 探测）、`packages/core/src/config.ts`（`shell.path`）、`packages/core/src/prompt/`（Windows 规则、BOM）、`packages/core/src/credentials.ts`（锁回收、rename 重试）、`packages/core/src/application-updates.ts`（rename 重试）、`packages/gateway/src/skill-market.ts`（备份式覆盖）、`packages/gateway/src/contract.ts` 与 `server-services.ts`（`shell` 字段）、`packages/gateway/src/main.ts`、`cli-args.ts`、`process.ts`（stdin 关停）、`packages/tui/src/gateway.ts`、`packages/web/src/gateway-spawn.ts`（拉起参数）、TUI/Web 提示 UI、`packages/tui/src/image-input.ts` 与 `export-command.ts`（`~\`）。
- **测试**：`packages/gateway/test/helpers.ts` 新增 Windows 内存链路连接助手，使用 `connectNekoGateway(testAddress(...))` 的测试改用该助手；新增探测、关停、备份覆盖、锁回收、BOM 用例。
- **协议**：应用协议版本不变；`neko.application-info` 增加可选字段，新旧客户端与网关互通。
- **依赖**：无新增；上游 Pi 版本不变。
- **文档**：README 的 Windows 说明补充 Git for Windows 前置条件与 `shell.path`。
