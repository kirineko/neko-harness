# Spec Delta

## MODIFIED Requirements

### Requirement: 用户执行 CLI 升级

在 macOS/Linux 上，`neko update` SHALL 检查并升级当前受支持的 npm 全局安装，成功后验证实际安装版本，再输出新版本和重新启动提示。已最新 SHALL 成功退出且不执行安装；查询、安装或验证失败 SHALL 非零退出。命令 MUST NOT 自动停止、重启 gateway 或界面，也 MUST NOT 修改会话和凭据。

#### Scenario: 正常升级
- **WHEN** 用户在受支持的安装中执行命令，稳定渠道有较新版本且安装验证成功
- **THEN** 输出已升级版本和重新启动 neko 的简短说明，不把仍运行的旧进程视为已重启

#### Scenario: 安装失败或验证不一致
- **WHEN** 安装命令失败，或退出成功但实际安装版本未达到目标
- **THEN** 返回失败和简短恢复操作，不输出升级成功，不承诺自动回滚安装文件

#### Scenario: 全局安装目录不可写
- **WHEN** 当前用户对 npm 全局安装目录没有写权限
- **THEN** 返回失败并给出手动命令 `npm install -g neko-harness@latest`，不自行提升权限，不输出升级成功

#### Scenario: 不受支持的安装
- **WHEN** macOS/Linux 上命令运行于源码、项目局部安装、链接安装、Bun 或其他包管理器的全局安装，或无法确认的安装位置
- **THEN** 不隐式新增或修改另一份全局安装；说明当前方式不支持自升级，并指引按原安装方式更新或改用 `npm install -g neko-harness` 安装

#### Scenario: 并发升级
- **WHEN** 同一安装已存在进行中的升级命令
- **THEN** 第二个命令不重复安装，简短提示稍后重试，结束或失败后释放升级占用

#### Scenario: Windows 手动升级指引
- **WHEN** 用户在 Windows 执行有效的 `neko update`
- **THEN** 输出先退出 neko、运行 `npm install -g neko-harness@latest` 并重新启动的简短指引，正常退出；不声称已升级或已最新，不进行安装识别、联网检查、升级占用或包安装，也不修改会话及凭据

#### Scenario: Windows 帮助和参数
- **WHEN** Windows 用户请求 `neko update --help` 或提供无效参数
- **THEN** 帮助说明手动更新命令；无效参数仍按用法错误非零退出，不输出升级成功
