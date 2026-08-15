# Agent Note: Electron 桌面应用以可替换的 loopback Web supervisor 起步

Status: implemented

[English](2026-08-14-electron-loopback-web-supervisor.md) | 中文

## 问题

桌面应用需要 Electron 窗口和由托盘拥有的应用生命周期，同时不能让窗口拥有 Harness 工作。关闭窗口必须让会话和后台工作继续运行，显式退出应用则必须 dispose（资源释放）Harness 进程并等待其后代进程结束。如果同时构建最终的 Electron IPC 载体，首个可用壳在交付前还必须具备打包后的客户端模块 loader、IPC 流式传输、原生操作路由和新的渲染器安全边界。

现有 Web profile 已经提供完整的交互客户端、ApiProxy 校验、会话回放、审批处理、配置界面和原生 Host 操作。首个桌面实现需要复用这些行为，但不能让其进程安排成为永久约束，也不能削弱[通道无关的 GUI 协议](2026-07-19-gui-layering-and-rpc-protocol.md)。

## 决策

`apps/desktop` 中的 `@deepseek-ai/dsh-desktop` 是私有 Electron 应用和可替换的 supervisor，并非新的 Harness 组合或协议载体。它启动一个绑定到 loopback、使用操作系统分配端口的 `dsh --profile web` 子进程，再从子进程的 `dsh web: <url>` 就绪行加载规范 URL。就绪解析器按流分片而非 stdout 回调边界处理输入，忽略无关输出和可选 LAN 注释，并且只接受端口有效且非零的 HTTP loopback authority。就绪行格式错误、启动错误、子进程提前退出，或流在就绪前结束时，应用会让启动失败，而不会导航到推断出的地址。

根目录的 `dev:desktop` 命令是完整的源码启动入口。Electron 启动前，该命令会构建 Host 与客户端包的编译面、Web 前端和 Electron main 进程，因此完成全新依赖安装后无需另行构建仓库。

根目录的 `package:desktop` 命令是完整的本地打包入口。它会执行同样的仓库构建，然后由 `apps/desktop/scripts/stage-runtime.ts` 根据仅含依赖的 manifest，创建已忽略的 `apps/desktop/runtime-host` 目录树。该暂存器运行仅生产环境依赖的提升式 `pnpm deploy`，补回 legacy deploy 遗漏的直接依赖，将包链接实体化，并拒绝所有残留的符号链接。Electron Builder 会把该封闭目录树与构建后的 Web 前端一起复制到应用的 `resources/host` 目录。

打包后的 supervisor 使用已打包的 Electron 可执行文件和 `ELECTRON_RUN_AS_NODE=1` 启动 `resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js`；源码启动仍使用宿主 `node` 命令与工作区 CLI 入口。Electron 的 Node 模式可以提供独立 Host 进程，无需在应用中增加第二个 Node 可执行文件。因此，已交付 Electron 的 Node ABI 拥有暂存依赖闭包中原生依赖的兼容性。

打包后的 macOS 与 Linux 应用会在 spawn Host 前，从用户主目录捕获默认登录 shell 环境。捕获过程使用隔离的进程组、私有输出描述符、随机边界标记、NUL 分隔值、一 MiB 输出上限与两秒终止期限；超时与输出超限会终止 shell 进程树并关闭捕获流，shell 缺失、解析失败、输出超限、超时和 spawn 失败都会回退到应用继承的环境。登录 shell PATH 优先，Electron 持有的 HOME 保持权威，瞬态 shell 变量会被移除，捕获值只保留在内存中。源码启动与 Windows 使用继承环境。

CLI 为 profile 与 Web 入口提供 `--safe-mode` 启动选项。该模式仍会准备缺失的随附 profile，并加载恢复 bundle 层、内部 agent preset overlay、存储、凭据、会话、工作区与 telemetry；本次进程跳过 profile 和 home `cordis.patch.yml` 层及两者的 watcher。随附 profile 名称会使用当前随附模板，无需解析磁盘上的 manifest，因此损坏的 manifest 或自定义 bundle 无法阻止桌面恢复；自定义 profile 名称继续使用自身配置的 bundle 清单。该 flag 与临时 `--patch` overlay、配置导出互斥。

桌面启动由可恢复状态机管理。普通模式静默启动；达到 15 秒软阈值时，应用提供继续等待、安全模式和退出选项，Host supervisor 同时保留 90 秒硬性就绪期限。重试与模式切换会先关闭当前子进程，等待 shutdown 与 start 都完成结算，再创建下一个 Host。即时失败界面提供重试、安全模式、复制已清理诊断、打开配置目录和退出。应用主动 abort 会关闭当前提示框并排空活动尝试。安全模式就绪后会显示明确标记。启动 telemetry 以有界 JSONL 事件元数据写入 Electron 应用日志目录，不包含 Host 输出、环境变量值、路径或凭据。

macOS 和 Windows 使用同一个受跟踪的 `apps/desktop/build/icon.png` 输入，仓库不转换该文件。本地 `package:desktop` 生成未封装产物，不要求发布凭据。独立的 `dist:mac:desktop` 入口启用 hardened runtime，强制签名，并在创建 DMG 前要求一组完整的 Electron Builder 公证凭据。签名既可使用包含 `Developer ID Application` 证书及私钥的持久 Keychain 身份，也可使用由 Electron Builder 导入临时 Keychain 的 Base64 PKCS#12 凭据。发布 wrapper 不会把签名与公证变量传给仓库构建和运行时暂存，只会将其传给 Electron Builder。预检查会在仓库构建前拒绝非 macOS 宿主、已禁用的身份发现、非 Developer ID 身份，以及缺失或不完整的凭据。公证凭据可来自 `notarytool` Keychain profile、完整的 Apple ID 凭据组或 App Store Connect API 密钥凭据组。

该子进程仍然独家拥有 Web profile 的 Cordis 树、会话、设置、凭据、文件系统和 shell 服务、HTTP/WebSocket 载体，以及等待完全停稳的 dispose。Electron 不会把这些服务导入 main 进程或渲染器进程。BrowserWindow 加载经过校验的 loopback URL，禁用 Node 集成，启用上下文隔离和渲染器沙箱，并且不提供 preload 能力。这仍然是既有的本地 Web 安全模型：桌面壳不会增加身份验证层或 IPC 授权层。

托盘和 Host supervisor 拥有独立于 BrowserWindow 可见性的应用生命周期。用户关闭窗口时，应用拦截该操作并隐藏窗口，既不退出 Electron，也不向子进程发送信号。激活托盘或在 macOS 上激活应用时，应用重新显示现有窗口。`window-all-closed` 不是退出请求。单实例锁阻止第二个桌面进程和第二个 Host 子进程启动；再次启动只会恢复主实例窗口并将其聚焦。

所有显式退出路径汇入同一个幂等退出操作。该操作停止接受窗口恢复请求，向子进程发送 `SIGTERM`，并等待子进程退出。普通 `dsh` 启动器收到该信号后 dispose 根 Cordis fiber，其拥有的持久化和子进程服务在进程退出前完成排空。超出有界时限时，supervisor 只会一次性升级为向无响应子进程发送 `SIGKILL`，并且仍会等到子进程结算后才退出 Electron。重复退出请求会加入同一项操作，不会启动另一套信号或定时器序列。

子进程在就绪后意外退出时，supervisor 会报告其精确退出码与信号，再进入同一项应用退出操作。桌面壳不会留下连接到失效 Host 的活动窗口，也不会在缺少显式恢复策略时重启执行环境。

supervisor 向 Electron 应用提供启动、就绪和关闭事实，不会把子进程机制暴露给窗口与托盘处理器。后续实现可在该所有权位置后面，用本地自定义协议和 IPC 载体替换 loopback 子进程。这项迁移会替换产物加载和传输方式，但保留托盘／窗口生命周期规则及既有 ApiProxy 消息模型；第一阶段不为子进程安排提供兼容性承诺。

### 桌面窗口外观

BrowserWindow 的窗口外观按平台区分。macOS 使用无边框内嵌式隐藏标题栏、侧栏 vibrancy 和显式交通灯位置；其收起侧栏解析为 90px 轨道，其中的 36px 控件水平居中，最上方控件在交通灯下方与展开态 logo 行对齐。Windows 保留标准粗边框和阴影以支持缩放、Snap 与 Windows 11 圆角，再通过隐藏标题栏让内容延伸到原生窗口按钮和 acrylic 材质之下。Linux 保持无边框，并保留 Web 客户端的不透明表面，因为 Electron 在该平台没有对应的原生材质。窗口会保持隐藏，直到渲染器带着桌面呈现标记加载完成。

Electron 会在经过校验的 Host URL 上附加一个白名单内的平台值。Web 入口在挂载客户端树之前消费该值，把根元素标记为桌面文档，并记录当前平台。这项静态标记不会授予 preload 或 IPC 能力。客户端样式只把它用于原生呈现和标题栏命中区。常驻的会话根始终挂载中心列拖拽带，包括没有可见 Session header 的状态。macOS 的可见标题栏可以拖动；Windows 则把 44px 首行与原生窗口按钮组合，预留按钮所占的右侧区域，并只让该行的非交互区域可拖动。按钮、链接、表单字段、ARIA 控件、标签页和可编辑后代都是显式 no-drag 区域，因此移动窗口不会吞掉这些控件的交互。只要挂载了任意 `aria-modal="true"` 对话框，document 就会把包括底层标题栏与模态遮罩在内的所有渲染器拖拽目标改为 `no-drag`；最后一个模态框卸载后再恢复平台规则。macOS 与 Linux 持有独立的侧栏拖拽条；Windows 不预留交通灯区域，也不显示侧栏拖拽条。

只有 macOS 和 Windows 的侧栏会透出原生材质：页面和 AppFrame 背景变为透明，侧栏绘制由主题颜色派生的半透明 tint，而对话与详情列重新绘制普通的不透明应用背景。这些原生玻璃侧栏会隐藏 Session 列表不透明的底部溢出渐变，避免 tint 在列表边缘变暗。通过浏览器访问的客户端没有桌面标记，会保留既有布局与颜色。因此，平台窗口外观仍然是载体专属的呈现选择，而不是新的客户端 capability 或协议字段。

## 验证

`apps/desktop/tests/host-supervisor.spec.ts` 固定就绪解析在任意 stdout 分片和末行无换行时的行为，拒绝无效 scheme、host、port 和缺失的就绪信息，保留运行期输出 observer，隔离 observer 异常，并覆盖单个在途启动、启动失败、提前退出、幂等关闭、协作式 `SIGTERM` 结算，以及只执行一次的超时升级。`apps/desktop/tests/shell-environment.spec.ts` 固定平台策略、值合并、私有 shell framing、输出上限、超时终止、回退与清理。`apps/desktop/tests/startup-controller.spec.ts` 固定快速启动、慢启动等待、提示框取消、重试、安全模式切换、提示框失败清理与应用 abort 下的停稳子进程替换。`apps/desktop/tests/startup-diagnostics.spec.ts` 固定凭据清理与诊断长度边界。CLI 参数套件和构建入口 E2E 固定安全模式语法、互斥约束、随附 bundle 启动与 patch 文件保持不变。`apps/desktop/tests/window-lifecycle.spec.ts` 固定关闭窗口即隐藏、窗口创建合流、退出期间拒绝恢复窗口，以及 Electron 重试退出前只 dispose 一次 Host。客户端测试固定白名单内的挂载前桌面标记、macOS 90px 收起几何、Web／Windows／Linux 56px 几何、保持不变的 60px logo 行、平台专属侧栏偏移和拖拽条、不透明工作列、Windows 窗口按钮行留位、常驻中心拖拽区、标题栏交互排除、模态框存续期间暂停拖拽、原生玻璃渐变抑制、键盘焦点可见性和浏览器回退。源代码检查与评审固定 Electron 事件接线、单实例恢复、精确 origin 导航策略、加固后的 BrowserWindow 设置、Windows 标准边框和平台材质选择。打包测试固定共用源图标、完整构建与运行时暂存命令、打包后的 Host 路径、Electron Node 模式环境、封闭暂存声明、Windows ACL runner 的静态相对导入闭包、加固的 macOS 配置、快速失败的发布预检查，以及在签名前拒绝缺失 Host 入口的产物。2026-08-14，arm64 发布路径生成了经过 Developer ID 签名、启用 hardened runtime、完成公证并装订票据的 DMG；挂载后的应用通过严格代码签名验证与 Gatekeeper 评估，其内置 Host 在干净退出前成功报告回环就绪并提供 HTTP 200 响应。

## 考虑过的替代方案

**交付任何桌面应用前先构建 IPC 载体。** 这是目标传输方向，但它会在首个版本中同时引入进程安全、客户端模块打包、双向流式传输、取消、原生操作和生命周期工作。supervisor 保留了这条迁移路径，无需把全部工作作为托盘壳的交付前提。

**在 Electron main 进程内启动 Harness 插件树。** 这种方案可以移除一个子进程和 loopback socket，却会把模型、持久化和子进程故障耦合到必须保持托盘与退出控件可响应的进程中。它还会创建第二套应用组合，而不是运行已交付的 Web profile。

**每次关闭窗口时都终止子进程。** 这种方案会让 BrowserWindow 可见性拥有 agent 生命周期、丢弃后台工作，并且违背托盘常驻应用的要求。只有显式退出应用才拥有 Host dispose。

**关闭时销毁 BrowserWindow，重新打开时再创建。** 会话回放可以重建持久对话状态，但临时客户端状态和已经打开的控件会丢失。首个壳选择隐藏窗口，以保留当前客户端 generation；这项选择明确接受渲染器的内存成本。

**使用固定 loopback 端口，或根据进程参数推断地址。** 固定端口会造成可以避免的冲突，推断出的 URL 还可能与尚未完成 Loader 激活的服务器产生竞态。端口 0 加既有的结算后就绪行，让子进程报告自己实际拥有的地址。

**显式退出时立即杀死子进程。** 立即终止可以缩短关闭时间，却会跳过会话刷盘和受管进程树清理。`SIGTERM` 把 dispose 交给子进程处理；强制终止只保留为有界失败路径。

**保留原生标题栏和不透明侧栏。** 这种方案无需载体专属样式，但会让桌面应用保留类似浏览器的窗口外观，也无法使用原生窗口已经拥有的平台材质。桌面标记把所需的布局调整限制在 Electron 中。

**让整个工作区都半透明。** 如果让原生材质延伸到对话和详情内容背后，文字对比度会降低，主题表面也会依赖窗口下方的桌面内容。只有导航侧栏透出材质，工作内容保持不透明。

## 后果

桌面应用可以用很小的 Host 或客户端风险交付既有交互产品，关闭窗口后 agent 运行时仍可从托盘继续使用。额外的进程还会把 Electron 应用控件与普通 Harness 故障隔离，并留下一个明确的后续传输替换位置。

第一阶段需要承担 loopback listener、额外 Node 进程、就绪行耦合和隐藏渲染器的资源成本。它继承 Web 载体的信任与暴露规则，而不会获得 Electron IPC 安全边界。自定义窗口外观还让客户端负责平台专属标题栏避让、可用的拖拽目标和 no-drag 交互区；Linux 保持无边框且没有原生玻璃材质，Windows 则依赖 Window Controls Overlay 几何。可分发包携带 CLI 生产依赖闭包和 Web 前端，Electron 的 Node 模式可以避免重复的 Node 二进制文件，代价是原生依赖兼容性与 Electron 交付的 ABI 耦合。运行时暂存还依赖 legacy `pnpm deploy` 行为，因此必须在 Builder 消费该目录树前补回遗漏的直接依赖并移除链接。正式 macOS 发布需要外部 Developer ID 身份、公证凭据和 Apple 公证服务；Windows 与 Linux 安装包格式及发布签名仍属于独立的发布工作。只有子进程报告 Loader 结算后的 URL，桌面启动才算成功。可恢复启动覆盖窗口打开前的慢速或失败启动尝试。Host 在就绪后崩溃时，桌面壳仍会退出；运行期自动重启属于后续生命周期决策。

子进程安排是一项实现选择，不是公开协议。后续采用 IPC 的桌面应用仍使用 ApiProxy 四象限约定，并保留关闭即隐藏、托盘所有权、单实例行为和有序 Host dispose，同时替换 loopback 服务器、就绪行和被监督的 CLI 进程。
