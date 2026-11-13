# Spec Delta

## ADDED Requirements

### Requirement: Unix socket 路径过长时的启动失败

在 macOS/Linux 上，Unix socket 路径超过操作系统允许的长度（macOS 103 字节，Linux 107 字节）而无法监听时，网关 SHALL 拒绝启动并给出可操作的说明：包含该路径、实际字节数与上限，并指引改用更短的数据目录或显式指定更短的 socket 路径。网关 MUST NOT 把这种失败报告为地址被占用，也 MUST NOT 悄悄改用其他 socket 路径。

#### Scenario: 数据目录路径过深

- **WHEN** 用户把存储放在很深的目录下，使默认 socket 路径超过系统上限
- **THEN** 网关启动失败并非零退出，错误说明 socket 路径过长，给出路径、字节数与上限，并提示使用 `--storage` 或 `--socket-path` 换成更短的路径

#### Scenario: 路径在上限以内

- **WHEN** socket 路径不超过系统上限
- **THEN** 网关按原有行为启动，其他启动失败（如地址被占用）的提示不变
