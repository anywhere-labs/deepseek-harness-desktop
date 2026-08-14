# Agent Note: 桌面端原生编辑右键菜单

[English](2026-08-15-desktop-native-edit-context-menu.md) | 中文

Status: implemented

## Problem

桌面应用隐藏了应用菜单，复用的 Web renderer 也没有提供右键菜单。因此，尽管相应键盘快捷键仍然可用，鼠标用户无法在可编辑字段中发现或调用粘贴等标准文本编辑操作。

## Decision

Electron 主进程处理 renderer 的 `context-menu` 事件，并根据 `ContextMenuParams.editFlags` 构建操作系统原生菜单。可编辑字段提供撤销、重做、剪切、复制、粘贴、删除和全选，各操作是否可用由 Chromium 报告。只读内容在存在非空选区时提供复制，并在 Chromium 允许时提供全选。

该菜单使用 Electron role，使编辑命令直接作用于获得焦点的 renderer frame，无需 preload bridge 或额外的 renderer 权限。链接、媒体、下载、导航和开发者操作不纳入这个文本编辑菜单。

## Alternatives considered

**在 Web renderer 中构建自定义菜单。** 这会重复实现各平台菜单行为，并为桌面端专用功能引入 Web UI 状态、样式、无障碍和层叠管理工作。

**恢复可见的应用“编辑”菜单。** 全局菜单可以提供这些命令，但无法满足桌面用户所需的指针就地交互，而且会改变项目刻意隐藏的应用外观。

## Consequences

桌面用户可以通过熟悉的指针操作使用文本编辑功能，同时 renderer 继续保持隔离和沙箱化。菜单严格遵循 Chromium 报告的编辑可用性，因此无法执行的操作会保持禁用或不出现。单元测试在不启动 Electron 窗口的情况下固定菜单组成；打包后的交互仍由各平台冒烟测试覆盖。
