# Agent Note: Desktop 兼容模式

Status: implemented

[English](2026-08-15-desktop-compatibility-mode.md) | 中文

## Problem

DSH Desktop 需要原生应用生命周期，同时兼容模式必须保持未经修改的官方 Web 呈现。由于高级模式使用 desktop 自有呈现，该 package 仍需发布 Client face；但在兼容模式下加载同一 artifact 时，安全路径不能依赖产品自有 root、layout、sidebar 或样式。

## Decision

`desktop-shell` Cordis row 提供 `mode: compatibility | advanced`，标准 `dsh-desktop` settings namespace 会把 `mode` 默认为 `compatibility`。desktop package 同时声明 `dsh.bundle` 与 `dsh.client`；其 Client face 会在两种模式中被发现。

在兼容模式下，Client 会校验 Host 提供的模式与平台 URL marker，随后直接返回而不安装任何 effect。它不提供或替换 `layout` service，不注册 `root` 或 `sidebar` occupant，不安装样式，也不改动 conversation surface。只有 advanced generation 会调用 advanced-shell installer。

最终兼容组合会保持官方 `ui-layout`、`ui-sidebar` 与 `ui-conversation` Loader row 处于启用状态。因此，官方 `dsh-web-app` 模块图仍拥有 root 与完整呈现。经校验的 URL marker 让共享 Client artifact 能选择范围受限的分支，但不会暴露任何 Electron 能力。

持久化 `desktop` profile 仍按保留后的顺序包含 `dsh-base`、`dsh-web-app` 与用户安装的 bundle。第三方 client plugin 使用普通 `dsh.client` 元数据，由官方 Web 客户端模块图发现。Electron 不维护第二套插件 roster。

Launcher 会在用户 patch 之后添加一层平台安全 overlay。在 Windows 上，它会固定使用 browse 目录选择 row，从而保留完整的应用内面板。桌面 workspace 通过补丁为该面板加入一个纯图标原生选择动作，由同源桌面路由与 Electron `dialog.showOpenDialog` 提供能力；Electron 进程不会加载上游 koffi worker。macOS 与 Linux 保留上游自适应 row。

`desktop-shell` row 会在 profile 激活期间登记原生 shell spec，但不会从自身 Loader entry 内等待全局 Loader settlement。Launcher 只在 `app-boot` 返回后挂载该登记项，从而在首个 renderer 请求前保留激活审计，以及完整的官方、desktop 与第三方 client manifest。

## Mode persistence and restart boundary

DSH home `settings.yaml` 文档是 `dsh-desktop.mode` 的唯一持久化事实源。Launcher 会在组合之前读取当前 `dsh-settings-file` row 解析到的文件。Host plugin 向标准 settings service 注册同一 namespace 与 schema，并声明 `applies: restart`。profile manifest 中不存在第二个值。

用户可以从应用托盘选择另一种模式，也可以手工编辑同一份 `settings.yaml` 文档。托盘会调用已注册 scope 范围受限的 `settings.update({ mode })` 路径，file provider 则会观察手工修改。Watcher 会比较已提交模式与当前 generation，并在两者不同时请求一次有序重启。

Cordis disposal 会先释放 Client effect、Host row、托盘与窗口；仅当零退出码 shutdown 成功后，exit coordinator 才调用 `app.relaunch()`。兼容模式绝不会在存活 generation 内热替换官方 slot。Linux 会保持托盘模式命令禁用，并拒绝高级模式，而不会静默降级。

## Native lifecycle and security

兼容适配器创建普通 `BrowserWindow`，并且不设置自定义边框、标题栏、透明、vibrancy 或原生材质选项。macOS 会阻止可见页面标题更新。Windows 保留原生标题栏图标与固定的 `DeepSeek Harness Desktop` 标题，同时移除窗口菜单栏。原生标题栏颜色与外观由操作系统拥有。

Windows 与 Linux 保持使用未经修改的 iOS Default 应用图标。macOS 使用构建派生且带透明视觉边距的副本；打包、运行中的 Dock 与窗口 spec 都使用同一个按平台选择的路径。托盘在 macOS 使用由品牌 SVG 派生的模板图，在 Windows 与 Linux 使用固定品牌蓝图。兼容模式仍保留 renderer 隔离、Chromium sandbox、禁用 Node integration、精确同源导航、托盘所有权、关闭后隐藏、单实例唤醒，以及显式退出时有界 dispose Cordis 的行为。

## Verification

Package 测试要求 `./client` 导出与普通 `dsh.client` 依赖边。Profile 测试验证兼容模式保持官方 layout、sidebar 与 conversation row 启用，并组合 Windows browse picker。路由、runtime 与 client bridge 测试覆盖同源校验、原生对话框的选择与取消，以及面板桥接生命周期。Client 测试还会验证模式与平台 marker、作用域化高级 layout 行为与呈现隔离。

Host 测试验证标准 namespace 注册、托盘范围受限的 `settings.update({ mode })` 路径、只在值变化后重启，以及持久化前的 Linux 校验。Runtime 测试验证登记过程不会重新进入 Loader settlement，并且只有 Launcher 挂载已登记 generation 后才会构造 `BrowserWindow`。窗口选项测试会拒绝兼容构造器中的高级原生选项。

Headless Loader smoke 会激活 Host shell 与 profile 本地第三方插件，然后在不导入 Electron 也不打开窗口的情况下启动已发布 Web profile。Desktop deploy root 会直接提供生产依赖图中的每个必需第一方 peer；closure 检查会拒绝缺失声明。

## Alternatives considered

**只为高级模式发布独立 Client identity。** 这会把一个 package 的 browser artifact 拆成按 profile 区分的 identity，并增加另一条 roster 规则。共享 artifact 配合经校验且无 effect 的兼容分支，可以保持普通 package 发现路径，并显式划清边界。

**让 desktop Client 在两种模式中都替换 root 或 sidebar。** 共享呈现所有权会使兼容模式依赖 advanced shell，并降低它作为上游参考路径的价值。因此 advanced installer 只在 advanced generation 中调用。

**Patch 官方 UI。** 上游 patch 会违反 pinned-submodule 边界，并让浏览器 DSH 感知 Electron 产品策略。兼容模式改为保持官方呈现图不变。

**在 Electron package 内发布复制的 Web 前端。** 复制 client roster 会重复 Cordis 组合，并要求 desktop release 跟随每次上游 client 变化。兼容模式改为加载当前 profile 的官方 Web surface。

**Web server 绑定后立即打开窗口。** 已绑定的 socket 可以提供准确端口，但不能证明 frontend fallback、boot manifest 注入或后续 client entry 已激活。因此 Launcher 使用完成的 `app-boot` 激活作为挂载时点。

**Settings 修改后热切换模式。** 两种模式在 Loader row、service 所有权、root slot 声明与原生 `BrowserWindow` 选项上都不同。在 settings 边界重启可以得到一个一致 generation，而不是分别修改这些维度。

## Consequences

兼容模式仍是上游参考呈现，并在没有 desktop 自有 renderer 呈现的情况下获得原生生命周期。它跟随官方 UI 与第三方 client 行为，同时把持久化与重启策略保留在 Host 标准 settings service 内。

兼容 client graph 包含 desktop Client artifact 与经校验的 environment marker，但该 artifact 在校验后不会产生 effect。无边框窗口、半透明材质、desktop 几何、theme 投影与 renderer chrome 仍专属于单独记录的 [advanced shell](2026-08-15-desktop-advanced-shell.zh.md)。
