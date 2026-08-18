# Agent Note：为 Desktop 插件提供内置 pnpm

[English](2026-08-15-desktop-bundled-pnpm-runtime.md) | 中文

## 问题

DSH Desktop 会打包 pnpm，使生成的 DSH 终端无需系统 Node.js 安装即可管理 profile 插件。该终端拥有只属于其子进程的 `PATH`，因此 Cordis Host 插件与当前 desktop generation 启动的 subprocess 无法发现内置 package manager。调用 `pnpm` 的插件会在终端与应用运行时表现不一致。

解决方案不能把 Electron Node 模式放入 Host 环境。`ELECTRON_RUN_AS_NODE` 会改变 Electron executable 的启动方式；若被继承，可能破坏无关的 Electron 子进程。把终端的完整命令目录暴露出去还会让所有插件进程中的用户 `node` 与 `dsh` 命令被覆盖。

## 决策

在已打包的 macOS 与 Linux 启动中，Launcher 会先以 interactive login 模式运行账户配置中使用绝对路径的 `zsh`、`bash` 或 `fish`。它会恢复最终导出的 `PATH`，并且只从固定 allowlist 补充当前启动环境缺失的 locale、工具链、package manager 与虚拟环境值。捕获输入与输出会复用上游 subprocess scrub；除 `PATH` 外，显式启动值仍具有更高优先级。不受支持的 shell，以及失败、超大、格式错误或超时的捕获都会保留原有继承环境。

随后，Launcher 会获取 layered launch-environment snapshot，在 Electron user data 下生成私有 runtime-command 目录，并在 profile 准备与 Cordis boot 之前，只把其中公开的 `pnpm` 命令目录前置到 Electron main 进程的 `PATH`。不可变 launch snapshot 会记录经过打包 Unix shell 恢复后的有效启动环境，但仍早于 Desktop 加入生成的命令目录。第三方直接使用的 library 与 DSH subprocess provider 会通过 `process.env` 继承该 runtime command。

公开 runtime 目录在 POSIX 上只包含 `pnpm`，在 Windows 上只包含 `pnpm.cmd`。相邻的私有 helper 目录包含供 pnpm lifecycle script 使用、由 Electron 承载的 `node` 命令。pnpm wrapper 只会在自身 child environment 中前置该 helper，设置 `NODE` 以便 pnpm 从 helper 而非 Electron executable 推导 `npm_node_execpath`，并在局部提供 Electron runtime、目标版本与 headers URL，以便为 Host runtime 构建 native dependency。

Electron Node 模式只用于让已签名应用 executable 以 Node 启动。生成的 prelude 会在 pnpm 或 lifecycle script 运行前移除所有大小写形式的 `ELECTRON_RUN_AS_NODE`，因此后代进程不会意外让无关 Electron 应用以 Node 模式启动。Electron Node 模式与 npm ABI 变量只存在于 pnpm subprocess tree；内置 runtime 不会向普通 Host 环境加入 `ELECTRON_RUN_AS_NODE`、npm 配置、`PNPM_HOME`、`node` 或 `dsh`。用户通过 login shell 导出的 allowlist 变量可能独立提供 `PNPM_HOME`；该值在 `PATH` 中仍位于产品公开 pnpm shim 之后。

命令路径安装会返回由 Host Cordis fiber 持有的幂等 disposer。它会从当前进程 `PATH` 中移除生成目录，并保留无关环境值；部分 boot 失败时也会显式执行。系统 PATH、shell 启动文件、profile manifest、profile patch 与 `.env` 文档都不会被修改。

## 验证

Focused test 覆盖私有原子文件、崩溃残留清理、symlink 拒绝、POSIX 与 Windows quoting、PATH key 大小写、幂等安装与释放、公开目录内容、私有 Node 位置，以及 parent environment 中不存在 Electron Node-mode 或 ABI 变量。Login-shell test 会覆盖随机标记包围的捕获、zsh/bash/fish 调用、deadline 与大小边界、固定变量选择、官方 scrub 名称、显式启动优先级、fallback 行为，以及 shell 恢复、launch snapshot 与产品命令安装的先后顺序。Built CLI smoke 会通过生成的 wrapper 调用固定 pnpm 版本，并运行一个离线 lifecycle script 来验证 `NODE`、`npm_node_execpath` 与已清除的 Node-mode 变量。Loader smoke 会验证第三方 Host 插件在激活期间可以看到公开 runtime command 目录，同时 launch snapshot 不包含生成的产品命令。Packaged-runtime gate 要求 runtime-environment 产物与物理 unpacked pnpm 入口同时存在。通过 Finder 或其他图形 launcher 启动已签名打包应用仍属于目标平台 smoke，不属于 headless 测试已经证明的范围。

Windows batch 命令需要 command interpreter。上游 `dsh plugin` 已经在 Windows 使用 `shell: true`，PowerShell 或命令提示符也能正常解析 `pnpm.cmd`。若第三方插件直接调用 Node `spawn('pnpm', { shell: false })`，batch shim 无法可靠执行；lifecycle script 直接以 `shell: false` 执行其 `.cmd` `npm_node_execpath` 时也有相同限制。完整支持这些非可移植调用需要原生签名 launcher，仍属于目标平台工作。

## 考虑过的替代方案

**把完整终端 shim 目录加入 Host PATH。** 这会覆盖每个插件中的 `node` 与 `dsh`，并让激活 profile 的终端策略影响无关 Host subprocess。

**在 Electron 进程中设置 Node-mode 与 ABI 变量。** 每个插件与子进程都会继承只应属于 Launcher 的状态，其中包括无关 Electron 应用。

**把产品生成的命令路径写入 launch-environment snapshot。** Snapshot 可以包含选定的用户 login 环境，但产品生成的命令不属于继承环境、项目 `.env` 或用户 `.env`。

**要求系统安装 pnpm。** 这违背打包桌面分发，并让插件行为依赖机器上的 Node 工具链。

## 结果

Host 插件从启动开始即可解析固定版本的内置 pnpm，也可以通过普通 DSH subprocess service 使用它。DSH Desktop 之外的用户命令保持不变；插件运行时不会获得全局 `node` 替代；pnpm 的 native dependency 会面向与 Host 相同的 Electron 版本构建。
