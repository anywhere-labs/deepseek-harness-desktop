# Agent Note: Linux desktop uses the standard system title bar

Status: implemented

[English](2026-08-14-linux-desktop-system-title-bar.md) | 中文

## 问题

Linux 无边框窗口没有提供任何系统窗口控制。Linux 上的无边框 Electron 窗口既没有 Windows 的 Window Controls Overlay，也没有 macOS 的交通灯按钮，因此用户无法从窗口外观上最小化、最大化或关闭窗口，只能依赖窗口管理器快捷键或托盘菜单。[桌面窗口外观决策](../architecture/2026-08-14-electron-loopback-web-supervisor.md)让 Linux 保持无边框，是因为 Electron 在该平台没有对应的原生玻璃材质，但没有考虑缺失窗口按钮的问题。

## 决策

`apps/desktop/src/window-options.ts` 中的 `createWindowOptions()` 对除 macOS 外的所有平台返回原生边框（`frame: true`），因此 Linux 显示标准系统标题栏和窗口按钮。Windows 保留 `titleBarStyle: 'hidden'` 与 Window Controls Overlay；Linux 不设置 `titleBarStyle`、`titleBarOverlay` 或透明选项，并在系统窗口外观下渲染普通不透明页面。Web 入口不再对 Linux 应用桌面呈现标记，因此客户端在该平台不提供拖拽区域或标题栏留白。macOS 保持不变：透明表面上无边框的内嵌式交通灯。

## 验证

`apps/desktop/tests/window-options.spec.ts` 固定 Linux 上的原生边框以及 macOS 与 Windows 不变的窗口外观选项；`apps/web/tests/desktop-marker.spec.ts` 固定 Linux 渲染器在系统标题栏之后保持未标记状态。

## 考虑过的替代方案

**让 Linux 保持无边框并在页面中自绘窗口控制。** 这保留了自定义外观，但需要渲染器侧的最小化/最大化/关闭按钮、IPC 接线以及按桌面环境调整的摆放位置。标准标题栏是恢复可用窗口控制的最小改动。

**在 Linux 上使用 Window Controls Overlay。** 该覆盖层仅适用于 Windows；Electron 不会在 Linux 上为其绘制窗口按钮。

**在官方支持落地前保持现状。** 无边框窗口在 Linux 上已被日常使用；启用边框的改动移除了一项可用性缺陷，且不声称发布支持。

## 后果

Linux 窗口恢复了原生最小化/最大化/关闭行为和可拖拽的系统窗口外观。桌面呈现标记只覆盖 macOS 与 Windows，因此 Linux 页面保持普通 Web 布局，没有标题栏留白或拖拽带。无边框自定义外观与原生玻璃材质仍只属于 macOS 与 Windows 的呈现。
