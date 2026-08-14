# DeepSeek Harness 桌面端

[English](README.md) | 中文

桌面应用负责监管现有的回环 Web Host；窗口关闭后，系统托盘继续持有 Host 的生命周期。

## 开发

安装依赖后，使用单一桌面开发命令。该命令会先构建 Host 与客户端包、Web 前端和 Electron main 进程，再启动应用：

```sh
pnpm run dev:desktop
```

关闭窗口会隐藏窗口。通过托盘菜单恢复窗口或退出应用。显式退出会等待 Host 进程停止，并在 Host 的有界宽限期结束后升级终止行为。

桌面应用只接受 `dsh web` 为 `127.0.0.1` 或 `localhost` 输出的就绪 URL。页面导航限制在该来源；HTTP 和 HTTPS 链接交给系统浏览器打开。

页面缩放由桌面壳负责。按住 `Ctrl`/`Command` 后按 `+` 或 `=` 放大、按 `-` 缩小、按 `0` 恢复为 100%；可用范围保持在约 58% 至 299% 之间。每个新加载的桌面窗口都从 100% 开始，不继承 Chromium 按同源保存的缩放状态。

原生窗口外观按宿主平台区分。macOS 使用无边框内嵌标题栏、交通灯和侧栏 vibrancy；收起侧栏宽 90px，其中的控件水平居中，最上方控件在交通灯下方与展开态 logo 行对齐。Windows 保留系统边框、阴影、缩放与 Snap 行为以及 Windows 11 圆角，同时用隐藏标题栏把原生窗口按钮放入 Session header 首行；Windows 侧栏不预留交通灯区域。该行的空白部分可拖动，控件仍可点击；没有 Session header 时，常驻拖拽带覆盖同一行。Windows acrylic 和 macOS vibrancy 只透过侧栏，会话区与详情区保持不透明。Linux 使用无边框窗口和不透明侧栏降级样式。

## 打包

本地打包命令会执行完整的仓库构建，为 Host 暂存封闭的生产依赖树，并为当前平台生成未封装应用。无需另行手动构建：

```sh
pnpm run package:desktop
```

打包后的应用通过 Electron 的 Node 模式，在独立进程内运行已暂存的 `@deepseek-ai/dsh` CLI。应用因此保留受 supervisor 管理的 Host 生命周期，无需携带第二个 Node 可执行文件。如果暂存的 CLI 入口或 Web 前端入口缺失，`afterPack` 检查会在签名前拒绝该产物。macOS 和 Windows 都使用受跟踪的 `apps/desktop/build/icon.png` 原始文件；仓库不预处理图标，也不提交平台专用图标变体。

### 已签名的 macOS DMG

macOS 发布命令要求构建用户的 Keychain 中安装有效的 `Developer ID Application` 身份，且证书与私钥必须同时存在。它还需要一组完整的公证凭据。Keychain profile 可以避免应用专用密码进入仓库或 shell 历史记录：

```sh
xcrun notarytool store-credentials "dsh-notary" --apple-id "<Apple ID>" --team-id "<Team ID>"
```

`notarytool` 会交互式请求秘密。使用已存储的 profile 构建已签名、开启 hardened runtime 且已公证的 DMG：

```sh
APPLE_KEYCHAIN_PROFILE=dsh-notary pnpm run dist:mac:desktop
```

现有秘密文件可以提供 `MAC_CERT_P12_BASE64`、`MACOS_SIGN_IDENTITY`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`，无需把证书导入持久 Keychain：

```sh
node --env-file=/absolute/path/to/macos-signing-secrets.env --import tsx apps/desktop/scripts/release-mac.ts
```

Electron Builder 会把该 Base64 PKCS#12 证书导入临时 Keychain，并在构建结束时删除。wrapper 不会把签名和公证变量传给仓库构建与运行时暂存子进程，只会将其传给 Electron Builder。秘密文件及其路径都不会受版本控制。

发布预检查会在仓库构建前运行。如果宿主不是 macOS、所提供身份不是 `Developer ID Application` 身份、签名凭据不完整、签名发现被禁用，或公证凭据缺失或不完整，预检查都会失败。未提供 PKCS#12 凭据组时，Keychain 中必须存在带私钥的可用 `Developer ID Application` 身份。除 Keychain profile 外，该命令也接受完整的 Apple ID 凭据组（`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID`），或 App Store Connect API 密钥组（`APPLE_API_KEY`、`APPLE_API_KEY_ID` 和 `APPLE_API_ISSUER`）。

构建成功后，挂载生成的 DMG，再验证其中应用的签名、Gatekeeper 评估和已装订的公证票据：

```sh
DMG_PATH="$(find apps/desktop/dist -maxdepth 1 -type f -name '*.dmg' -print -quit)"
MOUNT_POINT="$(mktemp -d)"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly
APP_PATH="$MOUNT_POINT/DeepSeek Harness.app"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
hdiutil detach "$MOUNT_POINT"
rmdir "$MOUNT_POINT"
```

## 已知限制

首个桌面装配使用回环 HTTP Host。renderer 和 Host 协议保持不变，因此后续可替换为 GUI 架构预留的 IPC carrier，而无需改动产品功能。

已签名安装包的发布路径目前只面向 macOS。Windows 和 Linux 打包会生成未封装应用；它们的安装包格式与发布签名仍属于发布工作。

## 模型体验

桌面壳不会增加模型可见输入。复用的 Web profile 继续持有现有的 Web 运行时上下文。
