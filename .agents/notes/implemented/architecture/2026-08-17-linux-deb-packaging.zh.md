# Agent Note：Linux amd64 deb 打包

状态：implemented

[English](2026-08-17-linux-deb-packaging.md) | 中文

## 问题

Windows 已有 NSIS 一键安装包（`dist:win`），macOS 已有 DMG（`dist:mac-smoke` / `dist:mac`），而 Linux 只有解压目录 `dir` 目标，`docs/faq.md` 也写明尚未提供 Linux 安装包。尽管桌面端已经能在 Linux 上以兼容模式运行，Debian/Ubuntu 用户仍缺少一键安装途径。

## 决策

新增一个未签名的 amd64 deb 目标，沿用 Windows 与 macOS 的"原生宿主机打包"模式。`dsh-plugin-desktop/scripts/package-linux.ts`（`packageLinuxDeb`）先运行完整产品 gate，再以 `--linux deb --x64 --publish never --config.npmRebuild=false` 调用 Electron Builder，产物输出到独立的 `dist/linux/`，随后运行 `scripts/verify-linux-package.ts`（`verifyLinuxPackage`）校验 deb 归档头与解压后的 ELF 可执行文件。根目录 `dist:linux` 脚本在桌面包之前先跑 Market 构建，与 `dist:win`、`dist:mac-smoke` 保持一致。

`build.linux` 由 `target: ["dir"]` 改为 `target: ["deb"]`，固定 `executableName: "dsh-desktop"`（保证校验与桌面入口确定），使用稳定的 `artifactName`（`DSH-Desktop-${version}-${arch}.${ext}` → `DSH-Desktop-<version>-amd64.deb`），并补齐 deb 元数据（`maintainer`、`synopsis`、`description`、`category: Development`）。Linux 仅支持兼容模式，且现有的登录 shell `PATH` 恢复与分层启动环境快照已覆盖打包后的 Linux 启动，因此无需运行时改动。

运行时闭包校验 `scripts/verify-packaged-runtime.ts` 原本已覆盖 `linux` 平台的通用条目；现在额外要求源码构建的 node-pty 二进制 `node_modules/node-pty/build/Release/pty.node`。与 Windows、macOS 不同，node-pty 不提供 `linux-x64` 预编译产物，且其加载器会优先检查 `build/Release/pty.node`，因此 Linux 安装包必须携带 `yarn install` 时构建出的二进制（根 `dependenciesMeta` 中 `node-pty` 为 `built: true`）。`spawn-helper` 仅在 macOS 构建，Linux 不需要。

Electron Builder 通过专用匹配器复制 `node_modules`，该匹配器只应用 `!` 排除模式，因此正向 `files` 模式无法恢复被排除的文件。全局 `files` 列表因此不再排除 `node_modules/node-pty/build/**`；该 `!` 排除移入 `mac.files` 与 `win.files` 平台块。Windows 与 macOS 保持与此前完全一致的行为（它们加载 node-pty 预编译产物，且宿主架构构建产物不会进入 universal macOS gate），而 Linux 会携带其加载器所需的源码构建二进制。koffi、sharp 与 node-addon-require-builtin 通过各自的 linux-x64 可选依赖随常规安装解析，为避免猜测包内布局而未加入闭包清单。

包还设置了顶层 `desktopName`（`DSH Desktop`）与 `build.linux.syncDesktopName: true`，使 Electron 的 WM_CLASS 与 `.desktop` 条目的 `StartupWMClass` 一致，让桌面环境能把运行中的窗口正确归入启动器图标。这同时消除了 Electron Builder 针对 deb 目标输出的 `desktopName` 警告。

## 备选方案

**改用 AppImage。** AppImage 免安装，但对 Debian/Ubuntu 用户不够原生，且多一个产物与 gate。用户将本次范围限定为仅 deb；AppImage、rpm、snap 留作后续。

**仅依赖 `yarn package:dir`。** 解压目录是可行的运行方式，会继续在文档中说明，但它不是一键安装，也没有桌面入口或包管理器集成。

**对 deb 签名。** Electron Builder 的 deb 签名（debsigs）需要仅用于发布的安全凭证；与 Windows 安装包、macOS smoke 一致，deb 保持未签名并在文档中说明。

## 影响

Debian/Ubuntu 用户可用 `sudo dpkg -i DSH-Desktop-<version>-amd64.deb` 安装，并从应用菜单启动 `dsh-desktop`；`dist/linux/linux-unpacked/dsh-desktop` 解压目录仍可作为免安装的运行方式。`package-linux.spec.ts` 与 `verify-linux-package.spec.ts` 断言了精确的命令序列与产物校验，CI 的 `desktop-linux` 任务在主 ubuntu runner 上构建 deb，使打包回归在发布前即可被发现。产物仅 amd64，与 Windows x64 安装包对齐；arm64 与其他打包格式是后续工作。
