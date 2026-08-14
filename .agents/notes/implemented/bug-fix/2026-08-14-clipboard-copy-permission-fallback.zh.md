# Agent Note: 桌面端复制控件被全拒绝权限策略阻断

Status: implemented

[English](2026-08-14-clipboard-copy-permission-fallback.md) | 中文

## Problem

桌面外壳在首个渲染进程加载前安装了全拒绝的会话权限策略
（`setPermissionCheckHandler(() => false)`）。`navigator.clipboard.writeText()`
会执行 `clipboard-sanitized-write` 权限检查，因此 Web UI 中所有复制控件——消息
气泡、代码块、终端、diff、搜索结果、悬停卡片、JSON 树——在桌面端都会以
`NotAllowedError` 拒绝。渲染层辅助函数 `writeClipboard` 把拒绝的异步 API 视为
硬失败：它只在 `navigator.clipboard.writeText` 完全缺失时才走
`execCommand('copy')` 兜底，因此在桌面端兜底永远不会执行，点击复制悄无声息地
毫无效果。

## Decision

两层一起修改。

`apps/desktop/src/main.ts`（`hardenSession`）在权限检查处理器和权限请求处理器中
都只放行一个权限——`clipboard-sanitized-write`；其余权限保持拒绝，保留加固意图。

`packages/client/ui-primitives/src/clipboard.ts`（`writeClipboard`）在异步 API
存在但拒绝时落入 `execCommand('copy')` 路径，因此策略拒绝异步 API 的主机仍能通过
不查询权限系统的传统同步路径完成复制。`JsonTree` 改为经由 `writeClipboard` 复制，
而不是直接调用 `navigator.clipboard.writeText`，从而获得同样的兜底和诚实的失败
状态。

## Alternatives considered

**只在桌面外壳放行权限。** 否决作为唯一修复：渲染层兜底同样保护其他受策略限制的
主机（iframe 嵌入、未来的 Web 部署），并让 `JsonTree` 获得诚实的失败状态而不是
不可达的 catch。

**仅修复渲染层。** 否决，因为外壳的全拒绝是根因：那里的主异步路径仍然不可用，
且任何没有 `execCommand('copy')` 路径的主机仍然失败。

**保持拒绝时返回 false。** 否决，因为这正是被观察到的问题：复制静默失败，无任何
用户反馈。

## Consequences

桌面端复制通过异步 API 恢复可用（权限已放行），`execCommand('copy')` 兜底作为纵深
防御；在任何 `writeText` 存在但拒绝的主机上 Web UI 都能复制；两条路径都拒绝时
`JsonTree` 报告诚实的失败状态。除单个剪贴板写入权限外，外壳的加固姿态不变。
单元测试覆盖新分支：拒绝后跟 execCommand 成功、拒绝后跟 execCommand 拒绝，以及
既有的缺失 API 路径。
