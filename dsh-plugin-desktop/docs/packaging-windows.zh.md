# DSH Desktop Windows 安装包打包流程

本文档描述如何把本仓库（`deepseek-harness-desktop`，v2 桌面版）的代码完整打包成一个
Windows x64 NSIS 安装包。流程已在原生 Windows 主机上实跑验证（Node 22.22.2 /
Corepack / Yarn 4.18.0），结论：**`corepack yarn dist:win` 一条命令即可产出可安装的
未签名安装包**，构建、测试、打包、校验全程无头安全（不启动图形界面）。

> 配套英文文档：[packaging-windows.md](packaging-windows.md)。

---

## 1. 目标产物

| 产物 | 路径（相对仓库根） | 说明 |
| --- | --- | --- |
| NSIS 安装包 | `dsh-plugin-desktop/dist/DSH-Desktop-<version>-x64-Setup.exe` | 约 140 MB，向导式（可选目录、开始菜单/桌面快捷方式），**未签名** |
| 解包应用 | `dsh-plugin-desktop/dist/win-unpacked/DSH Desktop.exe` | 冒烟测试用，不由安装器生成 |
| 更新元数据 | `dsh-plugin-desktop/dist/DSH-Desktop-<version>-x64-Setup.exe.blockmap`、`dist/latest.yml` | 应用内更新通道使用（含 sha512/size/版本号） |

`<version>` 来自 `dsh-plugin-desktop/package.json` 的 `version` 字段（当前 `2.0.0`）。

---

## 2. 前置条件

- **原生 Windows x64 主机**。`dist:win` 在非 Windows / 非 x64 主机上会直接拒绝执行
  （`scripts/package-win.ts` 的前置校验）。
- **Node.js 22.19+ 或 24.x**（官方发行版自带 Corepack）。CI 与 README 推荐 `22.23.2`。
- **Git**（检出含子模块的仓库）。
- **网络**：npm registry 可达。Electron 43.4.0 zip 与 NSIS 构建工具会优先命中本机缓存
  （`%LOCALAPPDATA%\electron\Cache`、`%LOCALAPPDATA%\electron-builder\Cache`、
  Yarn 缓存），GitHub 直连受限时只要缓存齐全也可完成打包（本机已验证）。
- **不需要** Python 或 Visual Studio C++ Build Tools：Windows 打包使用 node-pty 的
  x64 预编译 Node-API 二进制，electron-builder 以 `npmRebuild=false` 跳过原生重建。

---

## 3. 打包步骤（全新检出）

```powershell
# 1) 检出（含子模块；deepseek-harness 是 pinned upstream，打包阶段不会构建它）
git clone --recurse-submodules <仓库URL>
cd deepseek-harness-desktop

# 2) 安装工作区依赖（dsh-plugin-desktop 是唯一的 Yarn workspace）
corepack yarn install

# 3) 打包（含全部门禁 + electron-builder + 产物校验）
corepack yarn dist:win
```

`dist:win` 内部按顺序执行三段（对应 `scripts/package-win.ts`）：

1. **门禁** `corepack yarn workspace dsh-plugin-desktop check:win-package`
   - `build`：生成图标资源 → 清理 → tsdown 打包 `lib/**` → 两套 tsconfig 声明文件。
   - `typecheck`：四套 tsconfig（主/客户端/测试/客户端测试）`--noEmit`。
   - Windows 专项 vitest：`package`、`package-win`、`update-checker`、
     `update-download`、`verify-win-installer`、`verify-packaged-runtime`、
     `windows-pwsh-sandbox`、`window-options` 共 8 个文件（实跑：101 passed /
     1 skipped），全部 mock/回环，无外部网络依赖。
   - `verify:closure`：运行时闭包校验（实跑：197 个 first-party 节点闭包完整）。
2. **electron-builder** `--win nsis --x64 --publish never --config.win.signExecutable=false --config.npmRebuild=false`
   - `afterPack` 钩子 `scripts/verify-packaged-runtime.ts` 校验 `app.asar` 必需条目
     （`lib/main.js`、`@deepseek-ai/dsh` CLI 引导、`dsh-web-frontend/dist/index.html`、
     捆绑 `pnpm` 等）与 `app.asar.unpacked` 物理条目（含
     `node_modules/node-pty/prebuilds/win32-x64/*` 与 `pnpm/bin/pnpm.mjs`）。
   - 应用 `@electron/fuses`，写入 asar 完整性资源。
3. **产物校验** `scripts/verify-win-installer.ts`：对安装包与解包 exe 校验
   Windows PE 头（MZ 魔数 + PE 签名），通过后打印
   `Windows installer verification passed: ...`。

任一环节失败即中止，退出码非 0。

---

## 4. 常见问题与陷阱

### 4.1 electron postinstall 被跳过（陈旧 install-state）
现象：`yarn install` 成功但
`dsh-plugin-desktop/node_modules/electron/dist/electron.exe` 不存在（`path.txt` 缺失），
`electron-builder` 阶段会重新下载或失败。

原因：`.yarn/install-state.gz`（项目根 `.yarn` 目录）残留了旧的"已构建"记录，
yarn 跳过 electron/esbuild 的后置脚本（node-pty、koffi 等仍会重建）。

修复（任选其一）：
```powershell
# 方案 A：删除陈旧状态后重装
Remove-Item .yarn\install-state.gz -Force
corepack yarn install

# 方案 B：手动执行 electron 的安装脚本（zip 已在本机缓存，无需网络）
& node "dsh-plugin-desktop\node_modules\electron\install.js"
# 验证
Test-Path "dsh-plugin-desktop\node_modules\electron\dist\electron.exe"
```
全新检出（无 `.yarn` 残留）不会遇到此问题。

### 4.2 产物是未签名安装包（设计如此）
`dist:win` 会剥离 `CSC_*` / `WIN_CSC_*` 证书环境变量并设 `signExecutable=false`。
安装包可正常安装运行，但 Windows 可能提示"未知发布者"/SmartScreen 警告。
**Authenticode 签名、SmartScreen 信誉、升级/卸载测试、native UI/sandbox 冒烟
属于发布阶段的门禁，不属于本地打包流程。**

### 4.3 版本号
产物文件名与 `latest.yml` 的 `version` 均取自 `dsh-plugin-desktop/package.json` 的
`version`。每次发布新版本前先修改该字段。注意：
- 包的 `version` 与产品内嵌的更新检查（`deepseek-harness-desktop:release:version`）
  相互独立；
- 发布更新时需先上传 Windows 与 macOS 两份产物，再在 Upstash Redis 设置
  `deepseek-harness-desktop:release:version` 为规范稳定版本号，客户端才会提示更新。

### 4.4 PowerShell 重定向与退出码
`corepack yarn dist:win 2>&1 | Out-String` 会把原生 stderr 包装成错误记录，
可能造成"流程成功但退出码显示 1"的假象。判断成败请：
```powershell
corepack yarn dist:win *> "$env:TEMP\dsh-dist-win.log"; $LASTEXITCODE
# 期望输出：0
```
以 `$LASTEXITCODE` 与产物文件的存在为准，不要以管道包装后的 exit code 为准。

### 4.5 子模块与打包的关系
`deepseek-harness/` 为 pinned upstream submodule，**打包流程不构建它**；桌面包的
`@deepseek-ai/*` 依赖全部来自 npm registry（`0.1.0-rc.6` 家族）。仅当需要
`upstream:install`/`upstream:build`（上游开发）时才进入子模块使用其 pnpm workspace。

### 4.6 升级检测机制：新版安装包能否识别旧安装并覆盖升级？——能
结论：**只要 `build.appId` 不变，任何后续版本的安装包都会识别已安装的 DSH Desktop，
并原地升级它（保留安装目录与用户数据）。** 这是 electron-builder NSIS 的确定性行为，
机制如下（已在本仓库实跑 + 本机注册表双重验证）：

1. **决定性 GUID**：安装器 GUID = `UUID.v5(appId, "50e065bc-3134-11e6-9bab-38c9862bdaf3")`，
   与版本无关、完全确定。本仓库 `appId = ai.deepseek.dsh.desktop` →
   GUID 恒为 `85820364-4c28-594e-b046-8896b3669248`（已用 Node 复算验证）。
2. **旧安装的位置记录**：安装时 electron-builder 把 `InstallLocation`、`ShortcutName`
   写入 `HKCU\Software\<APP_GUID>`（per-user）或 HKLM 对应键，同时写标准卸载项
   `HKCU/HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>`。
   本机已安装的 2.0.0 位于 `HKCU:\Software\85820364-4c28-594e-b046-8896b3669248`
   （`InstallLocation = D:\DeepseekharnessDesktop\DSH Desktop`）。
3. **新版安装器动作**：`assistedInstaller.nsh` 读取同一 GUID 键下的 `InstallLocation`
   预选旧目录；`installUtil.nsh` 读取旧 `UninstallString` 先运行旧卸载器；随后
   新文件原地写入。`DisplayVersion`/快捷方式随之更新。
4. **应用内更新交接**：`src/electron-runtime.ts` 以 `--updated --force-run` 启动下载的
   新安装包（生成脚本里对应的 `isUpdated`/`isForceRun` 宏已内建于 NSIS 模板）；
   应用先请求有序关闭再退出，由安装器接管更新，成功后重新拉起。
5. **用户数据不动**：用户数据在 `%APPDATA%\DSH Desktop`（不在安装目录），升级与卸载
   均不触碰（README 声明卸载时保留用户数据，本机 `%APPDATA%\DSH Desktop` 已存在）。

**红线（不可违反，否则升级会断裂）**：
- `build.appId` 永远不能改（electron-builder 文档明确警告改 appId 会破坏现有安装的
  静默升级）；
- 保持 `productName = "DSH Desktop"` 与 `shortcutName` 稳定；
- 发布新版本时 `version` 必须递增（应用内更新器只接受规范且更新的稳定版本号）。

---

## 5. 代码更新后的打包 SOP（供后续 Agent 照此执行）

1. **同步代码**
   ```powershell
   git pull
   git submodule update --init --recursive   # 若子模块 pin 有变更
   ```
2. **同步依赖**（锁文件未变时建议 `--immutable`）
   ```powershell
   corepack yarn install --immutable   # 锁文件需更新时去掉 --immutable
   ```
   若上一步失败或 electron 二进制缺失，按 §4.1 处理。
3. **确认/提升版本号**（发布场景）
   编辑 `dsh-plugin-desktop/package.json` 的 `version`，并保持
   `CHANGELOG`/发布说明同步。
4. **执行打包**
   ```powershell
   corepack yarn dist:win
   ```
   等待三段流水线（门禁 → electron-builder → 产物校验）全部通过。
5. **核对产物**
   - `dsh-plugin-desktop/dist/DSH-Desktop-<version>-x64-Setup.exe` 存在，大小约 140 MB；
   - `dist/win-unpacked/DSH Desktop.exe` 存在；
   - `dist/latest.yml` 中 `version` 与 `size` 与本次一致；
   - 流水线末尾打印 `Windows installer verification passed`。
6. **（发布阶段，非本地步骤）** 签名 → 上传 Windows/macOS 产物与下载重定向 →
   设置 `deepseek-harness-desktop:release:version` → 在真机做安装/升级/卸载与
   native UI/sandbox 冒烟。

> 约束提醒：构建、测试、打包全程不得启动图形界面（保持无头安全）；GUI 冒烟必须
> 显式进行并在人工/独立环节完成。