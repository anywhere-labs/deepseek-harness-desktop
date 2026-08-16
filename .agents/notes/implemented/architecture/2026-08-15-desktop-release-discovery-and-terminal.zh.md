# Agent Note: Desktop release 发现与终端环境

Status: implemented

[English](2026-08-15-desktop-release-discovery-and-terminal.md) | 中文

## 问题

DSH Desktop 需要两项不属于上游 Web 呈现的原生操作。用户需要在不持续关注仓库的情况下发现较新的 stable desktop release；只使用安装器的用户也需要一个终端，在无需另外安装 DSH CLI 或 pnpm 的情况下运行普通 `dsh --profile desktop` 插件工作流。

这些操作必须保留兼容模式与高级模式已经建立的产品边界。固定的上游 checkout 保持不变；兼容模式继续使用没有 override 的官方 Web client；沙箱 renderer 不获得 Electron、Node、文件系统、进程或终端能力。desktop package 也不能修改用户的全局 `PATH` 或 shell 启动文件。

GitHub Release 发现、updater 元数据与安装由独立的 [Desktop GitHub 更新决策](2026-08-16-desktop-github-updates.zh.md)负责。本记录保留与隔离终端共享的组合方式，以及终端环境决策。

## 决策

Desktop 原生操作是围绕同一个 Electron adapter 组合的独立 Cordis Host contribution。profile 会在普通 Web bundle 之后组合 `desktop-shell`、`desktop-terminal` 与 `desktop-updates`。Electron runtime 拥有实体托盘并提供有序 item registry；每个 Host plugin 都在 `ctx.effect()` 中注册命令，并在该 generation dispose 时移除命令。Shell 继续拥有窗口与模式生命周期，terminal 与 update plugin 只拥有各自的命令状态。

Host 组合在兼容模式与高级模式中完全相同。终端不会增加 Client face、preload bridge、Electron IPC 方法或 renderer global API；更新 Client 使用其所属决策描述的现有 loopback carrier。托盘菜单构造只对 contribution 分组，不检查上游或第三方 Web 元素。Linux 会在 profile 中禁用 terminal row；如果在 Linux 上直接激活该 Host plugin，则会明确失败，不会显示无法启动的命令。

## Stable release 更新交接

更新控制器、设置 contribution、GitHub 元数据、平台信任要求、发布工作流与 Host 先于安装器停止的顺序由 [Desktop GitHub 更新决策](2026-08-16-desktop-github-updates.zh.md)定义。`desktop-updates` 仍是与 shell、terminal 位于同一 profile generation 的 effect-scoped Host contribution。

## 隔离终端环境

Launcher 会在 Host plugin 能够提供 terminal 命令之前，用解析后的当前激活 profile 目录与 DSH home 对 Electron adapter 完成一次配置。在 macOS 与 Windows 上，`desktop-terminal` 会注册 **Open DSH Terminal**。每次调用都会在应用 user-data 的 `cli` 目录下重新生成私有启动文件，并以 profile 目录为工作目录打开一个独立的 system terminal。

生成的 `bin` 目录包含 `dsh`、`pnpm` 与 `node` shim。它们会复用打包后的 Electron executable 的 Node mode，而不依赖系统 Node 安装。Electron Builder 会把生产依赖树输出到 `app.asar.unpacked`，desktop CLI 与 pnpm shim 会进入这棵物理依赖树；因此 profile fallback 的符号链接会指向真实 package 目录，而不是虚拟 ASAR 路径。`dsh` shim 会使用 `--expose-internals` 启动 Node mode，从而保留普通 profile 与 HMR 所需的 internal ESM hook，随后进入 desktop 自有 bootstrap。在这个专用终端中，只有当调用没有选择 profile 时，该 bootstrap 才会补充打开终端时选择的 profile，包括裸 `dsh`、`dsh --dump-config` 与 plugin 子命令；显式 `--profile` 与上游 `web` alias 仍然拥有最终决定权。随后，它会在导入固定且已 unpack 的 `@deepseek-ai/dsh` CLI 入口前，移除所有大小写形式的 `ELECTRON_RUN_AS_NODE`。通用 Node 与 pnpm shim 只在自身子进程树中启用 Node mode。pnpm shim 还会局部设置 `npm_config_runtime=electron`、打包 Electron 版本与 Electron headers URL，使安装到所选 profile 的原生依赖面向当前 Electron ABI。

Terminal child 启动时会移除 Electron Node mode，把 `DSH_HOME` 固定为 Launcher 当前使用的 home，以 desktop profile 为工作目录，并且只在该 child 的 `PATH` 前置生成的 `bin` 目录。Electron main process 环境、操作系统环境与用户 shell 文件都不会被修改。欢迎信息会显示 DSH Desktop 版本、profile、profile 目录与 DSH home，随后给出配置 dump、插件 add、remove、update 命令，以及必须重启应用的提示。

在 macOS 上，LaunchServices 会打开生成的 `welcome.command`。受控的交互式 zsh 或 bash 启动会先读取用户普通的交互式 rc 文件，随后移除 Electron Node mode 并恢复 desktop 自有 home 与 shim path，避免用户 rc 意外丢弃这些值。在 Windows 上，Launcher 会依次解析 PowerShell 7、Windows PowerShell 与命令提示符，并优先使用新的 Windows Terminal 窗口承载所选 shell。如果 `wt.exe` 不可用，生成的 batch broker 会通过内置 `start` 命令分配可见控制台。Windows command 文件与 PowerShell welcome 源码只包含 ASCII；本地化 profile 名称和路径通过 Unicode child environment 传入，而不依赖当前 code page。Electron 进程始终使用 executable 与 argv 并设置 `shell: false` 来调用 launcher；同步启动失败、异步 spawn 错误与 broker 非正常退出都会进入原生错误对话框。生成的 PowerShell 或 batch welcome 文件会完成最终环境设置。

System terminal 是由本地用户显式发起的能力，而不是 renderer 或模型能力。Web 内容无法通过 JavaScript 调用该命令，也没有原始 process handle 或 terminal stream 穿过 loopback Web carrier。插件安装仍以本地用户普通权限执行，并修改持久化 desktop profile，因此欢迎信息会要求先重启 desktop，当前 Cordis generation 才能使用这些变化。

## 验证

更新验证属于 [Desktop GitHub 更新决策](2026-08-16-desktop-github-updates.zh.md)。这里共享的托盘 registry 仍会在不打开真实窗口的情况下验证有序、可 refresh 且可 dispose 的 Host contribution。

Headless terminal 测试会检查生成的 macOS 与 Windows 文件、空格与 shell metacharacter quoting、通过 child environment 携带本地化路径的 ASCII Windows 模板、私有 POSIX mode、`DSH_HOME` 与 `PATH` 隔离、`--expose-internals`、不会覆盖显式 profile 或 `web` alias 的 default-desktop 参数注入、继承 Electron Node mode 的移除、交互式 shell 启动、Windows Terminal 选择、可见控制台 broker、PowerShell 与命令提示符 fallback、launcher 错误处理，以及对不支持平台或不安全生成脚本值的明确拒绝。Packaged-runtime gate 会在签名前要求 `app.asar` 包含 terminal 与 update 模块及 desktop CLI bootstrap，并要求 `app.asar.unpacked` 以物理文件形式包含上游 DSH CLI、Web runtime sentinel 与内置 pnpm 入口。

测试不会启动图形终端、显示操作系统对话框、请求任一生产下载 endpoint、替换 macOS 应用、安装第三方原生 package、验证 Authenticode 或执行签名 installer。这些行为仍是打包后 macOS 与 Windows 产物的目标平台检查。

## 考虑过的替代方案

**在 Web renderer 中嵌入终端。** 嵌入式终端需要 renderer UI、preload 与 IPC protocol、pseudo-terminal 所有权、进程 teardown，以及更大的安全面。所需的插件管理工作流只需要一个具有受控环境且由用户显式打开的 system terminal。

**将 PowerShell 或命令提示符作为 detached Electron child 启动。** Electron 的内嵌 Node 进程会隐藏控制台子进程，而 Windows detached-process 标志不会分配新控制台。两者组合会让交互式 shell 在没有可见窗口的情况下运行。因此 Windows Terminal 是首选 host，并由生成的 `cmd start` broker 提供兼容 fallback。

**修改用户的全局 `PATH` 或 shell rc。** 全局修改会在应用退出后继续存在，与其他 DSH 或 Node 安装产生冲突，并且需要卸载修复路径。私有生成 shim 会把所有权与清理保留在 DSH Desktop 内。

**要求系统安装 Node、DSH 与 pnpm。** 这会保留本功能原本要解决的 installer-only 缺口，并使行为依赖无关的宿主版本。打包 Electron Node mode 与内置 CLI 入口能提供版本匹配的环境。

**在 Electron tray builder 中硬编码所有命令。** 单体原生菜单会耦合无关操作并绕过 Cordis disposal。Effect-scoped item registration 可以保留 plugin 所有权、确定性顺序与未来 Host 组合能力。

## 结果

打包后的 DSH Desktop 可以提供普通 desktop-profile 插件工作流，同时保持上游 checkout 不变、renderer 隔离与全局 shell 状态不变。生成的 CLI 环境只存在于从托盘打开的终端内。

Desktop package 拥有内置 pnpm 版本与生成 shim 行为，这会扩大打包 runtime closure，并且必须持续与 Electron ABI 对齐。Linux 保留兼容模式，在形成独立平台设计前没有 desktop 终端。更新结果属于 [Desktop GitHub 更新决策](2026-08-16-desktop-github-updates.zh.md)。
