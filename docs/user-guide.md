# DSH Desktop 用户指南

## 安装与首次启动

从产品下载入口获取 macOS 或 Windows 安装包。安装后的 DSH Desktop 自带运行所需的 Electron、Node 和 DSH 依赖，普通用户不需要另行安装 Node.js 或 pnpm。

首次启动时，应用会准备默认 profile，并在本机启动官方 DSH Web surface。关闭窗口通常只会隐藏窗口；可以从托盘重新打开，选择 **退出** 才会结束应用和 Host 进程。

## Profile

Profile 是一组 DSH bundle、依赖和 patch 的组合。托盘中的 **Profile** 菜单会列出现有 profile，以及可按需创建的 `desktop` 和 `web` 默认 profile。

选择 profile 后应用会有序重启。新 profile 在 Host 和窗口都成功启动后才会被记录为最近一次可用 profile；启动失败会回到上一次可用选择。官方 profile 默认使用同一个 DSH home，所以 sessions、settings 和 storage 通常不需要迁移。自定义 patch 如果主动改写持久化路径，则以该 profile 自己的设置为准。

切换 profile 不会把旧 profile 的插件偷偷复制到新 profile。要管理目标 profile，请在终端中显式写出 profile，或者在切换后使用终端里的默认命令。

## 兼容模式与高级模式

- **兼容模式**：使用上游默认 Web client 和 profile 自己的 layout/sidebar/conversation 组合。它适合希望尽量接近官方 Harness 的用户。
- **高级模式**：在不改变上游 Web carrier 的前提下加入 Desktop 自有的 frame、布局、Mica/vibrancy 和原生拖动区域。它适合需要更完整桌面外观的用户。

切换模式会重启应用，不会在正在运行的 renderer 中热替换 root slot 或窗口材质。Linux 只提供兼容模式。

## 插件管理

普通 DSH 插件仍使用官方 CLI 语义：

```sh
dsh plugin --profile desktop add <plugin>
dsh plugin --profile desktop remove <plugin>
dsh plugin --profile desktop update
```

在 DSH Desktop 托盘打开的终端中，裸 `dsh` 和不带 `--profile` 的 plugin 命令默认使用当前激活 profile：

```sh
dsh plugin add <plugin>
dsh plugin remove <plugin>
dsh plugin update
```

显式 `--profile <name>` 始终优先。插件变更后需要重启 DSH Desktop，才能让新的 bundle 进入 Loader 组合。

## 打开终端

从托盘选择 **Open DSH Terminal**。macOS 会打开 Terminal，Windows 会优先使用 Windows Terminal，找不到时回退到 PowerShell 或命令提示符。

欢迎信息会显示：应用版本、当前 profile、profile 目录和 DSH home。Desktop 会在自己的 user-data 目录生成 `dsh`、`pnpm` 和 `node` 私有 shim，只对这个终端进程设置 PATH，不会修改系统 PATH 或用户 shell 配置。

## 更新

打开**设置 → 通用 → 软件更新**即可查看当前版本与更新状态。手动检查会分别显示“已是最新版”“无法连接 GitHub”“GitHub Release 缺少更新文件”，以及下载、存储空间或安装启动问题。托盘会提供与当前状态对应的相同操作。

打包后的 macOS 与 Windows 应用会在启动 60 秒后检查 `anywhere-labs/deepseek-harness-desktop` 的正式 GitHub Releases，并在每次检查完成六小时后再次检查。发现新版本时会显示可关闭的应用内提示。更新器不会接受预发布版、降级、源码拉取、GitHub Token 或任意下载地址。

签名并公证的 macOS 安装包可以在客户端内下载更新，验证完成后显示**重启并更新**。经过代码签名的 Windows 安装包使用相同流程；未签名的 Windows 安装包与 Linux 会打开固定的 GitHub Releases 页面，由用户手动安装。取消操作会等待当前下载停止，随后才允许重新下载。

v2.0.1 是更新器的引导版本，需要手动安装。从 v2.0.2 开始，只要当前安装包与目标安装包都声明支持自动安装，即可使用完整的一键更新流程。

## 排查

- **窗口消失了**：先检查系统托盘，关闭窗口不是退出。
- **插件没有出现**：确认命令作用于目标 profile，并重启应用。
- **终端命令找不到**：从托盘重新打开 Desktop 终端；系统 shell 的全局 PATH 不会被 Desktop 修改。
- **更新页提示缺少更新文件**：最新 GitHub Release 缺少 `latest-mac.yml` 或 `latest.yml`。可以打开发布页手动下载，或等待发布产物完成上传。

更完整的原生生命周期、打包和平台限制见 [`dsh-plugin-desktop/README.zh.md`](../dsh-plugin-desktop/README.zh.md)。
