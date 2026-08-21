# Agent Note：Linux 安装包打包

状态：已实现

[English](2026-08-17-linux-installer-packaging.md) | 中文

## 决策

`dsh-plugin-desktop/scripts/package-linux.ts` 为 DSH Desktop 提供 `yarn dist:linux` 命令，一次性产出 Linux x64 的 deb、rpm 与 AppImage 三种安装包，形状对齐 `package-win.ts` 与 `package-mac.ts`：它会拒绝非 Linux 宿主、非 x64 架构，以及除 22.19+ 或 24.x 之外的其他 Node 版本；先执行 `check:linux-package`（build、全部 TypeScript compiler face、打包与运行时相关的测试文件，以及 runtime-closure verifier）；再一次性调用 Electron Builder 的 `--linux deb rpm AppImage --x64`；最后通过 `verify-linux-installer.ts` 校验全部四个产物路径及其文件格式魔数。选择用单脚本覆盖三个目标，而不是拆成三个按格式划分的子脚本，是因为无论一次 CLI 调用请求多少个 Linux 目标，Electron Builder 内部都只会 pack 一次 `linux-unpacked`；三个子脚本会各自重复这同一次 pack 步骤，而且某个子脚本若静默产出少于自身目标数量的产物，也不会被另外两个子脚本发现。一个"要么产出全部三个已验证产物，要么直接抛错"的命令是 fail-loud 的；三个各自可能部分成功的命令则不是。

Linux 打包不会碰 `dsh-plugin-desktop/src/` 下任何文件。三处按平台限制 desktop 专属能力的逻辑在本次工作之前就已存在，且无需改动：打包终端插件已在 `cordis.patch.yml` 中被 `disabled: !!js process.platform === 'linux'` 禁用；高级模式的 shell 组合已在 `src/index.ts` 中显式拒绝 Linux；更新流程已经通过 `src/electron-runtime.ts` / `src/updates.ts` 中现有的 `canDownload` 检查降级为"有新版本，但本构建不提供下载"的提示。因此 Linux 安装包支持只是打包层的改动——`build.linux` 目标、图标集、打包脚本、校验器、CI job 与 Docker 工具集——没有引入任何新的运行时代码路径。

## Electron Builder 配置

- **`toolsets.appimage: "1.0.3"`。** Electron Builder 默认的 AppImage 路径会下载 FUSE2 静态运行时，其 AppRun 会无条件注入 `--no-sandbox`，并要求用户在不再预装 `libfuse2` 的较新发行版上自行安装它。Electron Builder 自身的 schema 说明把 `"1.0.3"` 归在 `Betas:` 分组下，官方文档给出的默认值仍是 `"0.0.0"`（旧版 FUSE2 路径）——这是刻意选用的非默认、官方标注为 beta 的工具集，而非疏忽。设置 `toolsets.appimage: "1.0.3"` 会改选静态（非 FUSE2）运行时，与 Electron Builder v27 的默认方向一致。该 schema 只接受 `"0.0.0" | "1.0.2" | "1.0.3" | null`；部分 Electron Builder v27 文档提到的 `"1.1.0"` 并非合法值，打包开始前就会被 Ajv 校验拒绝。经确认，仓库钉定的 `electron-builder` 在后续一次 rebase 中从 26.15.3 升到 26.15.7 时，这个 schema（枚举值、`"0.0.0"` 默认值、`Betas:` 分组）保持不变。
- **图标集是止步于 512×512 的 `build/icons/` 目录，而不是单张 1024px 源图。** Electron Builder 的单文件图标路径不做任何缩放——它读取 PNG 的真实尺寸并生成一条对应该尺寸的 `IconInfo`，随后 `FpmTarget` 会把它映射为 `/usr/share/icons/hicolor/<size>x<size>/apps/<executableName>.png`。freedesktop 的 hicolor `index.theme` 只声明到 `512x512` 的目录；声明集之外的尺寸不会被符合规范的图标主题查找（GTK `IconTheme`、`gtk-update-icon-cache`）枚举到。因此单张 1024px PNG 会装进未声明的 `1024x1024` 目录，导致 deb/rpm 装完后 `.desktop` 的 `Icon=dsh-desktop` 无法解析。`scripts/generate-linux-icons.mjs` 会从 Windows 使用的同一份 `build/app-icon.png` 源图，派生出 N ∈ {16, 24, 32, 48, 64, 96, 128, 256, 512} 的 `build/icons/<N>x<N>.png`。AppImage 不受这个上限影响，因为它的桌面集成读的是 `.DirIcon` 与 `<executableName>.png`——`appLauncher.copyIcons` 会把它们直接软链到 AppDir 根目录下最大的可用图标，不经过 hicolor 查找。
- **三份 `artifactName` 都是字面量字符串，而非 `${arch}`。** 当目标架构等于默认架构（x64）且用户未强制要求写架构名时，`expandArtifactNamePattern` 会把 arch 宏整体剥除。`deb` 与 `rpm` 目标内部带有 `isUseArchIfX64 = true` 的兜底逻辑，会把 arch 段重新加回去，但 AppImage 没有等价的兜底——它的默认名会解析成 `DSH Desktop-<version>.AppImage`，带一个字面空格且没有架构标记。把三个名字都写成字面量绕开了这个不一致，也让 `verify-linux-installer.ts` 可以像 `verify-win-installer.ts` 校验 NSIS 安装包那样，断言三条确定、可预测的路径。
- **`linux.executableName` 必须显式给出。** 该字段缺省时，`LinuxPackager` 会回退到 `appInfo.sanitizedName.toLowerCase()`，其结果是 `dsh-plugin-desktop`（npm 包名），而不是产品其余部分已经在使用的 `dsh-desktop` 命令名。该字段只作用于 Linux，不影响 Windows 或 macOS 的可执行文件名；它同时决定 `/usr/bin` 软链名、安装后的图标文件名，以及 `.desktop` 文件的 `Icon=` 值，因此必须与 `dsh-desktop` 一致，这三处才能相互吻合。

## CI 与 Docker 工具集

CI job（`.github/workflows/ci.yml` 里的 `desktop-linux`）把 `runs-on` 钉在 `ubuntu-24.04`，而不是 `ubuntu-latest`——这是本仓库第一个钉版本的 job；其余 job 仍然浮动在 `*-latest` 上。`ubuntu-24.04` 镜像预装了 apt 的 `rpm` 包（`rpm 4.18.2`），提供了 rpm 目标的硬性宿主依赖 `/usr/bin/rpmbuild`。`ubuntu-latest` 未来会解析到的 `ubuntu-26.04` 镜像带的是 `rpm 6.x`，与 Electron Builder 在打包时下载的 `fpm 1.17.0` 二进制的组合未经验证；钉版本避免了 GitHub 把 `latest` 标签往前滚动时静默继承这个风险。

`docker/linux-package/` 存在的理由有两条，都是 CI 不需要面对的。第一，开发机是基于 Debian 的系统，没装 `rpmbuild`，本地打包要么一次性 `sudo apt-get install rpm`，要么用一个隔离的、可丢弃的构建环境。第二，rpm 的真实安装行为——依赖解析、文件布局、图标路径、包元数据——在没有 rpm 系发行版的情况下，开发机完全无法检查；打包期的校验器只能确认产物自身的文件格式，而不能确认系统安装它之后会发生什么。该工具集的三个 Compose service 分别覆盖这两类需求：`package` 在一个 Node 版本与 CI 一致的 Debian 12 容器里构建全部三个产物；`verify-deb` 把构建好的 deb 装进一个干净的 `ubuntu:24.04` 容器并断言安装后的布局；`verify-rpm` 把构建好的 rpm 装进 `fedora:latest` 容器做同样的事。CI 刻意不为自己的构建采用这个容器：`ubuntu-24.04` runner 本身已经预装了 `rpmbuild`，容器化就意味着每次运行都要在容器镜像里装 `rpm` 与原生构建工具链（`build-essential`、`python3`）——这恰恰会使钉 `ubuntu-24.04` 的理由本身失效，还会白白增加 CI 耗时。

## 实测确认的行为（Task 7）

安装级验证针对的是真实发行版，而不只是打包期的产物格式检查：

- **deb（Ubuntu 24.04，`docker compose run --rm verify-deb`，退出码 0）。** fpm/dpkg 的包名是 `dsh-plugin-desktop`（由 `package.json` 的 `name` 字段派生），与 `dsh-desktop` 这个可执行文件名（`linux.executableName`）是两回事。安装后 `/usr/share/applications/dsh-desktop.desktop` 的内容为：
  ```
  [Desktop Entry]
  Name=DSH Desktop
  Exec="/opt/DSH Desktop/dsh-desktop" %U
  Terminal=false
  Type=Application
  Icon=dsh-desktop
  StartupWMClass=DSH Desktop
  Comment=DSH Desktop: an Electron shell composed as a DeepSeek Harness Cordis plugin
  Categories=Development;
  ```
  `StartupWMClass=DSH Desktop` 是 Electron Builder 自动生成的，不是我们显式配置的。应用装在 `/opt/DSH Desktop/` 下——空格是真实存在、已确认、被接受的行为（见"已知限制"）——`/usr/bin/dsh-desktop` 是一条符号链接，已通过 `update-alternatives` 确认。这次运行中观察到 `chrome-sandbox` 的权限是 `4755`（`-rwsr-xr-x`），原因是容器自身的 `unshare -Ur true` userns 探针失败了（`unshare: unshare failed: Operation not permitted`），deb 的 postinst 脚本因此把它 chmod 成了 SUID 兜底路径。`dpkg-query -W -f='${Package} ${Maintainer}\n'` 打印出 `dsh-plugin-desktop anywhere-labs <anywhere-labs@users.noreply.github.com>`，逐字匹配。
- **rpm（Fedora 44，`docker compose run --rm verify-rpm`，退出码 0）。** `fedora:latest` 标签在测试时解析到的是 `Fedora release 44 (Forty Four)`。`rpm -qpi` 显示 `Packager` 与 `Vendor` 都精确等于 `anywhere-labs <anywhere-labs@users.noreply.github.com>`。`dnf install -y ./*.rpm` 解析并安装了完整依赖树，零缺失、零无法解析的包——这是一个真实的、正面的确认：本轮沿用 Electron Builder 默认 `depends` 列表（而非覆盖它）的决策，在这个目标环境下是站得住的。安装布局与 deb 一致：`/opt/DSH Desktop/dsh-desktop`、`/usr/bin/dsh-desktop` 符号链接、图标位于 `/usr/share/icons/hicolor/512x512/apps/dsh-desktop.png`，没有 `1024x1024` 条目。
- **AppImage（开发机上真实的图形会话，不是容器——容器既没有 FUSE 也没有显示）。** `chmod +x` 后直接执行，成功启动，且 renderer 进程的命令行中带有 `--enable-sandbox`：真正的 Chromium 沙箱在这台宿主上是启用的，因为这台宿主的 ambient 会话实际上允许非特权用户命名空间——尽管另一个刻意隔离运行的 `aa-exec -p unconfined -- unshare -Ur true` 探针（独立运行，不在 AppImage 自身的进程树里）在同一台宿主上返回了退出码 1。两条代码路径都已确认是可靠的——静态运行时默认不注入 `--no-sandbox`，AppRun 的兜底探针只在 userns 确实不可用时才补上 `--no-sandbox`——这台宿主只是恰好落进了"沙箱可用"这一支，而不是兜底那一支；两支都能产出可用的启动。应用自己的日志文件（`~/.config/DSH Desktop/logs/dsh-<date>.log`）写入了预期的启动头行，Session Storage 也显示出针对 loopback web server 持久化的真实 workspace-view 状态，确认 UI 确实渲染并初始化了一个 workspace，而不只是存在一个 Electron 壳进程。该进程稳定运行 40 秒以上没有崩溃，退出时也没有残留的 FUSE 挂载。

## 已知限制

- `/opt/DSH Desktop` 带有一个字面空格。该路径由 `sanitizedProductName` 决定，Electron Builder 26.x 未开放安装前缀选项。`.desktop` 的 `Exec` 行会被正确加引号，功能正常，但不符合 Debian 惯常的路径习惯。要改变它就意味着改动 `productName`，而这同时会影响 macOS 与 Windows 的命名，是一次超出本轮范围的破坏性变更。
- deb/rpm 的 `depends` 使用 Electron Builder 自身的默认值，而非覆盖值。覆盖任一列表都会替换掉整个默认集合，而不是在其基础上追加，这会让本包永久性地负责手动追踪 Electron Builder 自己的依赖列表。默认集合的传递闭包缺少 `libasound2`、`libgbm1`、`libdrm2`、`libgl1`；普通桌面环境已经预装了它们，极简系统或容器镜像则没有。
- Linux 打包需要联网。Electron Builder 会在打包时下载 `fpm@2.1.4`（内含 fpm 1.17.0 与一份便携版 Ruby）、AppImage 工具集，以及 `7zip@1.0.0`；不预先配置 `ELECTRON_BUILDER_BINARIES_MIRROR` / `CUSTOM_FPM_PATH`，就没有完全离线的构建路径。
- 容器无法完成 AppImage 的图形界面启动测试。挂载 AppImage 需要 FUSE，容器内不可用，而且容器也没有显示可供启动窗口。`docker/linux-package` 的 `verify-deb` 与 `verify-rpm` 两个 service 只覆盖这两种格式的安装级验证；AppImage 真正的图形界面启动，如上文所述，只在裸机宿主上做了验证。
