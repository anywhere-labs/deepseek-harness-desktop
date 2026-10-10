# Agent Note: Windows Electron ACL Runner

Status: implemented

[English](2026-08-15-windows-electron-acl-runner.md) | 中文

## Problem

上游 Windows sandbox 会把 ACL runner argv 组合为 `[process.execPath, runner.js, ...]`。在 DSH CLI 下这是正确的，因为 `process.execPath` 是 Node。DSH Desktop 会在 Electron 内启动同一批 Host plugin，此时该值在开发环境中是 Electron executable，在打包后则是已安装的 `DSH Desktop.exe`。使用 runner 路径作为参数启动该 executable，并不会建立上游 runner 所预期的普通 Node 进程，反而可能启动另一个 desktop 应用实例。

Windows sandbox 没有更弱的自动 provider fallback。因此，损坏的 runner 会让普通 workspace-write PowerShell 不可用；静默绕过 confinement 又会错误表示当前选择的权限模式。上游原生 spawn 还会有意省略 `CREATE_NO_WINDOW` 与 `CREATE_NEW_CONSOLE`，因为受限 child 使用任一 flag 都会在 DLL 初始化时失败。这对 console Host 是正确行为，但 Electron Node-mode runner 启动时没有 console。在受影响的 Windows 环境中，受限 console child 被迫自行创建 console 时会在 DLL 初始化阶段以 `0xC0000142` 失败；即使某些环境能由 Windows 成功创建该 console，其行为仍与拥有 console 的 CLI 路径不同。

## Decision

Desktop package 会把 `dsh-plugin-desktop/windows-pwsh-sandbox` 发布为现有 package 的 Host 子路径，而不是第二个 npm package。Windows desktop profile 会确认 `pwsh-sandbox` row 仍指向预期的上游 provider，保留它的平台 gate 与配置，禁用该 row，再插入 desktop 子路径。兼容模式与高级呈现模式使用同一个 Host profile，因此都会使用同一个执行 adapter。

`DesktopWindowsPwshSandbox` 会继承上游 `SandboxPwshExecutor`，并使用其受保护的 argv 执行方法。只有当平台为 Windows、Host 为 Electron、executable 等于 `process.execPath`，且下一个参数等于已解析的上游 Windows ACL runner 时，它才会改变调用。改写后的 argv 会在 executable 与上游 runner 之间插入私有 desktop trampoline。直接 PowerShell 执行，包括显式 `danger-full-access` 路径，都会原样通过。

适配后的 child 会获得一份克隆环境，其中会移除每个不区分大小写的 `ELECTRON_RUN_AS_NODE` key，再加入唯一的 `ELECTRON_RUN_AS_NODE=1`。Trampoline 会校验精确的上游 runner 路径，从自己的环境中移除该变量的全部形式，然后检查 Windows console 状态。如果进程没有附加任何 console，它会在仍未受限时建立一个没有窗口的 console。在 Windows 11 24H2、Windows Server 2025 及更高版本上，它以 `ALLOC_CONSOLE_MODE_NO_WINDOW` 调用 `AllocConsoleWithOptions`。在其他版本上，它会以 `CREATE_NO_WINDOW` 启动一个不受限的 `cmd.exe`，该进程拥有一个没有窗口的 console；trampoline 通过 `AttachConsole` 附加到该 console，然后让这个 donor 退出，console 会因为 trampoline 仍然附加而继续存在。只有两种策略都失败时，它才调用 `AllocConsole()` 并通过 `ShowWindow(..., SW_HIDE)` 隐藏所分配的窗口；此时分配失败属于致命错误。隐藏的普通 console 只作为最后手段，因为当 Windows Terminal 是默认终端应用时，Windows 可能把它交给 Windows Terminal，而终端窗口不会理会隐藏请求。完成这项 Host 设置后，trampoline 才会重建上游 module 预期的 argv 并导入该 module。因此，受限 PowerShell 及其后代会继承真实 console，同时不会继承 Electron 的 Node-mode switch。

Electron build 会显式启用 `runAsNode` fuse，因为该 child launch protocol 依赖此能力。Trampoline 会保留上游 `windows-acl-run` 失败签名，并在自身校验或导入失败时以代码 127 退出，因此现有 sandbox layer 会继续把 runner 启动失败分类为不可用并 fail closed。

Deploy root 会通过仓库自有的 Yarn patch 固定已发布的 rc.6 Windows ACL package。它的 pipe capture 与 inherited-stdio 两组 `STARTUPINFOW` 值都会把 `STARTF_USESHOWWINDOW` 和现有的 `STARTF_USESTDHANDLES` 组合起来，并把 `wShowWindow` 设为 `SW_HIDE`。Creation flag 保持不变，因此受限 child 会继承 trampoline 的 console，并保留上游 token、job 与 stdio 行为。原生 show-state 仍作为纵深防护保留，但不会代替 Host console 分配。Patch 会同时固定直接与传递的 rc.6 dependency descriptor；依赖测试会要求 sandbox provider 与 Desktop adapter 解析到同一个 patched package instance。

## Verification

单元测试覆盖精确的 Windows Electron match、不变的非 Windows、普通 Node、错误 executable、错误 runner 与直接 PowerShell 调用、不区分大小写的环境移除、父进程环境隔离、trampoline 拒绝、复用已有 console（包括没有窗口的 console）、无窗口分配、附加 donor console 并释放 donor、隐藏 console 回退、分配失败、Host 设置顺序、公开 package export、build entry、已启用 fuse、准确的 Yarn patch resolution、两处隐藏 show-state 写入，以及没有使用 `CREATE_NO_WINDOW`。仅在 Windows 上运行的测试会启动一个分离且没有 console 的 Node 进程，分别通过无窗口分配与 donor 两种策略执行真实的 console 设置，验证该进程最终拥有 console 但没有 console 窗口，再运行继承该 console 的真实受限 `cmd.exe`。Profile 测试验证 Windows 替换、继承的配置与 gate、不变的 macOS 和 Linux 组合、不变的 subprocess 与 sandbox service，以及显式禁用或第三方 provider 会被保留。

Host 与 Client compiler face 会独立通过 typecheck。Package 可以 headless build，201 节点的第一方 runtime graph 仍然闭合，Loader 与完整 profile smoke 均通过。一次 headless Electron 43 Node-mode smoke 会执行已构建 trampoline 并到达上游 ACL runner，后者会输出带签名的缺少参数错误。原生 Windows ACL confinement 与打包后的 `app.asar` 路径仍需要在目标机器上验证。

## Alternatives considered

**原样执行上游 argv。** 该 executable 是 desktop 应用而非 Node，因此 runner entry 不能依赖 CLI launch 假设。

**全局设置 `ELECTRON_RUN_AS_NODE`。** 模型工具、shell 与其他 subprocess 都会继承 Electron 专属行为。该变量只会提供给一个精确匹配的 runner child，并在受限执行开始前移除。

**使用本地 PowerShell 替换 Windows sandbox。** 这会让 workspace-write 在没有声明的 ACL confinement 下执行。Adapter 会保留上游 sandbox provider 及其 fail-closed 行为。

**在 Node runner spawn 上增加 `windowsHide`。** 该选项只会影响 Electron 到 runner 的进程创建，无法改变 runner 直接执行的 `CreateProcessAsUserW`。若在受限 child 层把它转换为 `CREATE_NO_WINDOW`，会触发上游已经确认的 DLL 初始化失败。

**修改 pinned 上游 submodule。** Console 呈现问题只存在于 desktop deploy artifact。仓库自有 Yarn patch 会保持上游 checkout 不变，并把原生 show-state 调整限制在 Desktop 消费的固定 package 内。

**使用 Electron `utilityProcess`。** 上游 sandbox API 会向普通 subprocess provider 提供 argv prefix，而 utility process 使用独立的 lifecycle 与 stream interface。只适配预期 runner child 的范围更小，也能保留现有 provider 组合。

## Consequences

两种 desktop 呈现模式都可以使用普通上游 Windows PowerShell tool 及其 ACL confinement，desktop 仍保持为纯新增 package。该 adapter 有意保持窄范围：上游 runner package、argv prefix 或 provider 身份发生变化时会 fail closed，而不会猜测新行为。

已安装 executable 会有意保留 Electron RunAsNode 能力，用于这个内部 child protocol。Windows release 验证必须从打包后的应用执行 read-only 与 workspace-write console 命令，并在目标操作系统上确认 GUI runner 启动时没有 console、已构建 trampoline 会建立没有窗口且可继承的 console、原生 ACL 设置仍然有效、输出能够捕获、退出能够传播、取消可用，并且临时 ACL 状态会被清理。
