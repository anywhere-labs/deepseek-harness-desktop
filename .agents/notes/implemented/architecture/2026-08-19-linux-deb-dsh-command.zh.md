# Agent Note：Linux 安装包同步安装 `dsh` 命令

状态：implemented

[English](2026-08-19-linux-deb-dsh-command.md) | 中文

## 问题

安装 deb（或 rpm）后，桌面应用从 `/opt/DSH Desktop/dsh-desktop` 与 `.desktop` 条目启动，但终端执行 `dsh` 会报"找不到命令"——shell 甚至会建议安装毫不相关的 Debian `dsh`（dancer's-shell）包。桌面端在 Windows（`desktop-runtime-environment.ts` → `windowsDshShim`）与 DSH Terminal（`desktop-terminal.ts`）中都已提供规范 `dsh` 命令，但 Linux 系统安装包没有暴露对等物。

## 决策

deb 与 rpm（共用同一套 fpm 脚本）现在安装系统级 `/usr/bin/dsh` 命令。它是应用目录内 `/opt/DSH Desktop/dsh` 自定位 shim 的符号链接，通过打包的 Electron 二进制以 Node 模式分发捆绑的 DeepSeek Harness CLI（`@deepseek-ai/dsh/lib/bin.js`）——与 Windows shim 和 DSH Terminal 使用相同的 RunAsNode 契约：

```sh
ELECTRON_RUN_AS_NODE=1 /opt/DSH\ Desktop/dsh-desktop \
  --expose-internals /opt/DSH\ Desktop/resources/app.asar/lib/desktop-cli.js "$@"
```

`desktop-cli.js`（`src/desktop-cli.ts`）在导入上游 CLI 前清除 `ELECTRON_RUN_AS_NODE`，仅在调用方提供 `DSH_DESKTOP_DEFAULT_PROFILE` 时应用 terminal 拥有的默认 profile，其余情况保持普通 `dsh` 行为（`--version`、`plugin`、`web` 等）。`scripts/verify-cli-runtime.mjs` 已针对 dev tree 演练该分发。

### 接线

- `build/linux/dsh` — POSIX shim，用 `readlink -f "$0"` 解析自身所在目录，因此与安装前缀无关，无需构建期路径插值。它会先把应用内 `bin/` 目录前置到 `PATH`，再以 Node 模式通过打包的 Electron 运行时分发捆绑的 DeepSeek Harness CLI。
- `build/linux/bin/pnpm` / `build/linux/bin/node` / `build/linux/bin/clear-env.mjs` — 自定位 POSIX shim（外加清除 RunAsNode 的预加载器），为 `dsh` 进程树提供捆绑的 pnpm 与 Node，镜像桌面生成的 pnpm 运行时（`desktop-runtime-environment.ts`）。`dsh plugin` 会向 `PATH` 上的 `pnpm` 转发，因此打包的 pnpm（`resources/app.asar.unpacked/node_modules/pnpm`）通过打包的 Electron 二进制运行，并带有 Electron 原生构建设置（`npm_config_runtime/target/disturl`，electron 版本运行时解析）。pnpm 11 默认 `strictDepBuilds: true`，会把任何带有未批准构建脚本的依赖（node-pty、ssh2 等）变成安装硬失败。由于 `dsh plugin` 以 profile 目录为 `cwd` 运行 pnpm，pnpm shim（仅在打包 dsh 上下文、由 `DSH_DESKTOP_DSH_CONTEXT` 标记）会在 profile 的 `pnpm-workspace.yaml` 缺少 `strictDepBuilds` 时追加 `strictDepBuilds: false`，使插件安装顺利完成，被拦的原生构建仍通过 `pnpm approve-builds` 选择启用。用户显式设置的值不会被覆盖。
- `build/linux/after-install.tpl` / `after-remove.tpl` — 固定版本 Electron Builder 26.15.7 Linux 模板的副本（launcher 符号链接 / update-alternatives、chrome-sandbox 权限、mime/desktop 数据库刷新、AppArmor profile），外加创建/删除 `/usr/bin/dsh` 符号链接的代码块。模板由 Electron Builder 的 `writeConfigFile` 渲染（`${executable}`、`${sanitizedProductName}`）。
- `package.json` 的 `build.linux` 设置 `afterInstall`、`afterRemove`，并配置 `extraFiles` 把 `build/linux/dsh` 放到应用根目录、把 `build/linux/bin` 放到 `/opt/DSH Desktop/bin`，使 shim 由 dpkg/rpm 持有（卸载时删除）；只有 `/usr/bin/dsh` 符号链接由 maintainer 脚本维护。
- `scripts/verify-linux-package.ts` 现在额外校验 `linux-unpacked/dsh`（分发到 `desktop-cli.js` 并前置 `APP_DIR/bin`）与 `linux-unpacked/bin/pnpm`（分发到捆绑的 `pnpm.mjs`，`assertExecutableScript`），`tests/verify-linux-package.spec.ts` 覆盖缺失/不可执行/过时场景。

## 备选方案

**通过 `linux.fpm` 源映射打包真实的 `/usr/bin/dsh` 文件。** 这样无需 maintainer 脚本即可让 dpkg/rpm 持有该命令，但 shim 无法再从 `$0` 自定位（其 `dirname` 将是 `/usr/bin`），只能构建期硬编码 `/opt/DSH Desktop/` 路径。post-install 符号链接方案让 shim 保持自定位，并沿用 Electron Builder 安装 `dsh-desktop` 的既有方式。

## 影响

`sudo dpkg -i DSH-Desktop-<version>-amd64.deb`（或 `rpm -i`）后，任意 shell 中即可使用 `dsh`，与桌面 launcher 并存。该命令即普通 Harness CLI：默认使用调用方选择的 profile（安装时不设置 `DSH_DESKTOP_DEFAULT_PROFILE`），与上游 `dsh` 语义一致。插件管理（`dsh plugin add/remove/update`）开箱即用，因为捆绑的 pnpm 与 Node 通过应用内 `bin/` shim 暴露，无需系统安装 pnpm 或 Node。由于 shim 位于应用目录，AppImage 中同样携带，但只有系统包安装 `/usr/bin/dsh` 符号链接后才能在 shell 中直接调用。注意：与 Debian `dsh`（dancer's-shell）包共存时会遮蔽其 `/usr/bin/dsh`；产品拥有 `dsh` 名称，此冲突被接受。桌面 Host 的 PATH shim（`desktop-runtime-environment.ts`）仍仅限 Windows；Linux 依赖系统命令。
