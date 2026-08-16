# Agent Note: Desktop GitHub 更新

Status: implemented

[English](2026-08-16-desktop-github-updates.md) | 中文

## 问题

DSH Desktop 需要为长期驻留的托盘进程提供可见、可操作的更新路径。单一的“检查失败”无法区分当前已是最新版、网络离线、GitHub Release 不完整或下载异常。手动替换也无法让已签名的桌面安装包直接完成升级。

更新器必须保留现有 sandbox renderer 与 Cordis 生命周期。Web 内容不能获得文件系统路径、任意导航、Electron IPC、安装器 handle 或 GitHub 凭据。安装只能在 Host 及其子进程停止后开始。

只有当 GitHub Release 把平台产物与更新元数据作为一组完整产物发布时，它才能作为更新源。部分上传的 Release 会让客户端发现一个无法下载或校验的版本。

## 决策

DSH Desktop 使用 `electron-updater`，GitHub provider 固定为 `anywhere-labs/deepseek-harness-desktop`。更新器只接受正式版升级，并关闭自动下载、普通退出时安装、预发布版、降级、Web installer 与差分下载。客户端不会拉取源码或携带 GitHub Token。

`desktop-updates` Host plugin 拥有一个控制器，状态包括 `idle`、`checking`、`current`、`available`、`downloading`、`downloaded`、`error` 与 `unsupported`。它会在激活 60 秒后检查，并在每次检查完成六小时后安排下一次。检查、下载、取消与安装都使用 single-flight operation；取消会等待 provider 完成清理，再允许开始下一次下载。

目标元数据会声明 `desktopUpdateMode: automatic | manual`。自动安装要求当前安装包与目标元数据都为 `automatic`，声明的文件大小不超过 1 GiB，缓存卷具有足够空间，并且完整传输字节数始终低于上限。同一 Release 的已下载候选可以跨检查保留；发现更新 Release 时会替换该候选。

### Client 与传输

打包后的 renderer URL 会携带 `enabled` 更新标记。Desktop Client 随后注册通用设置行与可关闭的 `shell.overlay` 提示。开发运行、未打包启动与普通 Web 客户端不会注册这两项 contribution。

Client 通过现有同源 Connection transport 调用固定的 `/desktop-updates` RPC。RPC 只接受空 payload 的状态读取、检查、下载、取消、安装与打开发布页操作。返回值只包含版本、进度、安装能力和浏览器安全的失败分类，不包含本地路径或 provider URL。外部操作只能打开固定 GitHub Releases URL；一次成功打开后，该应用进程不会再次发起打开请求。

可见文案会区分当前已是最新正式版、网络失败、GitHub 缺少更新文件、存储空间不足、产物体积超限、取消清理、安装启动失败、系统浏览器无法打开与未知 provider 错误。缺少 `latest-mac.yml` 或 `latest.yml` 时会提供发布页入口。发现版本和完成下载也会在当前 Host generation 中为每个版本显示一次原生通知。

### 安装生命周期

选择“重启并更新”后，native runtime 会标记 update exit、隐藏窗口，并请求普通的有界 Cordis shutdown。Host dispose 会在最终原生退出前释放 updater RPC、timer、listener、活跃传输、子进程所有权、托盘与 BrowserWindow。成功且退出码为零的更新退出会调用 `quitAndInstall(false, true)`；普通退出调用 `app.exit`，不会安装缓存的 Release。原生交接错误和有界交接超时会回退为非零应用退出。

### Release 完整性

Tag 触发的发布工作流只接受稳定的 `vMAJOR.MINOR.PATCH` tag，同时要求两个产品 manifest 版本一致，并且 tag commit 属于 `master`。签名任务位于受保护的 `desktop-release-signing` environment 后面。所有第三方 action 都固定到完整 commit SHA。

macOS 会发布签名并公证的 arm64 DMG、ZIP 与 `latest-mac.yml`，并声明自动安装能力。Windows 会发布 x64 NSIS installer、blockmap 与 `latest.yml`；具有有效 Authenticode 的构建声明自动安装能力，未签名构建声明手动能力并打开 GitHub 完成安装。Windows 手动打包会移除证书变量，并校验 Release 产物确实未签名。

只读汇总任务会校验准确的文件集合、版本、updater URL、文件大小、SHA-512、主产物 hash、签名标记、公证标记与目标能力，随后生成 SHA-256 sums 并上传一份完整产物。独立 publish 任务不 checkout 源码，也不安装依赖；它只在创建或恢复 draft、替换产物并发布时获得 `contents: write`。已经公开的 Release 不会被替换。

v2.0.1 是引导安装包，需要手动安装。从 v2.0.2 开始，只要两端产物都声明自动支持，即可使用完整自动路径。

## 验证

控制器测试覆盖已是最新版、发现版本、进度、取消、立即重试、字节上限、过期已下载候选、provider 失败、listener 隔离与 dispose。Client 测试覆盖每种状态与操作、双语文案、轮询、传输失败，以及非桌面环境不注册更新界面。Host 与 Electron 测试覆盖 loopback RPC payload 拒绝、调度、通知、固定外部导航、updater 配置、空间策略、Host 先于安装器停止、普通退出、同步交接失败与交接超时行为。

打包测试覆盖 runtime archive 中的更新入口、macOS DMG 与 ZIP 参数、Windows 手动与签名模式、元数据标记、tag/版本一致性和完整产物 hash。发布工作流仍需在目标机器上使用连续两个签名版本完成安装验收。

## 考虑过的替代方案

**在已安装应用中拉取最新 Git 源码。** 源码 checkout 无法生成签名应用，也无法维持 package dependency、native module、公证与安装器身份。Release artifact 是唯一更新输入。

**保留自定义 redirect downloader。** 该路径可以识别 DMG 与 PE 容器，但无法把 Release 与签名更新元数据绑定，也无法使用平台 updater handoff。`electron-updater` 会直接消费 Electron Builder 生成的产物，并移除这套自有协议。

**始终打开 GitHub。** 已签名平台仍需手动安装，同时没有下载进度与待重启状态。Linux 与未签名 Windows 安装包会保留该 fallback。

**通过 preload bridge 暴露 Electron IPC。** 现有 loopback Connection 已经提供方法授权、生命周期所有权与同源校验。为一个窄功能增加第二套 transport 会增加安全与 dispose 路径。

**让并行任务直接发布各平台产物。** 客户端可能看到不完整 Release。汇总产物与 draft-first 发布顺序会在 Release 变成正式版之前保证内容完整。

## 结果

用户可以看到明确的更新状态、客户端内进度、取消、重试，并在产物信任条件允许时使用一键安装。缺少 Release 元数据会成为有名称的运维状态，并提供手动 GitHub 路径，不会继续折叠成笼统失败文案。

Release 构建需要维护 updater 元数据、目标能力、跨平台产物校验与受保护的签名 environment。macOS 自动更新依赖签名与公证；Windows 自动更新依赖有效 Authenticode 证书；Linux 与未签名 Windows 保持手动安装。v2.0.1 引导版也需要一次手动过渡，之后才能使用自动升级。
