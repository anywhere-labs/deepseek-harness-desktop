# DSH Desktop Beta

[English](README.md) | 中文

`dsh-plugin-desktop-beta` 在 Electron 中运行 DSH Desktop 抢先版，同时仍然参与普通 Cordis 组合。安装后的应用名称为 **DSH Desktop Beta**。该包只提供 `dsh-plugin-desktop-beta` 可执行命令和 `dsh-desktop-beta` 别名，不会与稳定版 npm 包或命令冲突。

稳定版 `dsh-plugin-desktop` 与此 Beta 包可以安装在同一台机器上。两者使用不同的应用名、系统身份、快捷方式、单实例锁和 Electron 用户数据目录；但会有意共用同一 `DSH_HOME`（或默认的 `~/.dsh`），因此 Profile、设置、插件和会话仍然共享。支持同时安装，但不保证可靠地同时运行，因为两版可能争用 Profile 文件、端口和依赖状态。自动更新只跟随 Beta 通道；托盘中提供显式操作，可在保留 Beta 的同时安装稳定版。

## 架构

Electron 可执行文件只包含最小启动代码。它获取单实例锁、解析当前选中的 DSH profile、提供原生运行时能力，并在 Electron main 进程中启动 Host Cordis 根。`desktop-shell` Host 插件通过 Cordis effect 拥有 `BrowserWindow`、导航策略、settings namespace，以及关闭与退出生命周期。原生 runtime 拥有实体托盘；`desktop-shell`、`desktop-profiles`、`desktop-terminal` 与 `desktop-updates` 则通过有序 item registry 提供 effect-scoped 命令。

三种呈现模式都复用现有 Web carrier。profile 挂载普通 `dsh-base` 与 `dsh-web-app` bundle。Host 默认把 HTTP 与 WebSocket surface 绑定到 `127.0.0.1` 的临时端口；只有明确确认的局域网设置才会绑定所有接口，Electron 则始终从 loopback 地址在沙箱 renderer 中加载同源页面。Electron 不维护自有插件 roster，不使用 preload bridge，renderer 也不会获得原始 Electron API。

desktop package 拥有普通 Host 与 Web Client 两个 face。它的 Client face 会在所有模式下校验 Host 提供的模式、平台和经过能力门槛解析的材质 marker。兼容模式把保持不变的官方呈现放在独立 Desktop frame 下方。扩展窗口会用自己独立注册的 Desktop layout 与 sidebar surface 替换官方 root layout，同时继续承载官方 sidebar、conversation 和 details occupant。增强模式保留独立的 root registration，以及最初增强模式确定的紧凑内部 caption 几何。所有模式下，第三方 Web client 都继续使用普通 DSH 模块图。

托盘中的 profile 选择器会列出现有 profile，以及可延迟创建的 `desktop` 与 `web` 默认项。可选 profile 必须直接按顺序组合 `dsh-base` 与 `dsh-web-app`；headless、损坏或已经内嵌 desktop bundle 的 profile 仍会显示，但不可选择。只有 `desktop` 是 Launcher 管理的 profile：它会修复安装方拥有的前缀，同时保留第三方 bundle 的相对顺序。其他被选 profile 的 manifest、用户 patch 与依赖均保持不变。Launcher 只会为当前 generation 在 `dsh-web-app` 后插入自有 desktop layer，不会把该 layer 持久化到被选 bundle 列表。

Profile 选择保存在 Electron user data 下的 desktop 自有状态中，而不是被选 profile 内的另一个字段。被接受的切换会直接持久化精确的激活 profile，并通过有序重启生效。启动失败时不会替换成 last-known-good profile，也不会自动改写配置。每次健康启动都会写入三个轮转 checkpoint 之一，其中同时包含激活 Profile 的声明式 package 与 patch 文件，以及共享 DSH home 中的 `settings.yaml` 和 `cordis.patch.yml`；恢复时始终打开恢复页面，由用户选择精确槽位。执行恢复后的下一次健康启动会跳过一次 checkpoint 替换。版本 2 的旧槽位仍可恢复，但只影响原有五个 Profile 文件。凭据、`.env`、sessions、storage、缓存和生成的依赖状态绝不会写入 checkpoint。官方 profile 默认共用同一个 DSH home 中的 sessions、settings 与 storage，因此除非用户明确恢复 checkpoint，切换 Profile 不会复制或迁移这些记录；自定义 profile patch 仍可主动重定向其中某个持久化根。

Launcher 会在 Loader entry 挂载前注册作用于当前 generation 的 `ctx.desktopProfiles` service。其不可变 `current` 值包含激活 profile 的 `name` 与绝对 `dir`；`list()` 只读执行发现，`select(name)` 会串行化“先持久化、再重启”的切换，而不会就地改变当前 generation。该 service 是 Desktop Host capability，不是 renderer bridge，也不是当前上游 DSH 已提供的 active-profile API。

Cordis 的裸插件导入从持久化 profile 解析。一个范围受限的 Node resolve hook 只处理由 `@deepseek-ai/cordis-plugin-loader` 发起的导入，因此即使打包后的 Electron 不暴露 Node 内部 ESM Loader，profile 本地第三方包与修复后的 launcher fallback 仍使用同一条解析路径。

在 profile 准备与 Cordis boot 之前，打包后的 macOS 或 Linux 启动会以交互式 login 模式运行用户账户配置的 shell，并恢复其导出的 `PATH`。这样可补全 Finder、LaunchServices 等图形启动方式通常传入的精简 `PATH`。除 `PATH` 外，只会从固定 allowlist 补充当前启动环境尚未定义的 locale、工具链、package manager 与虚拟环境变量；只有 `PATH` 始终采用 shell 值。该流程只支持绝对路径的 `zsh`、`bash` 与 `fish`。Bash 遵循标准 login 行为，只有 login profile 主动 source `.bashrc` 时，该文件才会参与。Windows 以及未打包或开发运行会跳过恢复；shell 不存在或不受支持、捕获超时或失败、没有可用 `PATH` 时，会静默保留原有进程环境。

捕获过程以 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()` 作为输入；捕获到的变量名还必须通过同一套 `SENSITIVE_ENV_PATTERN` 与 `DSH_ENV_PREFIX` 检查，之后才进入固定 allowlist。因此，只在 shell rc 中出现的凭据、`DSH_*` 值、代理与 SSH agent 设置，以及进程启动 hook 都不会被导入 Electron。该恢复流程不会删除 Electron 显式启动环境中已经存在的值。普通 DSH subprocess 会再次应用官方 scrub；显式 child environment 仍可有意补回某项值。

Login-shell 恢复完成后，Launcher 才创建 layered launch-environment snapshot。随后，它会把只包含固定版本内置 `pnpm` 命令的私有命令目录前置到当前 Electron main 进程的 `PATH`。因此 Host 与第三方插件从启动开始即可发现该 package manager，也可以通过普通 DSH subprocess provider 使用它，而无需系统安装 Node.js。该 ambient path 是兼容 surface，不是正式的插件管理 contract。

`desktop-pnpm` Host row 只提供一个针对不可变激活 Profile 的 package-manager 能力：`ctx.desktopPnpm.run(argv, signal?)`。它以激活 Profile 目录作为 `cwd`，直接执行内置 pnpm entry。所有 Desktop 发起的 pnpm 操作都会在最终执行 package manager 时仅加入一次 `--config.minimumReleaseAge=0`，不会修改用户的 pnpm 配置。其余命令构造、Profile bundle reconcile、receipt、结果验证和用户界面进度都由调用方负责。Desktop 不会在该接口中加入插件专用重试、快照或回滚；恢复统一由三个健康启动 checkpoint 处理。

`run()` 会返回实时 stdout 与 stderr stream、在完整 process tree 退出后才 settle 的 `done` promise，以及 `cancel()`。每个 generation 同时最多运行一个 operation。Service 使用普通 DSH subprocess provider、准确的已打包 JavaScript entry、无 shell argv，以及只属于 child 的 DSH home、Electron-backed Node、CI 与 native-module ABI 值。公开 runtime path 仍不会暴露 `node` 或 `dsh`；其中私有 helper、`ELECTRON_RUN_AS_NODE` 与 npm ABI 变量只存在于 package-manager subprocess tree 内。Launcher 不会修改系统 `PATH`、shell 启动文件、profile 配置或 `.env` 文档。

插件作者应遵循 [Desktop 插件 service 架构](docs/plugin-services.zh.md)中记录的受支持 contract import、生命周期规则与适配模式。

## 模式设置与重启边界

DSH home `settings.yaml` 文档中的 `dsh-desktop.mode` 字段是单一事实源：

```yaml
dsh-desktop:
  mode: compatibility # compatibility、extended 或 advanced
  macosMaterial: transparent # off 或 transparent
```

Launcher 会在组合一个 generation 之前，读取当前 `@deepseek-ai/dsh-settings-file` row 解析到的同一份文件。Host 通过标准 settings service 注册 `dsh-desktop` namespace。profile manifest 中没有平行的模式值。

用户可以从托盘选择另一种模式，也可以手工编辑 DSH home 中的 `settings.yaml` 文档。托盘会更新已注册的 `dsh-desktop` settings namespace，手工编辑则修改 settings provider 观察的同一文件。修改提交后会请求一次有序重启：先 dispose 当前 Cordis 树，仅当零退出码的 shutdown 成功时才让 Electron relaunch。应用绝不会在存活的 renderer generation 中热切换 root slot、原生窗口材质或 Loader row。

Linux 只支持兼容模式。其托盘模式命令会被禁用，自定义窗口模式值会被拒绝，而不会静默降级。

## 兼容模式

`dsh-desktop.mode` 默认为 `compatibility`。在 macOS 与 Windows 上，该模式会在当前 DSH profile 的官方 Web surface 上方创建一条独立的 36 CSS 像素 Desktop frame，并保留原生红绿灯或窗口按钮。居中的标识、模式 pill、拖动区域与图标操作只属于该 frame；完整官方页面从它下方开始，不参与 frame 的布局或安全区计算。Linux 保留普通原生 frame 作为兼容 fallback。

desktop Client module 会校验模式与平台 marker，在兼容模式下只注册独立 frame overlay 与固定 launcher 操作，不替换任何官方呈现。它不提供或替换 `layout` service，不注册 `root` 或 `sidebar` occupant，也不改动 conversation surface。Desktop 自有的启动健康报告属于能力 effect；兼容模式仍会保留被选 profile 自身的 layout、sidebar 与 conversation 组合，普通 `desktop` 与 `web` profile 因而会原样保留官方 row。上游 dialog 仍是内容 overlay，并被限制在 Desktop frame 下方。

Cordis row 会在 profile 激活期间登记原生窗口参数。Launcher 只在 `app-boot` 完成并审计整个 profile 后创建窗口，因此首个 renderer manifest 会包含所有已激活的官方、desktop 与第三方 client plugin，同时插件自身不会在 Loader entry 内等待整棵 Loader tree。

在 Windows 上，Launcher 会固定使用 browse 目录选择 backend，并保留完整的应用内目录面板。桌面构建通过补丁在该面板中加入一个小型系统文件夹图标；图标经同源路由调用 Electron 的 `dialog.showOpenDialog`，选中的路径继续进入面板原有的 workspace 接纳流程，取消后面板保持打开。普通浏览器与远程启动不会获得这个桌面桥接。macOS 与 Linux 仍使用上游自适应 chooser。

本次 alpha runtime 迁移不再携带 Desktop 自有的工作区文件夹拖放行为或聊天附件拖放隔离补丁。在按 alpha Client UI 重新评估这些交互前，请使用普通工作区选择流程。

在所有呈现模式下，Windows PowerShell 都会保留上游 `pwsh-sandbox` 行为与 Windows ACL confinement。Launcher generation 只会把该 Host provider 替换为同一 package 中的 `dsh-plugin-desktop-beta/windows-pwsh-sandbox` 子路径。对于与上游 ACL runner 完全匹配的 argv，adapter 会让打包后的 Electron executable 通过私有 trampoline 以 Node 模式启动。Trampoline 会先精确校验上游 runner，再在导入它之前移除 Node-mode 环境变量，并确保自身这个原本没有 console 的 Windows 进程拥有一个隐藏 console。受限 PowerShell 进程随后可以继承该 console，而不必在已经使用受限 token 时自行创建。Console 分配失败会通过现有带签名的 runner 失败路径退出；全部 ACL policy 与后续失败处理仍委托给上游 runner。Desktop deploy root 还会保留 Yarn patch，在两条原生受限进程路径上把 `STARTF_USESHOWWINDOW`、现有的 `STARTF_USESTDHANDLES` 与 `SW_HIDE` 组合起来。它不会使用与上游实现不兼容的 `CREATE_NO_WINDOW` 或 `CREATE_NEW_CONSOLE` flag。直接使用 `danger-full-access` 的 PowerShell、macOS 与 Linux 执行路径保持不变；Windows confinement 失败时不会自动回退到不受限执行。

## 扩展窗口模式

扩展窗口会禁用官方上游 `ui-layout` root，并安装 Desktop 自有 root layout。该 layout 负责 sidebar、conversation、details、overlay 和 resize 几何，同时继续渲染官方 sidebar、conversation 与 details slot occupant。Desktop root 上方是一条固定的 36 CSS 像素操作栏；操作栏与 Desktop 自有 sidebar surface 只透出一层不会叠色的材质，组成连续的倒 L 形玻璃区域。conversation surface 位于倒 L 内侧，使用 10 像素内圆角，并让分隔线沿圆角绘制。

居中的产品标题和模式 pill 不受两侧操作组影响。第一方操作使用紧凑图标：macOS 把它们放在红绿灯相对的右侧，Windows 则把它们放在原生标题栏按钮相对的左侧。图标可以打开 DSH 终端、打开包含普通重启与恢复模式重启的菜单，或打开开发者菜单来重载 renderer 与切换分离式开发者工具。这些固定操作通过私有同源 launcher 边界执行；页面不会获得原始 Electron 或任意命令接口。

即使上游 overlay 打开，操作栏仍会保持可见且可以拖动窗口。macOS 红绿灯和 Windows 原生标题栏按钮保留各自命中区域；这个私有 surface 只直接渲染 Desktop 自有的第一方图标，它们会明确退出拖动区域并保持可点击。Web Client 插件在兼容模式和扩展窗口中都不能向操作栏贡献 action。

DOM 会把操作栏声明为 Desktop frame，并把下移后的上游 root 声明为它的 content viewport。`shell.overlay` 会成为 fixed 插件 surface 的 containing block，直接 portal 到 `body` 的对话框则获得相同的内容偏移；两条路径都会被限制在 36 像素 frame 下方，不会再压暗或拦截顶栏。

自定义窗口材质独立于模式设置。macOS 可选“关闭”或“透明材质”。Windows 不提供材质选项，所有 Windows 窗口都是普通的不透明窗口。已移除的 `windowsMaterial` 旧值 `acrylic` 和 `mica` 仍可读取，旧设置照常启动，两者都按关闭处理。切换模式或材质都会执行有序重启。

## 增强模式

增强模式是为 macOS 与 Windows 显式组合的 desktop 呈现。Launcher 会在读取全部用户 patch 后禁用官方 `ui-layout` Loader row，保持官方 `ui-sidebar` 与 `ui-conversation` row 启用，并把所选模式应用到 `desktop-shell`。

desktop Client 会在所有呈现模式中提供不可变的 `desktopWindow` 原生几何 service。增强模式拥有独立的 Cordis effects、`layout` service 与 `root` slot registration，不会安装兼容/扩展模式的独立 frame。其 root 为不变的上游 sidebar、conversation、details 与 overlay contribution 声明 seat。官方 sidebar 继续作为 `sidebar` occupant，并继续声明 workspace browser、settings shell 与纯新增 footer action seat。这样会保留其组件行为、收起动画与第三方扩展点，而 desktop package 只拥有增强模式自己的紧凑内部 caption 几何与原生材质。

高级 theme presenter 会把当前上游 theme snapshot 投影到 document，包括 color scheme、解析后的 token 值、深色模式 marker 与 theme-color metadata。它订阅普通 theme 变化，generation dispose 时只移除由自身投影的状态。

对于高级 generation，Electron adapter 还会在 Host boot 完成后读取已注册的 `ui-theme.preference`，并在创建窗口前把内置 `light`、`dark` 或 `system` 值同步到 Electron 原生外观。窗口存续期间提交的 preference 变化会更新原生材质，dispose 则恢复此前的 Electron 外观。仅存在于 Client 的第三方 theme id 不会改变该 Host preference。

desktop sidebar surface 会把上游 sidebar-fill token 局部设为透明，因此官方 sidebar 与 session 列表渐隐可以透出原生材质，而无需改变其组件样式。

在 macOS 上，增强窗口恢复最初的 hidden-inset 几何：红绿灯位于 `x=16, y=16`，内容使用紧凑的 20 CSS 像素 inset，原生拖拽区域为 32 CSS 像素。其 90 CSS 像素收起列会把官方 56 像素 rail 居中放在该紧凑 inset 下方，并继续支持可选的原生 `sidebar` vibrancy。按钮、链接、输入框、可编辑字段、菜单、标签页、开关、对话框与显式 `.dshDesktopNoDrag` contribution 会通过精确的 `app-region: no-drag` 排除规则保持可交互。在 Windows 上，官方 sidebar 保持兼容模式几何：收起 56 像素、默认展开 280 像素，并沿用相同的上游过渡行为；透明 surface 会透出当前系统支持且用户选择的材质。增强窗口保留最初的 32 CSS 像素内部 caption row 与原生 overlay 控件；这套几何与兼容/扩展模式的 36 像素独立 frame 无关。Linux 会拒绝增强模式，而不会静默降级到与持久化设置不同的呈现。

## 开发

该包由仓库根目录的 Yarn workspace 管理。相邻的 `deepseek-harness/` checkout 仍是独立的上游 pnpm 项目，不属于 Yarn workspace。请从仓库根目录安装并验证 DSH Desktop：

```sh
yarn install
yarn check
```

该检查会验证生产依赖图中的每个必需第一方 peer 都由 desktop deploy root 声明。Headless Loader smoke 会激活 launcher 拥有的 desktop row 与 profile 本地第三方 row，然后启动已发布 Web profile 并检查其 loopback 根页面与 client manifest。单元和类型测试覆盖两种 profile 组合、重启栅栏、client environment 校验、desktop layout 状态与各平台原生窗口选项。

有图形会话时，显式启动桌面应用：

```sh
yarn dev
```

`dev` 会在启动前自动构建，不需要另行手动构建。

以下 headless-safe 启动器入口不会导入或启动 Electron：

```sh
node lib/bin.js --help
node lib/bin.js --version
```

## 插件工作流

使用普通 DSH 命令管理任意 profile：

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
dsh plugin --profile desktop update
```

应用默认使用 `desktop`。可以在托盘的 **Profile** 子菜单中选择其他 Web-capable profile；切换时应用会重启。生成的 DSH 终端会让裸命令默认作用于当前激活 profile，因此以下短命令可以直接修改它：

```sh
dsh plugin add third-party-plugin
dsh plugin remove third-party-plugin
dsh plugin update
```

显式 `--profile <name>` 始终具有更高优先级，可用于在切换前准备其他 profile。

`dshmarket@1.2.3` 尚未预装，也不是 DSH Desktop 的 dependency。该版本仍从 config/argv 解析 profile，并通过私有 child-process 代码启动 `dsh plugin`；它既不读取 `desktopProfiles`，也不使用 `desktopPnpm`，package exports 也没有 runner injection seam。后续兼容版本必须动态探测 Desktop service，同时在普通 DSH 中保留现有 CLI fallback。此外，`1.2.3` 的源码仓库与 npm tarball 均未包含完整 MIT 许可文本或版权通知，因此该版本尚未通过内置再分发 gate。用户主动安装第三方 package 与 Desktop 将其嵌入 application archive 或 installer 是两个独立边界。

Required injection、可选 Desktop 适配、TypeScript 示例、cancellation 与 fallback 指南详见[面向插件作者的 service 文档](docs/plugin-services.zh.md)。

随后可以通过 npm 启动该包：

```sh
npx dsh-plugin-desktop-beta
```

## 命令行启动

该包安装两个仅属于 Beta 的等价命令 `dsh-desktop-beta` 与 `dsh-plugin-desktop-beta`。无参数调用时，两者都会启动打包的 Electron launcher（`lib/main.js`）。

- **全局安装** —— `npm install -g dsh-plugin-desktop-beta` 会自动安装 `electron` peer，之后直接执行 `dsh-desktop-beta` 即可基于共享的默认 DSH home 启动应用：
  ```sh
  dsh-desktop-beta
  ```
- **在 profile 内** —— `dsh plugin --profile <name> add dsh-plugin-desktop-beta` 后，命令位于该 profile 的 `node_modules/.bin`。pnpm 不会自动安装 `electron` peer；需要命令行启动时，请手动添加：
  ```sh
  dsh plugin --profile <name> add electron
  ```
  原生构建许可（node-pty、koffi、electron 等）遵循 pnpm 常规的 `allowBuilds` 规则。
- **缺少 electron** —— 命令会打印简短的安装指引，而不是抛出模块错误。

如果用普通 `dsh` 命令直接启动一个组合了桌面壳的 profile（缺少 launcher 的 `desktopRuntime` service），会打印提示，告诉你用 `dsh-desktop-beta` 或打包版应用启动；此时桌面壳不会注册任何功能。

第三方 Host 插件只需提供普通 `dsh.bundle` patch。包含浏览器 UI 的插件还要发布普通 `dsh.client` 元数据，将 `platform` 设为 `"web"`，并导出 `./client` 产物。上游 Web 客户端模块图会在所有模式下发现它；Electron 不要求单独的客户端构建，也不引入 desktop 专用注册 API。增强模式 contribution 必须面向该显式组合中存在的 service 与 slot，不能假设官方 layout 或 sidebar occupant 拥有它们。

## 桌面操作

当 Desktop 窗口没有焦点时，直接用户发起的回合到达 `completed` 会显示原生完成通知；以 `error` 或 `max-tokens` 结束时则显示需要处理的通知。后台任务完成或失败也使用同一条原生注意力路径。取消、阻塞、中断、被终止的任务、插件发起、仅 continuation、turn 不匹配及 subagent 活动都保持静默。点击通知会显示并聚焦窗口。macOS 与 Linux 会递增应用角标，Windows 会闪烁任务栏按钮；显示、聚焦或释放窗口时会清除这些提示。实时生效的 `dsh-desktop-notifications` settings namespace 提供相互独立的 `notifyOnTurnCompletion`、`notifyOnTurnFailure`、`notifyOnJobCompletion` 与 `notifyOnJobFailure` 开关，默认全部开启。通知文案刻意保持通用，不会包含提示词、回复、错误、任务标签、命令、路径、会话 ID、模型或 provider 名称、工具数据及输出。

打包后的 macOS 与 Windows 应用会在启动 60 秒后查询 `https://www.dshdesktop.cn/api/desktop/version`，并在每次检查完成六小时后再次查询。每次 no-cache 请求的期限为 15 秒，会携带 `X-DSH-Desktop-Channel: beta` 和当前安装版本，并与托盘中的 **Check for Updates…** 命令共用一个 in-flight operation。Beta 只接受规范的 `-beta.N` SemVer，且响应必须明确包含 `channel: "beta"`；它不会静默使用稳定版。后台失败和非更新版本保持静默；手工检查一定会显示原生结果对话框。**安装稳定版** 会另行查询稳定通道，允许目标版本更低，并把稳定版安装在 Beta 旁边。开发运行、未打包启动与 Linux 不会下载安装包。

选择 **Download** 后，应用会先重新确认服务端版本没有变化，然后打开原生保存对话框。默认位置是 Downloads，但用户可以选择其他绝对路径和文件名；取消对话框不会发起下载请求。DSH Desktop 使用 Electron 网络跟随 service redirect，把不超过 1 GiB 的文件流式写入用户选择的路径，记录安装包位置用于升级交接，并在交付前拒绝不完整的 DMG 或 Windows PE。macOS 会打开下载好的 DMG，并提示用户替换 `Applications` 中的应用后重新打开。Windows 会在 NSIS 安装器准备完成后再次确认；选择 **Restart and Install** 会启动安装器，并在当前进程退出前请求 Cordis 有序 teardown。升级后的应用启动时会询问删除已记录的安装包，或保留它；任一选择都会消费 pending cleanup state。下载、文件系统与安装器打开失败都会保持静默，同时保留托盘中的可重试版本操作。

Release operator 必须先发布两个平台产物，再让 Beta 版本可被发现。版本与下载服务在 `X-DSH-Desktop-Channel: beta` 时必须选择 Beta，并在下载响应中同时回显 `beta` 与请求的 `X-DSH-Desktop-Target-Version`。值缺失、服务不可用、响应不匹配或格式无效时，Desktop 不会显示任何提示。稳定服务仍需支持显式安装操作和旧客户端。

在 macOS 与 Windows 上，**打开 DSH 终端** 会打开以当前激活 profile 为工作目录的系统终端。设置页标题区会在它旁边提供重启菜单，其中包含 **重启 Desktop** 和 **重启到恢复模式**；任何重启路径都会先显示确认，再开始有序 Cordis shutdown 和 Electron relaunch。终端欢迎信息会显示应用版本、当前 profile、profile 目录与 DSH home，并列出配置与插件管理命令。在该终端内，裸 `dsh`、`dsh --dump-config`，以及没有选择 profile 的 plugin 子命令都会默认使用当前激活 profile；显式 `--profile` 与上游 `web` alias 会保留原有含义。DSH Desktop 会在自身 user-data 目录下按 profile 生成私有 `dsh`、`pnpm` 与 `node` shim，设置 `DSH_HOME`，使用当前 profile 作为工作目录，并且只在该终端的 `PATH` 前置 shim 目录；之后切换 profile 不会改变已经打开的终端命令。它不会修改全局环境或 shell 启动文件。macOS launcher 会先保留用户的交互式 zsh 或 bash 设置，再恢复 desktop 自有变量。Windows 会依次选择 PowerShell 7、Windows PowerShell 或命令提示符，并在新的 Windows Terminal 窗口中打开；如果 `wt.exe` 不可用，则由私有 `cmd start` broker 创建可见控制台。同步启动失败与 broker 非正常退出会使用 Desktop dialog surface。Linux 不组合该终端命令。

Desktop 的确认、警告、错误与结果统一使用基于 shadcn 的 `DesktopDialogWindow`。每个 dialog 都是独立、沙箱化的模态 `BrowserWindow`，在可用时以当前 Desktop 窗口为 parent；它不是官方 Web 页面内部的组件或 portal。作为 parent 子窗口的纯操作 dialog 不显示窗口按钮，也不会渲染空白 frame；只有独立显示并带有 macOS 红绿灯或 Windows 窗口按钮的 dialog 才使用共享的 36 像素 utility frame。Escape 或可用的窗口关闭操作会映射为有界取消，并且只向 main process 返回一次本地结果。操作系统的打开文件和保存文件选择器仍保持原生，因为它们负责选择系统路径，而不是展示 Desktop 操作。

恢复模式同样使用独立的 Desktop-owned 窗口；当存在 macOS 红绿灯或 Windows 窗口按钮时显示空白 36 像素 frame。其完整 shadcn 页面先说明进入恢复模式的原因，再把操作分成 **插件管理**、**回滚**、**切换配置** 与 **诊断** 四个 Tab。新增 Profile 窗口也只在实际存在这些窗口按钮时使用无标题 utility frame。恢复操作和任何重启请求都会打开 `DesktopDialogWindow` 确认，而不会把 modal 放进恢复页面里。

## 日志与诊断

启动健康后，主进程每五秒检查一次可见应用内容。连续两次页面为空或探测无响应，即使渲染进程未退出，也会触发有次数上限的自动恢复；无响应的渲染进程会被终止并在新进程中重载。可见窗口恢复成功还要求视口中存在有效内容，不能仅凭插件激活就判定成功。隐藏、最小化、页面导航以及恢复时页面或 Loader 尚未就绪期间暂停检查。每次探测限时十秒，并丢弃过期导航结果和长时间休眠后的超时结果。探测检查 DOM 可见性，不检查截图像素，不能诊断仅发生在 GPU 显示链路中的故障。

启动健康后，如果界面进程意外退出（包括内存不足），应用会静默重载现有窗口，不重启 Host、不弹窗，也不唤起已隐藏的窗口。只有页面加载完成且客户端 Loader 上报健康，才算恢复成功；恢复尝试在 30 秒内未完成则视为超时。最多自动尝试三次：首次不延迟，后续分别等待一秒、三秒；恢复后保持健康满一分钟才重置重试次数。连续失败时暂停自动恢复，并打开系统原生兜底提示：**再次尝试恢复** 授权新一轮有次数上限的恢复，**暂不处理** 则保留后台服务运行。可从托盘选择 **打开 DSH Desktop** 再次打开提示，或选择 **导出诊断信息…** 继续调查。重载期间画面可能短暂中断，未发送的输入可能丢失；此机制不修复崩溃或内存增长的根因。启动失败仍使用既有恢复流程；主动终止 renderer 和应用退出期间不会发起自动恢复。

DSH Desktop Beta 将 UTF-8 日志写入独立的 Electron 用户数据目录：Windows 位于 `%APPDATA%\DSH Desktop Beta\logs`，macOS 位于 `~/Library/Application Support/DSH Desktop Beta/logs`。完整日志使用 `dsh-YYYY-MM-DD.log`，warning 与 error 还会写入 `dsh-YYYY-MM-DD.error.log`。单文件达到 10 MiB 后轮转，启动时删除七天前的文件，整个目录保持在 200 MiB 以下。`dsh-desktop.logLevel` 设置控制详细程度，默认为 `info`。

在 macOS 与 Windows 上，从托盘选择 **导出诊断信息…**，应用会在相邻的 `diagnostics` 目录创建 ZIP，并在系统文件管理器中定位它。导出在 Electron 主线程之外执行，会在共享的 50 MiB evidence cap 内收集最近的自有日志和本地 Crashpad `.dmp`，并在存在时包含 `crash-evidence/active-run.json` 标记，同时加入 `system-info.txt`，只保留最新三份 ZIP。创建任何文件前，确认对话框会说明隐私边界。系统会脱敏可识别的凭据，但日志仍可能包含本地路径、工作区 ID、会话 ID、提示词、工具输出或第三方插件消息；crash dump 可能包含进程内存片段。分享诊断包前应先检查内容，公开上传时尤其如此。

## 原生生命周期

关闭窗口会隐藏窗口，Host Cordis 树继续运行。托盘可以重新打开窗口、选择激活 profile、打开隔离的 DSH 终端、检查 stable release、通过标准 settings namespace 更改模式，或请求显式退出。Profile 与模式切换都会先 dispose 当前 Cordis 树，再让 Electron relaunch。原生退出、`SIGINT` 与 `SIGTERM` 也会在退出前请求 dispose；超过五秒或收到重复请求时会强制完成最终退出。导航与重定向被限制在确切的 loopback origin；外部 HTTP、HTTPS 与邮件链接由操作系统打开；renderer 启用 `contextIsolation` 与 Chromium sandbox，并关闭 Node integration。

## 打包

Stable 与 Beta 在 Windows、macOS 和 Linux 上均关闭 ASAR。打包后的 Electron smoke 会通过本地文件系统后端验证随包 Cordis 技能。

`yarn package:dir` 为当前宿主平台创建未封装目录。如果应用目录缺少 desktop 更新与终端模块、DSH CLI bootstrap、内置 pnpm 入口或物理 deployment package，packaged-runtime gate 会拒绝该产物。Electron Builder 会把根 manifest、desktop runtime 与完整依赖树输出到 `resources/app/`（macOS 为 `Contents/Resources/app/`）；Host profile boot 与 CLI bootstrap 都会使用这棵物理树，因此 DSH profile fallback 的符号链接不会指向虚拟 ASAR 目录。

可编辑的图标工程位于 `build/app-icon.icon`，使用 System Dark 背景，保留 BETA 徽标。macOS 打包直接把这个分层源工程编译为 `Assets.car`，并声明 `CFBundleIconName`；打包后的应用保留原生 Dock 图标。Apple 编译器同时生成 `build/app-icon.icns`，用于较旧的 macOS 和 DMG 卷图标。Composer 导出的 `build/app-icon.png` 用于 Linux，并作为 Windows `build/app-icon.ico` 的来源；ICO 提供常用高 DPI 档位的精确帧，保留对应版本的图案，供应用程序、NSIS 安装器和卸载器使用。带内边距的 `build/app-icon-mac.png` 仅用于未打包的 Electron 开发运行，此时还没有编译后的应用包。

在 Icon Composer 保存工程后，在安装了 Xcode 27 和 Icon Composer 的 Mac 上，从仓库根目录运行 `corepack yarn icons:export --channel beta`。省略 `--channel` 可一起导出 Stable、Beta 和 Next。请同时提交工程、所有导出资源和 `build/app-icon.resources.json`；`corepack yarn icons:check` 可在任何系统上检查资源是否过期或缺失，无需 Xcode。macOS 原生打包要求 Xcode 26 或更新版本；若 `xcode-select` 指向 Command Line Tools，请为打包命令设置 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`，导出脚本则会自动查找完整 Xcode 安装。

`build/tray-icon.svg` 是品牌蓝托盘源文件：构建过程会派生由 macOS 系统自动着色的模板图，以及固定品牌蓝的 Windows 与 Linux 托盘图。

### WSL Linux 无界面检查

在 Windows 工作站上，WSL2 适合覆盖 Linux 无界面的 build、typecheck 和 unit test。请使用 WSL 内部安装的 Linux Node.js，不要使用 WSL 通过挂载的 Windows `PATH` 继承到的 Windows Node.js 或 Corepack shim。使用 `nvm` 时，每个 shell 先执行 `source ~/.nvm/nvm.sh`，再运行 Corepack 命令：

```bash
source ~/.nvm/nvm.sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn workspace dsh-plugin-desktop-beta typecheck
corepack yarn workspace dsh-plugin-desktop-beta test
corepack yarn build
```

从 `/mnt/<drive>` 运行命令是有效的，但会比放在 WSL 原生 ext4 文件系统中的 checkout 更慢。WSL 不能替代真实 Linux 桌面会话来验证托盘、窗口管理器、`.desktop` 集成或安装后 smoke test。

### Windows x64 本地安装包

请使用原生 Windows x64 电脑，并安装 Git 与 x64 Node `22.23.2`（与 CI 使用的版本相同）。打包命令接受官方发行版仍包含所需 Corepack 命令的 Node `22.19+` 与 Node `24.x`。在一个最新的 `v2` checkout 中打开 PowerShell，然后执行：

```powershell
git submodule update --init --recursive
corepack.cmd yarn install --immutable
corepack.cmd yarn dist:win
```

该流程不要求 Python 或 Visual Studio C++ Build Tools。Windows 命令会直接使用 `node-pty` 内置的 x64 Node-API 二进制，而不会让 Electron Builder 从源码重新编译；如果安装包 staging tree 缺少这些二进制，packaged-runtime gate 会直接拒绝产物。

`dist:win` 会拒绝非 Windows 或非 x64 宿主，先执行一组 Windows 可运行的 gate，其中包括 build、全部 TypeScript compiler face、打包与原生 shell 聚焦测试，以及 runtime-closure verifier；随后再构建 NSIS 安装向导，并校验生成的两个 PE 文件。完整跨平台 suite 仍由 CI 持有，因为其中部分 POSIX 执行测试不是 Windows 程序。安装向导支持当前用户安装或提升权限后的所有用户安装，可更改安装目录，会创建开始菜单与桌面快捷方式，并且卸载应用时保留 DSH 用户数据。版本 `2.0.5-beta.2` 会输出到 `dsh-plugin-desktop-beta\dist\DSH-Desktop-Beta-2.0.5-beta.2-x64-Setup.exe`；用于 smoke 测试的未封装程序仍位于 `dsh-plugin-desktop-beta\dist\win-unpacked\DSH Desktop Beta.exe`。

该本地命令会主动移除 Windows 证书变量，并设置 `signExecutable=false`。产物可以安装测试，但没有 Authenticode publisher，因此 Windows 可能显示 Unknown publisher 或 SmartScreen 警告。签名后的 Windows release、证书校验、安装器升级与卸载测试，以及原生 UI 和 sandbox smoke 仍是独立的发布 gate。

### Windows x64 绿色 ZIP 版

在原生 Windows x64 电脑上执行 `yarn dist:win-portable`，生成未签名的单文件绿色版：

```powershell
corepack.cmd yarn dist:win-portable
```

产物为 `dsh-plugin-desktop-beta\\dist\\DSH-Desktop-Beta-2.0.5-beta.2-x64-Portable.zip`。用户解压到任意可写目录后运行其中的 `DSH Desktop Beta.exe`，不需要安装器、管理员权限、开始菜单注册或卸载步骤。它仍会把 profile、日志和缓存写入 Windows 的 Beta 用户数据目录，因此这是便携分发方式，不是把数据完全封装在 exe 旁边的自包含沙箱。绿色 ZIP 不会交给 NSIS 自动更新流程，新版本需要手动替换并重新解压。本地构建没有签名，Windows 可能显示 Unknown publisher 或 SmartScreen 警告；签名后的绿色版仍属于正式发布 gate。

### macOS DMG 冒烟构建

`yarn dist:mac-smoke` 会在原生 macOS 宿主机上构建一个未签名的 universal DMG，同一个安装包可以在 Intel 和 Apple Silicon Mac 上原生运行。该命令拒绝非 macOS 宿主，并在打包前运行完整产品 gate：仓库布局与社区契约检查、Market 的 build 与 check，然后再运行 Desktop build、全部 TypeScript compiler face、完整 unit-test suite、runtime-closure 验证、CLI/Loader/profile headless smoke 与 license audit；其中包括对 macOS runner 上已安装的每种受支持 shell 执行真实 login-shell 测试。随后它会在不接触任何签名材料的情况下打包，挂载 DMG，并检查属性列表、主程序执行权限、`x86_64` 与 `arm64` 两个架构切片，以及 `Contents/Resources/app/` 中的运行时入口。该命令与 `dist:win` 的密钥纪律一致：剥离 Electron Builder 能识别的全部 macOS 签名与公证变量、设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`、关闭 notarization，且从不发布。产物没有 Developer ID 签名，因此 Gatekeeper 会在其他机器上拦截它；它的存在是为了让打包回归在人工发布之前就在 CI 中失败。签名并公证的 universal 正式发布仍是在持有凭证的 macOS 机器上执行 `yarn dist:mac`，产物写入 `dsh-plugin-desktop-beta/dist/mac-release/`。

## 模型体验

无。desktop package 只改变应用组合与原生呈现，不增加任何模型可见的指令、工具、事件或请求字段。

#### KV Cache 影响

无。模型请求仍由同一套 DSH Host 与 client feature plugin 组装。

## 已知限制与暂缓事项

- 添加或删除 profile bundle 后必须重启 DSH Desktop；Launcher 不监听 profile manifest。从托盘选择其他 profile 时会自动完成该重启。
- 切换兼容模式、扩展窗口或增强模式，或修改材质，按设计都会重启应用；存活的 generation 不会热切换 Loader row、slot 所有权或原生材质。
- Linux 不支持扩展窗口与增强模式。Linux 继续使用兼容呈现。
- macOS 与 Windows 托盘终端会提供私有 `dsh`、`pnpm` 与 `node` shim。除此之外，Host runtime 会在当前 Electron 进程的 `PATH` 中公开内置 `pnpm` 命令作为 ambient compatibility，并提供受管 `desktopPnpm` service；这些命令都不会加入系统 `PATH`，Linux 目前也没有 desktop 终端命令。
- 在 Windows 上，ambient `pnpm` 命令与 lifecycle Node helper 是 `.cmd` shim。`desktopPnpm.run()` 会启动准确的已打包 pnpm entry，从而避免 manager process 的 shell lookup；上游 `dsh plugin`、PowerShell 与命令提示符则可通过 command interpreter 解析 ambient shim。第三方插件直接调用 Node `spawn('pnpm', { shell: false })`，或 lifecycle script 直接以 `shell: false` 执行其 `.cmd` `npm_node_execpath`，仍属于不可移植行为，应改用该 service 或 shell-aware 启动路径。
- `dshmarket@1.2.3` 仍是用户可选安装的第三方 package，而不是内置 marketplace。只有重新审计的版本同时消费可选 Desktop service、保留普通 DSH fallback，并包含再分发所需的完整 license notice 后，才会重新评估预装。
- 更新交接只验证下载容器，不验证 publisher 身份。macOS 仍要求用户从已打开的 DMG 替换应用；Windows 会运行已下载的 NSIS 安装器，但本地 `dist:win` 产物没有签名。签名产物、Authenticode/publisher 校验、SmartScreen 信誉与原生升级测试仍是发布 gate。
- 共享 carrier 使用 HTTP 与 WebSocket，而不是 Electron IPC；默认只绑定 loopback，并支持经过明确确认的全接口局域网监听。替换 carrier 需要上游 DSH 提供 transport 扩展点，不属于该独立包的范围。
- Beta 使用固定官方 release 源码构建的 DSH `0.1.6-alpha.2` 运行时分发包；桌面构建解析这些包接口，不直接链接源码 checkout。历史会话由上游迁移到 V3，自动转换旧 PTC 事件和 `code` 预设引用并保留原日志，桌面端不再生成预设别名。旧运行时无法读取 V3 会话。扩展和增强模式接入右侧 Sidebar 的文档预览、分栏和全屏，并通过 keyed `main` 槽位支持独立于会话选择的全局插件面板。
- `package:dir` 是用于 smoke 的未封装产物。`dist:win` 会额外生成未签名的 NSIS 测试安装包，但不会建立 Authenticode 身份或 SmartScreen 信誉。安装与升级行为、原生通知与终端、Windows ACL sandbox，以及每台目标机器上的原生材质外观仍属于目标平台验证边界。
