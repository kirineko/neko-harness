# Spec Delta

## ADDED Requirements

### Requirement: Web 设置菜单包含语言

Web 设置区侧栏菜单 SHALL 在「外观」之后、「手机配对」之前提供「语言 / Language」菜单项，指向 `/settings/language`，当前页高亮并带 `aria-current`。语言页的外壳、返回聊天入口与窄屏横排行为 SHALL 与其他设置页一致，页面提供「中文」与「English」两个互斥选项，当前语言处于选中状态且可由键盘操作。语言偏好的保存与应用见 `ui-language` 能力。

#### Scenario: 进入语言页

- **WHEN** 用户在设置页点击「语言 / Language」
- **THEN** 路径变为 `/settings/language`，菜单项高亮，页面显示「中文」与「English」两个选项，当前语言被选中

#### Scenario: 窄屏菜单

- **WHEN** 视口为移动宽度
- **THEN** 设置菜单顶部横排，「语言 / Language」可点且不遮挡其他菜单项

#### Scenario: 键盘切换

- **WHEN** 用户用键盘在两个选项间移动并确认
- **THEN** 语言切换生效，焦点保持在所选项上

## MODIFIED Requirements

### Requirement: Web 升级感知与操作提示

Web SHALL 按当前界面语言以简洁文案提示可安装更新、旧 gateway、旧静态服务和旧页面，并在设置中心以专用图标（非 store 图标）提供「关于与更新」子菜单入口。关于页面 SHALL 采用卡片化布局，默认单行呈现主要运行版本与当前生效状态，仅在检测到更新或组件未重启时呈现对应版本与行动提示。可安装更新 SHALL 提供复制 `neko update` 的操作；仅页面旧时 SHALL 提供手动刷新。Web MUST NOT 执行安装或重启服务，不自动刷新，不将提示发送给模型或反复弹窗。

#### Scenario: 可安装更新
- **WHEN** 后台确认较新稳定版本尚未安装
- **THEN** 界面语言为中文时显示“发现新版本，运行 neko update”，为英文时显示等价英文提示，均含复制命令入口；远程浏览器明确在运行 neko 的电脑上执行

#### Scenario: 旧网关或旧静态服务
- **WHEN** 安装已更新，但 gateway 或提供页面的静态服务仍旧
- **THEN** 界面语言为中文时显示“已升级，请重新启动本地 neko”，为英文时显示等价英文提示，详情指引关闭同一网关的 TUI/Web 或独立 serve 后再启动，不将刷新页面作为充分解决操作

#### Scenario: 仅页面旧
- **WHEN** gateway 和静态服务已更新，当前页面仍旧且协议兼容
- **THEN** 界面语言为中文时显示“页面已更新，刷新即可”，为英文时显示等价英文提示，均含刷新入口，持续运行的页面通过检查获知变化，不依赖用户先刷新才发现更新

#### Scenario: 无法检查与关于页面
- **WHEN** 用户打开关于与更新页面，更新来源不可达或安装信息未知
- **THEN** 显示真实的组件版本与未知状态；主动检查失败时给出重试入口，聊天中的后台失败不持续打扰

#### Scenario: 状态驱动与版本卡片
- **WHEN** 用户进入关于与更新页面查看版本
- **THEN** 页面在卡片内以单行主要版本展示当前状态，无新版本时不展示冗余的 npm 最新版及内部多重已安装项，升级说明精炼呈现

### Requirement: Web Git Bash 缺失提示

Web 连接的网关在应用信息中报告 Windows shell 缺失时，Web SHALL 在聊天页以按当前界面语言的简洁非阻断提示说明命令与后台任务不可用，并给出下一步：安装 Git for Windows 后重新检查，或在配置文件中设置 `shell.path`；配置无效时 SHALL 说明配置路径的问题。提示 SHALL 可关闭，关闭后同一缺失状态在本页面会话内 MUST NOT 再次出现；状态变为可用后提示 SHALL 消失。设置中的「关于与更新」页 SHALL 显示当前 shell 状态（可用时显示 bash 路径）。网关未提供该字段时 MUST NOT 显示提示或 shell 状态行，提示 MUST NOT 影响输入、发送与其他面板。

#### Scenario: 缺少 Git Bash

- **WHEN** Windows 网关报告 shell 缺失，用户打开聊天页
- **THEN** 页面按当前界面语言显示提示（默认中文），含安装 Git for Windows 与 `shell.path` 的指引，输入框可正常使用

#### Scenario: 关闭后不再出现

- **WHEN** 用户关闭该提示，随后 WebSocket 重连且状态仍为缺失
- **THEN** 提示不再出现

#### Scenario: 安装后恢复

- **WHEN** 用户安装 Git for Windows 后在「关于与更新」页触发检查
- **THEN** shell 状态显示为可用及 bash 路径，聊天页提示消失

#### Scenario: 非 Windows 或旧网关

- **WHEN** Web 连接 Linux 网关或不含该字段的旧网关
- **THEN** 不显示提示，「关于与更新」页不显示 shell 状态行
