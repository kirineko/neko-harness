# Tasks

## 1. Windows 测试经内存链路接入（先做，后续各组在 Windows 上的验证依赖它）

- [x] 1.1 在 `packages/gateway/src/client.ts` 抽出 `connectNekoGatewayLink(link, serverId, signal)`，`connectNekoGateway` 改为调用它并从 `index.ts` 导出；验证 `bun test --conditions=neko-source packages/gateway/test/client-session.test.ts packages/gateway/test/protocol-version.test.ts` 通过
- [x] 1.2 在 `packages/gateway/test/helpers.ts` 新增 `connectTestClient(target)`（POSIX 走 `testAddress`，win32 走 `memoryLinkPair` + `gateway.accept`）与统一的测试网关构造函数，并登记网关与客户端；模块级 `afterEach` 以每项 2 秒上限关闭未关闭对象；验证 POSIX 与 Windows 上 `packages/gateway/test/boundary.test.ts` 均通过
- [x] 1.3 将使用 `connectNekoGateway(testAddress(...))` 或直接 `startGateway` 的 gateway/web/tui 测试改用上述助手（含 credentials、queue、default-model、jobs、subagents 的 WS 一侧在 win32 改走内存链路）；验证 Windows 本机逐个运行这 6 个此前失败的文件全部通过且进程正常退出
- [x] 1.4 确认跨进程 WS 覆盖仍在：`packages/tui/test/gateway-startup.test.ts`、`packages/web/test/web-shutdown.test.ts`、`packages/gateway/test/stdin-shutdown.test.ts` 在 Windows 本机通过（`packages/web/test/gateway-startup.test.ts` 本就仅在 POSIX 运行）

## 2. Git Bash 探测与 `shell.path` 配置

- [x] 2.1 在 `packages/core/src/config.ts` 新增 `shell.path`（类型、解析校验、合并），补充 `config.test.ts`：字符串通过、非字符串报 `shell.path` 错误、合并覆盖；验证测试通过
- [x] 2.2 新增 core 纯模块（如 `windows-shell.ts`）实现 `resolveWindowsShell(deps)`：配置 → `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%\Programs` → 由 `where git.exe` 推导 → 过滤 WSL 后的 `where bash.exe`；返回 found/missing 及 searched 列表；验证新单测覆盖 spec 中的标准安装、用户级安装、git 推导、排除 `WindowsApps`/`System32`/`Sysnative`、配置指向 WSL/不存在/目录等场景（依赖注入，任意平台可跑）
- [x] 2.3 实现探测结果缓存（found 每次使用前检查存在，missing 30 秒后重探，`refresh` 强制重探），runtime 暴露 `shellStatus({ refresh })`；验证单测覆盖缓存与刷新

## 3. 命令执行接入

- [x] 3.1 在 `WorkspaceFiles.env()` 的 win32 分支：found 时传 `shellPath`；missing 时改用只覆盖字符串 `exec` 的 `LocalExecutionEnv` 子类，返回 `shell_unavailable` 及英文指引（Git for Windows、`shell.path`、已检查位置、无效配置原因）；POSIX 分支字面不变；验证新单测：缺失时字符串命令返回该错误、argv 命令仍执行
- [x] 3.2 验证 bash 工具、`job start` 与子 agent 在缺失时得到同一错误且会话可继续：新增 runtime 级测试（注入 missing 状态），`job start` 结果为 failed、不产生 running 任务；read/edit 不受影响
- [x] 3.3 Windows 本机手动验证：在本机 Git Bash 下 `bun run neko tui` 执行 `echo $BASH_VERSION && pwd`，确认运行于 Git Bash 而非 WSL

## 4. 提示词与资源解析

- [x] 4.1 在 `packages/core/src/prompt/prompt.ts` 按注入的平台为 bash/job 追加 Windows Git Bash 规则；更新 `prompt-prompt.test.ts`：win32 含该规则、darwin/linux 不含、无命令工具角色不含、相同输入逐字节一致；验证测试通过
- [x] 4.2 `prompt/frontmatter.ts`、AGENTS.md 读取与 `agent-file-search.ts` 去除开头 BOM；在 `prompt-frontmatter.test.ts` / `prompt-resources.test.ts` 加带 BOM 的 SKILL.md 与 AGENTS.md 用例；验证测试通过

## 5. 网关运行环境状态与前端提示

- [x] 5.1 `contract.ts` 的 `ApplicationInfoSchema` 增加可选 `shell` 字段；`server-services.ts` 在 win32 填充、`check()` 刷新并发布变化；验证 gateway 测试：注入 found/missing 时字段正确、非 win32 省略、旧形状的应用信息仍可被客户端解析
- [x] 5.2 TUI：连接后依据 `shell` 缺失显示一次英文警告（同一状态不重复，字段缺失不提示）；验证 TUI 测试覆盖首次提示、重连不重复、非 Windows 不提示
- [x] 5.3 Web：聊天页可关闭的中文提示与「关于与更新」页 shell 状态行；验证 Web 客户端测试覆盖缺失提示、关闭后重连不再出现、状态可用后消失、字段缺失不显示，并通过 `bun run check` 的客户端类型检查
- [x] 5.4 README 的 Windows 说明补充 Git for Windows 前置条件、WSL bash 不受支持与 `shell.path` 示例；验证文档中的配置示例可被 `parseNekoConfig` 接受

## 6. Windows 拉起方优雅关停

- [x] 6.1 `installShutdown` 控制器增加 `trigger(reason)`，复用信号流程；更新 `shutdown.test.ts` 验证首次触发清理、重复触发强退、超时强退
- [x] 6.2 `cli-args.ts` 增加 `--stop-on-stdin` 并写入 `GATEWAY_USAGE`（中文帮助，遵循 cli-interface 约定）；`main.ts` 在该参数下监听 stdin 结束触发清理；验证 `cli-args.test.ts` 与一个子进程测试：关闭 stdin 后网关零退出码退出、端口文件删除；未带参数时关闭 stdin 不退出
- [x] 6.3 `stopGatewayProcess` 增加 `viaStdin` 选项；TUI/Web 在 win32 以 `stdio: ["pipe", ...]` 和 `--stop-on-stdin` 拉起并以 `viaStdin` 停止，POSIX 不变；验证 `tui/test/gateway-startup.test.ts`、`web/test/web-shutdown.test.ts` 在 Windows 与 POSIX 均通过，Windows 上 job 被结算为 stopped/lost 而非遗留 running

## 7. 文件替换健壮性

- [x] 7.1 新增 core `renameWithRetry`（仅 EPERM/EBUSY/EACCES 递增重试，约 1 秒上限）并替换 `credentials.ts`、`application-updates.ts`、`skill-market.ts` 及 `mobile/store.ts` 中未重试的 rename；验证单测：注入短暂失败后成功、持续失败抛错、其他错误不重试
- [x] 7.2 凭据锁超过 30 秒视为残留并回收；更新 `core/test/credentials.test.ts`：过期锁被回收后保存成功、未过期锁不回收并最终报忙、持续占用时原文件不变且无临时文件；验证测试通过
- [x] 7.3 技能覆盖安装改为备份式替换（旧目录 rename 到 `.bak-<uuid>`，成功删除、失败恢复），`sweepTempDirs` 安全处理遗留备份；更新 `gateway/test/skill-market.test.ts`：覆盖成功、放入新版本失败时旧版本完整、遗留备份在目标缺失时被恢复；验证测试通过

## 8. 主目录前缀

- [x] 8.1 `tui/src/image-input.ts` 与 `export-command.ts` 在 win32 识别 `~\` 并用 `join(homedir(), rest)` 拼接，POSIX 不变；更新 `image-input.test.ts`、`export-command.test.ts`（以注入平台覆盖 win32 `~\` 与 POSIX `~/`）；验证测试通过

## 9. 集成验证

- [x] 9.1 Windows 本机运行 `bun run test`：整体跑完不挂起且全部通过（不含既有的平台 skip）
- [x] 9.2 运行 `bun run check` 与 `bun run build`，确认 biome、类型检查与构建通过
- [x] 9.3 Windows 本机端到端：`bun run neko web` 启动后用 bash 工具与 `job` 各执行一次命令，确认在 Git Bash 中运行；临时设置 `shell.path` 指向 WSL bash，确认 Web 出现缺失提示且命令返回配置无效错误；Ctrl+C 退出后端口文件被删除
