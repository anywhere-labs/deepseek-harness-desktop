# DSH NEXT

[English](README.md) | 中文

基于 DeepSeek Harness **0.1.6-alpha.2** 的独立实验包。主窗口直接加载官方发布的 `@deepseek-ai/dsh-web-frontend`，复用官方 Web 应用、插件管理器和基本桌面样式；Next 添加系统托盘、桌面设置和工具、Profile、恢复、Agents Anywhere 手机远控、社区市场和 dshmarket。

## 开发与验证

在外层仓库根目录执行，使用 Node.js `^22.19.0` 或 `>=24.0.0`，以及 Corepack 提供的 Yarn 4.18.0：

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn check:next
corepack yarn dev:next
```

`check:next` 构建市场与 Next，执行类型检查、单元测试、官方前端与沙箱 preload 检查，以及临时目录中的真实 Host 检查，不打开图形应用。后者使用离线本地测试插件验证 pnpm、市场卸载与重启请求、鉴权、Profile 切换和恢复后启动，并清理测试进程与文件。额外的真实运行时检查覆盖原生 HTTP/WebSocket 访问限制、浏览器访问切换、损坏清单、独立安全模式、全局补丁修复与进程退出。

`dev:next` 是显式的图形启动命令；已有构建可用 `corepack yarn start:next` 启动。Electron 二进制尚未缓存时会下载。需要额外检查真实 Electron Node 模式时，先完成构建，再运行：

```sh
corepack yarn workspace dsh-desktop-next verify:host:electron
```

此检查不打开 Electron 窗口。主窗口呈现、原生对话框和真实手机连接仍需手动验收。

CI 还会在 Linux 中运行 `xvfb-run --auto-servernum corepack yarn workspace dsh-desktop-next verify:protocol --no-sandbox`。此独立测试使用真实 Electron 渲染进程、自定义协议和临时 Host，在关闭普通浏览器访问时验证市场源操作，并拒绝其他页面来源的请求。它不属于跨平台的 `check:next` 命令；关闭沙箱的参数仅用于这个隔离的 CI 进程。

同一 Linux/Xvfb 环境中的 `verify:sidebar-browser --no-sandbox` 使用同时返回 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY` 的本地测试页，验证 iframe 被拦截、凭租约挂载的真实访客页成功加载、访客自身的安全设置、应用 Cookie 与 preload 隔离、原生历史、伪造租约被拒、工作区分区隔离，以及释放后的清理。跨平台的 `verify:window-controls` 则通过模拟原生接口检查官方工具栏、分栏缩放、弹窗遮挡、标签切换与关闭，并验证普通 Web 客户端仍使用 iframe。

macOS 侧栏和标题栏回归检查会用临时数据目录，在无界面的 Chromium 中运行官方前端的 Desktop 启动分支。测试使用与 Next 相同的入口文档，通过模拟的 preload 接口提供真实 Host 注入，并断言已进入 Desktop 传输模式；随后验证选择工作区之前与创建真实空白会话之后复用同一套官方顶栏，首页及插件列表／详情页可重新展开侧栏，透明拖动区域保持固定而插件标题按原样滚动，控件滚入拖动区域后仍可点击。测试还会打开官方设置中的“桌面设置”分区，验证设置和 Profile 操作，并在没有 Host 依赖时渲染独立恢复窗口的实际构建产物。这些浏览器检查使用模拟的原生 IPC。构建后，首次安装测试浏览器并运行：

```sh
corepack yarn workspace dsh-desktop-next exec playwright install chromium
corepack yarn workspace dsh-desktop-next verify:window-controls
corepack yarn workspace dsh-desktop-next verify:onboarding
```

设置 `DSH_NEXT_TEST_BROWSER_CHANNEL=chrome` 可使用已安装的 Google Chrome。截图保存在 `dsh-desktop-next/.desktop-next/verification/`。macOS 原生窗口拖动仍需手工验证。版本限定的包补丁让无会话首页复用官方会话顶栏框架及侧栏控件。在插件列表和详情页收起侧栏后，复用官方展开按钮，固定在 macOS 红黄绿按钮右侧，位置不受内容宽度和页面滚动影响，不额外显示会话页的“新会话”按钮。插件页保留原有标题、操作栏、布局与滚动行为。在不滚动的主栏顶部设置 52px 高的透明拖动区域，覆盖顶部及两侧留白，不占布局空间、不遮挡内容。按钮、链接、输入框等交互控件排除原生拖动，滚入该区域后仍可点击。

## 应用图标资源

`build/app-icon.icon` 是可编辑的 Icon Composer 工程，保留最终 NEXT 徽标布局和 System Dark 背景。在安装了 Xcode 27 和 Icon Composer 的 Mac 上，从仓库根目录运行 `corepack yarn icons:export --channel next`，可更新 `build/app-icon.png`、Windows 使用的 `build/app-icon.ico`、原生编译生成的 `build/app-icon.icns` 和开发运行的 Dock 图标 `build/app-icon-mac.png`。这些文件需与 `build/app-icon.resources.json` 一起提交；`corepack yarn icons:check` 可在任何系统中无界面验证。

Next 的 macOS 打包与 Stable、Beta 一样，直接使用分层 `.icon` 源工程编译 `Assets.car`。PNG Dock 图标仅用于未打包的开发运行；Windows 和 Linux 窗口分别使用 ICO 与 PNG 导出资源。

## 使用

在官方主界面中打开 **设置 → 桌面设置**。顶部提示插件市场和远程控制设置已移至插件页面；点击“前往插件页面”会关闭设置弹窗，并在同一主窗口打开插件页。托盘的 **设置…** 和 `CmdOrCtrl+,` 会唤起主窗口，打开同一个官方设置弹窗，不再创建独立设置窗口。恢复和 Profile 工具保留现有窗口。Host 启动失败时，设置快捷入口会打开恢复助手。切换 Profile 会先保存选择，等待原 Host 退出后完整重启应用；更改端口仅重启 Host，两者都会中断当前任务。浏览器和局域网访问开关即时生效，无需重启。

- **托盘与后台运行：** 沿用原桌面版的常用项顺序：打开主窗口、重新加载界面、打开 DSH 终端、导出诊断、进入／退出安全模式、Profile 选择与新建。另保留桌面设置和恢复助手入口；原生菜单跟随应用内语言。开启后台运行且托盘可用时，关闭主窗口不会停止 Host 和远控连接；明确退出或重启应用时，先隐藏已有窗口，再等待 HTTPS 入口与 Host 清理完成，最后退出或重新启动应用；仅重启 Host 时保留主窗口。系统托盘不可用时，关闭主窗口会退出应用，避免留下无法重新打开的进程。
- **侧边栏浏览器：** 桌面应用复用官方浏览器工具栏，由隔离的 Electron `WebContentsView` 承载网页。GitHub 等禁止 iframe 嵌入的网站按顶层页面加载，保留 CSP 与 `X-Frame-Options`。前进、后退与地址栏跟随真实导航。视图跟随分栏尺寸和缩放，避让调整宽度的拖动区域，在弹窗或其他分栏遮挡时隐藏，并随标签关闭或渲染器退出而释放。每个标签使用临时会话，不含应用 preload、应用 Cookie、Node 接口、下载或自动授权。普通 Web 客户端继续使用官方 iframe。
- **桌面设置：** 后台运行、macOS 透明材质、本机和局域网访问、日志级别，以及用户回合完成／失败时的独立通知开关。后台任务不发送通知。沿用原桌面版的分组卡片、Profile 选择和通知开关；开关与材质即时保存。官方设置顶部提供终端和重启菜单，包含重新加载界面、重启应用和重启到恢复模式。与原桌面版保持一致，Windows 不提供材质选项，始终使用不透明窗口；旧的 Acrylic 或 Mica 偏好按关闭读取。通知还需系统授权，仅在主窗口未聚焦时显示。成功通知以本轮用户消息为标题、AI 最后一条可见回复为正文，过长内容会截断；失败通知显示通用状态，子代理和自动回合不发送通知。
- **Profile：** 首次启动和隔离的安全模式默认使用 `desktop`。已有的选择继续保留，包括此前名为 `default` 的 Profile；不会重命名或覆盖已有目录。支持新建、切换、打开目录或移除未使用的 Profile。托盘的新建入口直接聚焦名称，创建后可切换；损坏的清单或缺少 Next bundle 的 Profile 标为不可用，切换当前 Profile 不会重复重启。移除操作将文件移入恢复备份目录，当前 Profile 和 `desktop` 不可移除。Profile 分别保存插件依赖、激活列表和补丁；会话、设置和凭据仍按上游规则在同一个 Next home 内共享，不提供账号或数据隔离。
- **首次引导：** 先按桌面端自己的 Profile 完成记录或主动重新打开请求判断是否显示桌面设置。无需显示、完成或跳过后，官方 rc.2 再按账号、API Key 和官方进度独立判断是否显示账号引导；两者不代替对方完成或重置记录。原来的 Next 五步引导组件嵌入官方容器并沿用官方主题：欢迎、插件市场、远程控制、Computer Use（含现有系统权限弹窗）、恢复说明；保留原文案、插图、导航和选项。不再于 Host 启动前打开独立欢迎窗口。返回保留草稿；完成时保存 Profile 功能和 Computer Use provider，最后记录完成并重启 Host；跳过保留原配置。未完成的引导下次继续，已完成的 Profile 不自动重复，安全模式和恢复模式绕过桌面引导。“桌面设置 → 桌面工具 → 设置向导”可确认重启并带入当前配置。由于 rc.2 尚无公开的第三方引导扩展接口，兼容补丁为官方页面增加续接槽。
- **插件市场：** 新 Profile 默认不启用插件市场。官方**插件**页顶部的开关可启用或停用上次在当前页面选择的市场；没有选择记录时默认启用 `dsh-community-market`。也可直接选择 `dsh-community-market` 或 `dshmarket`。选项复用旧版桌面的名称、说明和仓库链接。选择一个市场时，官方插件管理器会在同一次操作中停用另一个，并保留已安装的插件。社区市场保留侧边栏入口；dshmarket 保留**设置 → 插件市场**入口。社区市场沿用发现、来源管理、安装预览、确认安装和卸载流程。包操作使用随应用提供的 pnpm，完成后可请求重启；macOS 和 Windows 也支持市场中的终端入口。
- **手机远控：** 在**插件**页顶部通过独立开关启用 `@agents-anywhere/dsh-bridge-next`（默认关闭）。开关左侧的齿轮打开现有手机连接弹窗，也可从侧边栏进入；启用后齿轮才可使用。AA 使用默认状态目录（`~/.agents-anywhere/dsh-bridge-next`），与 Stable/Beta 及其他 Next Profile 共享登录、设备绑定和 Connector 设置。启用状态仍按 Profile 保存；切换 Profile 会停止旧 Host 和其中的远控连接。旧版 Next 生成的逐 Profile 状态目录覆盖会在下次 Host 启动时移除。原状态目录保留，不自动合并凭据；只在旧隔离目录中登录过的用户可能需要重新登录。多个版本同时运行时，仍受 AA 的共享状态所有权检查约束。
- **桌面工具：** 打开数据、Profile 和日志目录，刷新界面，打开开发者工具，导出诊断，以及打开 macOS/Windows 终端。终端提供当前安装的 `dsh`、`pnpm` 和基于 Electron 的 `node`；应用处于安全模式时，终端仍选择原 Profile。

市场、远程控制和 Computer Use 位于普通插件列表上方，并与列表的内容宽度对齐。远程控制和 Computer Use 上下排列，设置齿轮位于各自开关左侧。两个市场和远控 bundle 不再重复显示为普通插件卡片。开关仍调用官方管理器，选择保存在当前 Profile 中；已有 Profile 如果同时开启了两个市场，会提示用户选择其中一个。两个市场安装的 bundle 插件仍在普通列表中管理，可继续启用、停用和卸载。dshmarket 自己的插件停用逻辑保持原样。旧 `desktop-next.features.json` 中的选择只迁移一次到 `package.json`，以后启动遵循官方管理器的设置。

侧边栏扩展入口复用原桌面的底部布局：多个入口纵向排列在设置上方，数量较多时在限定高度内滚动，保留工作区列表空间。

**自动化任务**位于官方“插件”分组，沿用上游插图、实验性标记、原生启用开关和组件详情。它是可选插件，默认关闭。Next 保留现有的 Schedule 选择及其旧版 Profile 迁移，不另设独立的“定时任务”卡片。

### 浏览器与局域网访问

浏览器访问默认关闭。启用本机访问后可获得经过认证的本机登录链接；启用局域网访问后，另设 HTTPS/WSS 入口，Host 仍只绑定 `127.0.0.1`。端口默认为 `0`，由系统自动分配。访问开关无需重启 Host。关闭浏览器访问也会断开已有的浏览器 WebSocket，而原生窗口连接和正在运行的任务继续保留。更改端口需要重启 Host；局域网地址在启动时读取，切换网络后需要重启。

设置页显示完整的本机登录地址，并为每个局域网地址单独显示一条 HTTPS 登录地址，包含浏览器登录 `token`。每行可以打开或复制该行的完整地址。登录链接通过校验发送方的原生 IPC 单独读取，不进入通用运行状态或诊断导出。设置页还可导出本机的公共 CA 证书。在其他设备上信任该证书前，请核对 SHA-256 指纹。登录链接可授予访问权限，只应与可信设备共享。CA 私钥由系统安全存储加密；安全存储或可用局域网地址缺失时，HTTPS 入口保持关闭，界面显示原因。原生窗口的访问凭据不会进入登录链接，局域网入口也会移除这类凭据。

### 原生权限与 Computer Use

Computer Use 旁的齿轮，以及**设置 → 桌面设置 → 授权设置**，都使用应用内授权弹窗，复用官方 Modal、Button 和 StateDot 组件。弹窗显示屏幕录制、macOS 辅助功能和麦克风的权限状态。打开弹窗时只查询权限；用户点击按钮后才请求系统授权或打开对应的系统隐私设置。macOS 系统设置中的权限变更可能需要重启应用。Windows 麦克风限制提供隐私设置入口；平台不支持的状态查询返回 `unknown`，不假定已经授权。

Next 向原生客户端插件和 Host 插件提供 Cordis 服务 `desktopPermissions`。从 `dsh-desktop-next/permissions` 导入类型，并注入 `desktopPermissions`；普通浏览器客户端没有此服务。方法为 `query(permission)`、`request(permission)` 和 `openSettings(permission)`，权限名称包括 `microphone`、`screen`、`accessibility`。结果包含 `status`、`canRequest` 和 `canOpenSettings`。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-desktop-next/permissions'

export const inject = ['desktopPermissions']

// 从原生客户端插件的“录音”按钮中直接调用。
export async function record(ctx: Context) {
  const state = await ctx.desktopPermissions.request('microphone')
  if (state.status === 'denied' || state.status === 'restricted') return
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  // 将流交给录音器；结束录音时停止所有 track。
  return stream
}
```

客户端请求必须由当前前台窗口中的用户操作触发。Host 请求不能模拟用户点击：它会在主窗口显示授权弹窗，并返回当前系统状态，插件应在用户授权后重新查询。在前端挂载前发出的原生设置请求会保留，待界面就绪后交付。Host IPC 关联请求与响应，设置超时，并在卸载时拒绝尚未完成的请求。每次查询都会重新读取系统状态。

屏幕共享应在用户点击“共享”时直接调用 `navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })`。macOS 15 及以上使用 Electron 的系统选择器，其余系统使用原生菜单选择来源，不自动选择屏幕。系统选择器的单次共享授权可能不同于全局屏幕录制权限。权限服务本身不录制媒体，屏幕共享也不授予电脑输入控制能力。打包 Next 时保留产品自己的 `NSMicrophoneUsageDescription`，主应用和 Helper 签名直接使用固定上游 checkout 中的 `apps/desktop/scripts/macos-entitlements.plist`。语音输入通过 `getUserMedia` 触发 Chromium/macOS 的录音授权，语音插件旁不再提供额外权限按钮。

内置官方 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.2`，**默认停用**。在**插件**页顶部的 Computer Use 分区中启用，并查看实际加载状态。入口复用官方插件槽位、开关和插件管理服务；Profile 条目 ID 为 `computer-use-cua-driver-native`。共享的 `computer-use` 注册服务已提供。操作和截图沿用现有对话工具卡片及图片附件；理解截图需要模型路由声明支持图片输入。开关左侧的齿轮打开授权弹窗。

版本限定的 Yarn 补丁位于 `patches/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.2.patch`。存在 `desktopPermissions` 时，`check_permissions` 通过桌面服务查询权限；`prompt: true` 为缺失的权限打开授权弹窗，再以 `prompt: false` 由驱动执行只读检查。驱动始终报告其实际权限，不根据桌面返回值假定授权成功。没有桌面服务时保留上游行为。固定的 `@trycua/cua-driver@0.28.0` 二进制、操作工具、图片处理和关闭流程保持上游实现。只能注册一个 provider，但这不会自动串行化多个会话对同一桌面的操作。

单元测试对安装后的补丁插件使用模拟原生 SDK。可选的原生验证要求 SDK 支持当前平台，会加载并关闭真实插件，不发送输入、不截图：

```sh
corepack yarn workspace dsh-desktop-next verify:host --computer-use
```

可选的 `verify:window-controls --computer-use` 检查还会在无窗口 Chromium 中通过官方前端启用和停用真实驱动，不调用电脑操作工具。原生系统授权和实际电脑操作仍需手动验收。

### 恢复

独立恢复助手在没有 Host 运行时也能显示启动错误和近期日志，提供重试、切换 Profile、导出诊断、安全模式、修复、回滚和退出。从设置顶部选择“重启到恢复模式”时，应用先完整停止后台服务，再重新启动并只打开恢复助手；选择“启动或重试”前不加载当前 Profile 和插件。

启动时打开的恢复助手按系统首选语言的顺序选择受支持的中文或英文，无需等待 Host 加载语言设置。主界面可用后，原生控件继续跟随设置中选择的语言。

- **安全模式：** 使用独立的临时 home 和随应用提供的 bundle 启动官方界面，不载入原有凭据，并关闭远控、市场和浏览器访问。原始数据与配置保持不变。退出安全模式后返回原 Profile，并移除临时环境；在临时环境中创建的内容不会保留。
- **修复 Profile：** 先备份清单、Profile 补丁和功能开关，再恢复内置 bundle，停用第三方插件、远控和市场。损坏的 `package.json` 也可以修复。已安装的插件文件、共享会话和凭据会保留。
- **回滚 Profile：** 先备份当前文件、校验备份摘要，再恢复最近一次成功启动 Host 时的配置。范围为 `package.json`、`cordis.patch.yml` 和 Next 功能开关，不包含已安装插件的版本或共享数据。
- **全局补丁修复：** 单独备份并停用 home 级 `cordis.patch.yml`，会影响所有 Next Profile。修复 Profile 不会自动改动全局补丁。

备份保存在 `home/recovery/`。诊断导出为大小受限的 JSON，包含版本、状态和脱敏日志，不读取会话或凭据文件。日志仍可能包含本机路径和插件输出，分享前请检查。本地桌面日志保存在 `home/logs/desktop-next.log`，上限为 128 KiB。桌面设置独立保存在 `home/desktop-preferences.json`，不依赖 Host 设置服务。

开发和安装版的默认数据目录均为用户目录下的 `~/.dsh`，与 Stable 共用 Profile 和数据；Next 的选定 Profile、桌面偏好等仍使用各自命名的配置文件。原系统应用数据目录下的 `DSH NEXT/home` 只保留之前保存的数据目录位置，已有的手动选择继续有效。可通过绝对路径 `DSH_DESKTOP_NEXT_HOME` 指定专用目录；Next 不使用现有 `DSH_HOME` 来选择数据目录。恢复出厂仍作用于当前整个数据目录，包括与 Stable 共用的数据。

普通 Web Profile 无需在 `package.json` 中声明 `dsh-desktop-next`；Next 仅在自身 Host 启动和配置重组时提供该能力。已有的旧 Next Profile 会在备份清单后移除这个历史 bundle 条目，避免 Stable 或 CLI 打开同一 Profile 时载入 Next 能力。

## 架构与来源

```text
官方 Web 前端 + 官方基础桌面适配
              │  dsh-app://app
       Next Electron 主进程
              │  认证 HTTP / WebSocket
       Electron Node 模式 Host
              │  上游共享 runProfile
       官方 Web bundles + Next bundle
              ├─ Community Market
              ├─ dshmarket
              └─ Agents Anywhere bridge
```

alpha.1 的无端口管道方案已被 alpha.2 的 WebServer 方案替代。本包使用真正的上游 WebServer，不实现模拟 HTTP 路由层。Host 仅绑定 `127.0.0.1`，默认由系统分配端口，以便与其他版本并行运行；可选的独立 TLS 入口负责局域网访问。主进程保管 Host cookie 和每次启动新生成的原生访问凭据。关闭浏览器访问时，普通 HTTP 和 WebSocket 请求都会被拒绝。Electron 保持在 44.0.0，以兼容上游原生模块。转发到 Host 前，主进程只为自有主窗口中来源为 `dsh-app://app` 的主 frame 请求附加原生访问凭据，并从其他目标及重定向请求中移除该标记；原生 fetch 可以不带 HTTP `Origin` 头。市场请求还需通过 Host 认证，写请求继续校验转换后的本机 HTTP 来源。

主界面使用官方前端产物，不复制聊天、设置或插件管理页面。macOS 窗口材质、平台标记、Windows 标题栏菜单与主题同步参考官方实现。Next 通过官方的 `settings.section` 槽位添加“桌面”分区，通过 `settings.action` 添加顶部快捷操作。桌面分区直接复用 `dsh-plugin-desktop-beta` 的 `DesktopSettingsSection`、顶部操作和样式；恢复与 Profile 窗口复用原有 React 页面、窗口标题区和基础组件。Next 只适配状态与操作接口，并按能力隐藏未支持的功能，不维护另一套页面副本。共享组件改动同步到 Stable，保留两个版本原有的默认行为。经过发送者校验的窄 IPC 接口只提供预定义的原生操作，普通浏览器不会获得原生 Desktop 接口。

Next 是正式的 Profile bundle，因此上游插件管理器重新组合配置时仍保留附加能力。版本限定的补丁从安装清单读取 `dsh.optionalBundles` 和 `dsh.exclusiveBundles`，并为发布版插件管理界面添加 `plugins.overview`、`plugins.bundle.hidden` 槽位。Next 通过槽位添加顶部设置并隐藏重复的 bundle 卡片；未声明互斥组的安装保持原管理器行为。dshmarket 的安装接口调用官方 `runPluginCommand`，使用 Next 当前 Profile、安装路径和内置 pnpm，不依赖系统 PATH 中的 pnpm。开发目录启动时，只为 Next 自身在 `home/profiles/node_modules` 建立一个受管链接；其他依赖由 alpha.2 的 runtime resolver 解析。所有上游运行时依赖来自发布包，不链接或改写 `deepseek-harness/` 源码。

[upstream-reference.json](upstream-reference.json) 记录参考提交和复制文件的原始摘要；原始许可保存在 [LICENSE.upstream](LICENSE.upstream)。

## 当前边界

打包入口和 Next 自动更新客户端已接入；发布仍需生成并验证对应平台的安装包，再配置线上 Next 渠道。不迁移 Stable/Beta 数据。官方发布包内的 Python/Office 离线运行时和技能包也尚未集成。我们自己的增强／扩展窗口模式继续留待后续迁移。更新服务尚未发布 Next 时会显示暂时不可用，不会安装 Stable/Beta 包。增强窗口模式仍隐藏。Node/Electron 的无图形检查不代表跨平台安装包和视觉验收完成。

## 打包与更新

产品版本为 `2.0.14-next`。在仓库根目录运行：

```sh
corepack yarn package:dir:next
corepack yarn dist:mac-smoke:next
corepack yarn dist:mac:next
corepack yarn dist:win:next
```

打包复用 Beta 的目录构建、macOS universal DMG、签名公证预检和 Windows x64 NSIS 流程；Windows 安装包遵循现有未签名构建策略。运行时保持 `asar: false`、`RunAsNode`、完整依赖和双架构原生文件。Next 无需旧壳的 fs-ext 锁模块。所有入口仅构建产物，不发布、不启动 GUI；正式发布仍须先通过 AA 最新构建和仓库检查。

桌面设置和托盘均可检查更新。安装版启动后延迟检查，之后每 6 小时检查一次；只有用户点击下载才下载。托盘显示字节数或百分比，完成后点击“安装并重启”。安装前先隐藏窗口并停止 Host。macOS 校验 Next 身份、版本和签名团队，将已下载 DMG 中的应用封装为本地 ZIP，交给 Electron 的 Squirrel.Mac 原生更新器验证和替换；不会改写应用目录或降低签名要求。Windows 校验 Next 安装器身份和版本，交接给 NSIS 静默更新并重新启动。开发运行只允许检查，不替换源码或 Electron 开发运行时。

服务契约沿用 AA landingpage：`GET https://www.dshdesktop.cn/api/desktop/version`，请求头 `X-DSH-Desktop-Channel: next` 和当前版本；安装标识只发给版本接口。下载使用 `/api/downloads/mac` 或 `/api/downloads/windows`，固定 `X-DSH-Desktop-Target-Version`，跨存储重定向不携带这些请求头。仅接受 Next 版本，服务提供 SHA-256 时强制校验；错误、空渠道和旧版服务均不会显示“已是最新版本”。服务端必须部署 Next 通道支持并配置真实产物，且版本与包内版本一致（支持 `x.y.z-next` 和 `x.y.z-next.N`）。

## 运行日志与开发者日志

Next 在 `<数据目录>/logs/desktop-next.log` 保存可直接阅读的近期日志，在 `logs/desktop-next-YYYY-MM-DD.<分段>.jsonl` 保存结构化历史。历史按每天和每文件 10 MiB 轮转，保留七天，总量上限 200 MiB，新文件使用私有权限。启动、Host 退出和退出清理阶段不受日志级别过滤；运行标记用于识别上一次未正常结束的启动。错误和强退证据立即刷新，其余记录约 200 毫秒批量保存。日志写入失败不会阻止应用运行，诊断导出会报告存储故障或丢弃的记录数。

在桌面工具中打开 **开发者日志**，即可记录 Electron 命令、前端控制台、插件状态变化、模型流式请求及重试决策、工具执行和 Host HTTP 请求，无需重启 Host。日志级别控制详细程度，选择 `debug` 可进一步保留内核调试消息。记录包含启动标识、进程标识、来源和序号，操作共享关联标识并记录耗时，模型和工具事件可按会话和调用标识关联。新增模型、工具和网络事件只投影元数据，不记录提示词、工具参数与结果、HTTP 正文或认证头；已有插件日志和错误仍会保留，并进行规则脱敏。

**导出诊断** 会生成版本 2 的 JSON 包，包含应用及运行状态、近期日志、未完成操作和最多 50 MiB 的历史证据。导出在独立 Worker 中进行，超时期限为 60 秒，并报告未纳入的文件数；不会遍历 Profile、凭据或对话数据。

官方启动器没有挂载前的 Context 钩子，因此 Next 回放有限的日志缓冲、记录启动完成后的插件状态，并保留原始进程输出和致命错误；不在官方缓冲中的极早期调试日志无法补录。这是进程及应用日志，不包含操作系统系统调用追踪或崩溃转储采集。
