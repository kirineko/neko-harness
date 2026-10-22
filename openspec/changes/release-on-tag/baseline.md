# 演练数据

演练方式：`gh workflow run release.yml --ref ci/release-on-tag`（`workflow_dispatch`，只验证不发布）。Linux 为 `ubuntu-26.04`，CI 上 `oven-sh/setup-bun` 的 `1.4.x` 解析为 Bun 1.4.4。

## 旧流程（v0.4.9 的 Release 运行，串行测试）

| 项 | 耗时 |
| --- | --- |
| verify ubuntu | 182s（`bun run test` 137s） |
| verify macOS | 201s（`bun run test` 144s） |
| android（含 format/analyze/test + 三 ABI 构建） | 482s（`flutter test` 78s、构建 345s） |
| 整条 Release 墙钟 | 约 8 分钟 |
| 另有 | 每次 push 还各跑一遍 CI（ubuntu + macOS）与 Mobile，约 +20 分钟 runner 时间 |

## 新流程（两次连续全绿：39829609103、39830420825）

| job | 运行 1 | 运行 2 |
| --- | --- | --- |
| preflight | 6s | 8s |
| verify ubuntu-26.04 | 102s | 103s |
| verify macOS | 104s | 101s |
| verify Windows | 161s | 124s |
| android-check | 128s | 126s |
| android-build | 296s | 234s |
| 墙钟（含排队） | 约 5 分钟 | 248s |

`bun run test`（并行）：ubuntu 56–57s、macOS 59–61s、Windows 59–75s（本机 12s；GitHub runner 核数更少）。旧串行为 137–144s，约快 2.3 倍。

## 演练中发现并修复的问题

- **Bun 1.4.4**（演练当天发布，CI 的 `1.4.x` 自动用上）：node:http 的 upgrade socket 在对端断开后不再触发 `close`。三个「停滞 HTTP 握手」测试在本机 Bun 1.4.4 上同样复现（1.4.2 通过）；产品代码无误（用 `ws` 直测，客户端 `terminate()` 后 TCP 连接确实释放），改用裸 TCP 服务观察。
- **Windows**：`new URL(...).pathname` 得到 `/D:/...`（两个 i18n 扫描测试）；扫描结果的相对路径含反斜杠；mobile admin 离线状态是异步更新；helper 被杀后需等进程真正退出（`workspace-files`）；`test:package` 的 GNU tar 把 `D:\...` 当成 `host:path`。
- **Linux 负载下偶发**：`neko tui --help` 用例连续拉起十余个进程超过默认 5s；`workspace-files` 刷新扫描遇到 watcher 通知时按设计返回 "Workspace changed… Retry"，测试补上重试。
- **Android**：按 ABI 拆成三个并行 job 没有收益（每个 job 仍要 260–360s，固定开销占大头：Flutter 引擎产物、NDK 28.2 下载、Gradle 依赖），且一次 NDK 下载损坏（`Error reading Zip content`）使 arm64 job 失败。改回单 job，构建步骤最多重试 3 次。
- 全部修复都在测试/脚本一侧，没有改动生产代码。

## 其他确认

- `ubuntu-26.04`：Bun 1.4.4、Flutter 3.47.7、Android 构建、Temurin 17 都正常，无需回退到 `ubuntu-24.04`。
- artifact：`upload-artifact@v7` / `download-artifact@v8` 正常；`npm-package`（1.9 MB）与 `apk`（三个文件 `NekoAI-v0.4.9-{arm64-v8a,armeabi-v7a,x86_64}.apk`，24–31 MB）可下载。
- 注解：已无 Node 20 弃用警告，也无 `ubuntu-latest` 迁移提示；仅剩一条 macOS arm64 排队提示（GitHub 的容量通知）。
- `gh workflow run --ref <分支>` 使用的是分支上的新 workflow 文件（含 `preflight` job）。
- `publish` 与 `github-release` 在演练中被跳过，首次真实运行在下一次发版。
